import assert from "node:assert/strict";
import { test } from "node:test";
import { search } from "../index.js";

const first = "a".repeat(32);
const second = "b".repeat(32);
const third = "c".repeat(32);

const song = (hash, album, name, mix = 1) => ({
  FileHash: hash.toUpperCase(), AlbumID: album, MixSongID: mix,
  SongName: name, SingerName: "Fixture artist", Duration: 240,
});
const allQualities = (status) => [2, 4, 5, 6].map((level) => ({ level, status }));
const rights = (hash, goods = allQualities(0), album = 1) => ({
  hash, album_id: album, relate_goods: goods,
});

async function runSearch(songs, entitlements, { signedIn = true, failure = false } = {}) {
  const storage = new Map([["dfid", "test-device"], ["mid", "123"]]);
  if (signedIn) storage.set("auth", { token: "fixture-only", userid: 1 });
  const requests = [];
  globalThis.host = {
    t: (text) => text,
    crypto: { md5: () => "0".repeat(32) },
    storage: { get: (key) => storage.get(key), set: (key, value) => storage.set(key, value) },
  };
  globalThis.fetch = async (url, options) => {
    const request = new URL(url);
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ path: request.pathname, body, router: options.headers["x-router"] });
    if (request.pathname === "/v2/search/song") {
      return new Response(JSON.stringify({ status: 1, data: { lists: songs, total: songs.length } }));
    }
    assert.equal(request.pathname, "/v2/get_res_privilege/lite");
    if (failure) throw new Error("Entitlement request failed");
    return new Response(JSON.stringify({ status: 1, data: entitlements }));
  };
  try {
    const result = await search({ query: "sample", kind: "tracks" });
    return { ...result, requests };
  } finally {
    delete globalThis.host;
    delete globalThis.fetch;
  }
}

test("matches reordered rights by hash and leaves an omitted song unknown", async () => {
  const songs = [song(first, 1, "Denied"), song(second, 1, "Omitted"), song(third, 1, "Fallback")];
  const response = [rights(third, [{ level: 2, status: 1 }, ...allQualities(0).slice(1)]), rights(first.toUpperCase())];
  const { tracks, requests } = await runSearch(songs, response);
  assert.deepEqual(tracks.map(({ name, unavailable }) => [name, unavailable]), [
    ["Denied", true], ["Omitted", undefined], ["Fallback", undefined],
  ]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].router, "media.store.kugou.com");
  assert.deepEqual(requests[1].body.resource, [first, second, third].map((hash) => ({
    type: "audio", page_id: 0, hash, album_id: 1,
  })));
});

test("deduplicates a song in one album and leaves conflicting albums and partial rights unknown", async () => {
  const songs = [song(first, 1, "Same track A", 1), song(first, 1, "Same track B", 2),
    song(second, 1, "Album A"), song(second, 2, "Album B"), song(third, 1, "Partial")];
  const response = [rights(first, allQualities("0")), rights(third, [{ level: 2, status: 0 }])];
  const { tracks, requests } = await runSearch(songs, response);
  assert.deepEqual(tracks.map((track) => track.unavailable), [true, true, undefined, undefined, undefined]);
  assert.deepEqual(requests[1].body.resource.map((item) => item.hash), [first, third]);
});

test("keeps search usable when the entitlement request fails or the account is signed out", async () => {
  const songs = [song(first, 1, "Search result")];
  const failed = await runSearch(songs, [], { failure: true });
  const guest = await runSearch(songs, [], { signedIn: false });
  assert.equal(failed.tracks[0].unavailable, undefined);
  assert.equal(guest.tracks[0].unavailable, undefined);
  assert.equal(failed.requests.length, 2);
  assert.equal(guest.requests.length, 1);
});
