import assert from "node:assert/strict";
import { test } from "node:test";
import { album, search } from "../index.js";

// The plugin keeps what it learned of each song's rights for a while, so each
// test uses songs of its own.
let next = 0;
const fresh = () => (++next).toString(16).padStart(32, "0");

const song = (hash, album, name, mix = 1) => ({
  FileHash: hash.toUpperCase(), AlbumID: album, MixSongID: mix,
  SongName: name, SingerName: "Fixture artist", Duration: 240,
});
// What Kugou's rights service says of a song this account can't play, and of
// a VIP song, which plays with the Concept Edition's VIP.
const DENIED = { privilege: 5, status: 0, _msg: "Deny: the current behavior in current region is forbidden." };
const VIP = { privilege: 10, status: 0, pay_type: 3 };
const FREE = { privilege: 8, status: 1, _msg: "Allow: the audio is free(copyright)." };
const goods = (privilege, status) => [2, 4, 5, 6].map((level) => ({ level, privilege, status }));
const rights = (hash, verdict, album = 1) => ({
  hash, album_id: album, ...verdict, relate_goods: goods(verdict.privilege, verdict.status),
});

function mock(routes, { signedIn = true, platform } = {}) {
  // The regular app keeps its own sign-in and device, under "std:".
  const own = platform === "standard" ? "std:" : "";
  const storage = new Map([[`${own}dfid`, "test-device"], ["mid", "123"]]);
  if (signedIn) storage.set(`${own}auth`, { token: "fixture-only", userid: 1 });
  const requests = [];
  globalThis.host = {
    t: (text) => text,
    setting: (key) => (key === "platform" ? platform : undefined),
    crypto: { md5: () => "0".repeat(32) },
    storage: { get: (key) => storage.get(key), set: (key, value) => storage.set(key, value), remove: (key) => storage.delete(key) },
  };
  globalThis.fetch = async (url, options) => {
    const request = new URL(url);
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ path: request.pathname, body, router: options.headers["x-router"] });
    const route = routes[request.pathname];
    assert.ok(route, `unexpected request ${request.pathname}`);
    const data = await route(body);
    return new Response(JSON.stringify({ status: 1, data }));
  };
  return requests;
}
function unmock() {
  delete globalThis.host;
  delete globalThis.fetch;
}

async function runSearch(songs, entitlements, { signedIn = true, failure = false } = {}) {
  const requests = mock({
    "/v2/search/song": () => ({ lists: songs, total: songs.length }),
    "/v2/get_res_privilege/lite": (body) => {
      if (failure) throw new Error("Entitlement request failed");
      return typeof entitlements === "function" ? entitlements(body) : entitlements;
    },
  }, { signedIn });
  try {
    const result = await search({ query: "sample", kind: "tracks" });
    return { ...result, requests };
  } finally {
    unmock();
  }
}

test("matches reordered rights by hash and leaves an omitted song unknown", async () => {
  const [first, second, third] = [fresh(), fresh(), fresh()];
  const songs = [song(first, 1, "Denied"), song(second, 1, "Omitted"), song(third, 1, "Free")];
  const response = [rights(third, FREE), rights(first.toUpperCase(), DENIED)];
  const { tracks, requests } = await runSearch(songs, response);
  assert.deepEqual(tracks.map(({ name, unavailable }) => [name, unavailable]), [
    ["Denied", true], ["Omitted", undefined], ["Free", undefined],
  ]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].router, "media.store.kugou.com");
  assert.deepEqual(requests[1].body.resource, [first, second, third].map((hash) => ({
    type: "audio", page_id: 0, hash, album_id: 1,
  })));
});

test("deduplicates a song in one album and leaves conflicting albums unknown", async () => {
  const [first, second, third] = [fresh(), fresh(), fresh()];
  const songs = [song(first, 1, "Same track A", 1), song(first, 1, "Same track B", 2),
    song(second, 1, "Album A"), song(second, 2, "Album B"), song(third, 1, "Denied as strings")];
  const response = [rights(first, DENIED), rights(third, { privilege: "5", status: "0" })];
  const { tracks, requests } = await runSearch(songs, response);
  assert.deepEqual(tracks.map((track) => track.unavailable), [true, true, undefined, undefined, true]);
  assert.deepEqual(requests[1].body.resource.map((item) => item.hash), [first, third]);
});

test("keeps search usable when the entitlement request fails or the account is signed out", async () => {
  const songs = [song(fresh(), 1, "Search result")];
  const failed = await runSearch(songs, [], { failure: true });
  const guest = await runSearch(songs, [], { signedIn: false });
  assert.equal(failed.tracks[0].unavailable, undefined);
  assert.equal(guest.tracks[0].unavailable, undefined);
  assert.equal(failed.requests.length, 2);
  assert.equal(guest.requests.length, 1);
});

test("leaves VIP songs playable: the Concept Edition's VIP plays them", async () => {
  const [vip, free] = [fresh(), fresh()];
  const { tracks } = await runSearch([song(vip, 1, "VIP"), song(free, 1, "Free")], [rights(vip, VIP), rights(free, FREE)]);
  assert.deepEqual(tracks.map((track) => track.unavailable), [undefined, undefined]);
});

test("asks 200 songs a request and remembers the answers", async () => {
  const hashes = Array.from({ length: 250 }, fresh);
  const songs = hashes.map((hash, i) => song(hash, 1, `Song ${i}`));
  const answer = (body) => body.resource.map(({ hash }, i) => rights(hash, i % 2 ? DENIED : VIP));
  const first = await runSearch(songs, answer);
  const rights1 = first.requests.filter((r) => r.path === "/v2/get_res_privilege/lite");
  assert.deepEqual(rights1.map((r) => r.body.resource.length), [200, 50]);
  assert.equal(first.tracks.filter((track) => track.unavailable).length, 125);
  const again = await runSearch(songs, answer);
  assert.equal(again.requests.filter((r) => r.path === "/v2/get_res_privilege/lite").length, 0);
  assert.equal(again.tracks.filter((track) => track.unavailable).length, 125);
});

test("greys out songs on pages other than search, such as an album", async () => {
  const [denied, vip] = [fresh(), fresh()];
  const songs = [
    { hash: denied.toUpperCase(), album_audio_id: 11, album_id: 7, audio_name: "Gone", author_name: "Fixture artist", timelength: 200000 },
    { hash: vip.toUpperCase(), album_audio_id: 12, album_id: 7, audio_name: "Here", author_name: "Fixture artist", timelength: 200000 },
  ];
  const requests = mock({
    "/kmr/v2/albums": () => [{ album_id: "7", album_name: "Fixture album" }],
    "/v1/album_audio/lite": () => ({ songs, total: 2 }),
    "/v2/get_res_privilege/lite": () => [rights(denied, DENIED, 7), rights(vip, VIP, 7)],
  });
  try {
    const page = await album({ id: "7" });
    assert.deepEqual(page.tracks.map(({ name, unavailable }) => [name, unavailable]), [["Gone", true], ["Here", undefined]]);
    assert.equal(requests.filter((r) => r.path === "/v2/get_res_privilege/lite").length, 1);
  } finally {
    unmock();
  }
});

test("on the regular Kugou app without VIP, greys out VIP songs that need the music pack", async () => {
  const [pack, open, free] = [fresh(), fresh(), fresh()];
  const songs = [song(pack, 1, "Needs VIP"), song(open, 1, "VIP but plays"), song(free, 1, "Free")];
  const requests = mock({
    "/v2/search/song": () => ({ lists: songs, total: songs.length }),
    "/v1/get_union_vip": () => ({ is_vip: 0, busi_vip: [{ busi_type: "concept", is_vip: 1 }] }),
    "/v2/get_res_privilege/lite": () => [
      rights(pack, { ...VIP, trans_param: { musicpack_advance: 1 } }),
      rights(open, { ...VIP, trans_param: { musicpack_advance: 0 } }),
      rights(free, FREE),
    ],
  }, { platform: "standard" });
  try {
    const { tracks } = await search({ query: "sample", kind: "tracks" });
    assert.deepEqual(tracks.map((track) => track.unavailable), [true, undefined, undefined]);
    assert.equal(requests.find((r) => r.path === "/v2/search/song") !== undefined, true);
  } finally {
    unmock();
  }
});
