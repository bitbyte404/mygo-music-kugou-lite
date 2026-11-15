// 酷狗概念版（Kugou Concept / Lite）plugin for MyGo Music.
// Talks to Kugou's own gateway directly with the Concept Edition's app id,
// version and signing salts, as MakcRe/KuGouMusicApi (MIT) documents them.
// No server, no helper program.

const GATEWAY = "https://gateway.kugou.com";
const APP_ID = 3116;
const CLIENT_VER = 11440;
const SRC_APP_ID = 2919;
const SALT = "LnT6xpN3khm36zse0QzvmgTZ3waWdRSA";
const KEY_SALT = "185672dd44712f60bb1736df5a377e82";
const WEB_SALT = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
const UA = "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi";
const PAGE = 30;

const t = (s) => host.t(s);
const md5 = (s) => host.crypto.md5(String(s));
const store = {
  get: (k, d) => host.storage.get(k) ?? d,
  set: (k, v) => host.storage.set(k, v),
  del: (k) => host.storage.remove(k),
};

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

// ---------- device & auth ----------

// The device: a guid, and the Concept app's mid for it, the md5 of the guid
// read as one big decimal number.
function deviceGuid() {
  let v = store.get("guid");
  if (!v) {
    v = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    store.set("guid", v);
  }
  return v;
}
function mid() {
  let v = store.get("mid");
  if (!v) {
    v = BigInt("0x" + md5(deviceGuid())).toString();
    store.set("mid", v);
  }
  return v;
}
// The dfid Kugou gave this device when it registered, or "-" until then.
function dfid() {
  return store.get("dfid", "-");
}
let registering = null;
async function ensureDevice() {
  if (store.get("dfid")) return;
  registering ||= (async () => {
    for (let i = 0; ; i++) {
      try {
        return await registerDevice();
      } catch (e) {
        if (i >= 2) throw e;
        await new Promise((r) => setTimeout(r, 600));
      }
    }
  })()
    .then((d) => store.set("dfid", d))
    .catch((e) => console.log(`registering the device failed: ${e.message}`))
    .finally(() => (registering = null));
  await registering;
}
const auth = () => store.get("auth", {});
const signedIn = () => !!(auth().token && auth().userid);
function needSignIn() {
  if (!signedIn()) throw fail("signIn", t("Sign in to Kugou first"));
  return auth();
}

// ---------- signing & requests ----------

const str = (v) => (typeof v === "object" ? JSON.stringify(v) : String(v));
function androidSign(params, body) {
  const canon = Object.keys(params).sort().map((k) => `${k}=${str(params[k])}`).join("");
  return md5(`${SALT}${canon}${body || ""}${SALT}`);
}
function webSign(params) {
  const canon = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("");
  return md5(`${WEB_SALT}${canon}${WEB_SALT}`);
}
const now = () => Math.floor(Date.now() / 1000);

// One request to Kugou. opts: { base, method, params, body, router, headers,
// form, bare (no default params), sign: "android" | "web" | false, raw }
async function kg(path, opts = {}) {
  if (!opts.noDevice) await ensureDevice();
  const a = auth();
  const clienttime = now();
  const defaults = { dfid: dfid(), mid: mid(), uuid: "-", appid: APP_ID, clientver: CLIENT_VER, clienttime };
  if (a.token) defaults.token = a.token;
  if (a.userid) defaults.userid = a.userid;
  const params = opts.bare ? { ...(opts.params || {}) } : { ...defaults, ...(opts.params || {}) };
  let body;
  if (opts.body !== undefined) body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  if (opts.sign !== false && !params.signature) {
    params.signature = opts.sign === "web" ? webSign(params) : androidSign(params, body);
  }
  const qs = Object.keys(params).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(str(params[k]))}`).join("&");
  const headers = {
    "User-Agent": UA,
    dfid: String(params.dfid || defaults.dfid),
    mid: String(params.mid || defaults.mid),
    clienttime: String(params.clienttime || clienttime),
    "kg-rc": "1", "kg-thash": "5d816a0", "kg-rec": "1", "kg-rf": "B9EDA08A64250DEFFBCADDEE00F8F25F",
    ...(opts.router ? { "x-router": opts.router } : {}),
    ...(body !== undefined ? { "Content-Type": opts.form ? "application/x-www-form-urlencoded" : "application/json" } : {}),
    ...(opts.headers || {}),
  };
  const res = await fetch(`${opts.base || GATEWAY}${path}${qs ? "?" + qs : ""}`, {
    method: opts.method || (body !== undefined ? "POST" : "GET"),
    headers,
    body,
  });
  const text = await res.text();
  if (opts.raw) return text;
  if (!res.ok) throw new Error(`${t("Kugou request failed")} (HTTP ${res.status} ${path})`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${t("Kugou sent something unreadable")} (${path})`);
  }
  const code = Number(json.error_code || json.errcode || json.err_code || 0);
  if (json.status === 0 || (code && code !== 200)) {
    if ([20018, 20017, 34175].includes(code) || /token/i.test(String(json.error || json.msg || ""))) {
      if (signedIn()) throw fail("signIn", t("Your Kugou sign-in has expired, sign in again"));
    }
    if (code === 20028 && !opts.retried) {
      // 本次请求需要验证: register the device again and ask once more.
      store.del("dfid");
      await ensureDevice();
      const again = { ...(opts.params || {}) };
      if ("dfid" in again) again.dfid = dfid();
      delete again.signature;
      return kg(path, { ...opts, params: again, retried: true });
    }
    const msg = json.error || json.error_msg || json.errmsg || json.msg || json.message || `code ${code}`;
    const e = new Error(`${msg} (${path})`);
    e.kgCode = code;
    throw e;
  }
  return opts.whole ? json : json.data ?? json;
}

const list = (...xs) => {
  for (const x of xs) if (Array.isArray(x)) return x;
  return [];
};
// Kugou's image servers make a picture any size asked, by a number in its
// path (/stdmusic/240/, /custom/150/, /softhead/100/, ...) or {size} there.
// The app fills in {size} with the pixels it shows the picture at (0.1.20
// and on), so every such path gets {size}; anything else stays as it came.
const SIZED = /^(https?:\/\/(?:[\w-]+\.)*(?:kugou\.com|kgimg\.com)\/(?:stdmusic|mcommon|kugouicon|custom|uploadpic\/softhead)\/)(?:\d+|\{size\})\//;
const img = (u) => {
  if (!u) return undefined;
  const s = String(u).replace(/^http:/, "https:");
  return SIZED.test(s) ? s.replace(SIZED, "$1{size}/") : s;
};

// ---------- AES-128-CBC and RSA, for registering the device ----------
// Kugou only plays to a device it has registered, and registering is
// encrypted: the body with AES-128-CBC, its key with the Concept app's RSA key.

const SBOX = new Uint8Array(256);
const INV = new Uint8Array(256);
(() => {
  let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1 | q >> 7) & 0xff) ^ ((q << 2 | q >> 6) & 0xff) ^ ((q << 3 | q >> 5) & 0xff) ^ ((q << 4 | q >> 4) & 0xff) ^ 0x63;
    SBOX[p] = x; INV[x] = p;
  } while (p !== 1);
  SBOX[0] = 0x63; INV[0x63] = 0;
})();
const xt = (a) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
const mul = (a, b) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xt(a); b >>= 1; } return r; };

// AES key schedule for a 16- or 32-byte key (AES-128 or AES-256): the
// follow service encrypts with a 32-character key, the rest with 16.
function expandKey(key) {
  const nk = key.length / 4, rounds = nk + 6;
  const w = new Uint8Array(16 * (rounds + 1));
  w.set(key);
  let rcon = 1;
  for (let i = key.length; i < w.length; i += 4) {
    let t = w.slice(i - 4, i);
    if (i % key.length === 0) {
      t = new Uint8Array([SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]);
      rcon = xt(rcon);
    } else if (nk > 6 && i % key.length === 16) {
      t = t.map((b) => SBOX[b]);
    }
    for (let j = 0; j < 4; j++) w[i + j] = w[i - key.length + j] ^ t[j];
  }
  return w;
}

function encBlock(s, w) {
  const n = w.length / 16 - 1;
  for (let i = 0; i < 16; i++) s[i] ^= w[i];
  for (let r = 1; r <= n; r++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    const t = s.slice();
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) s[c * 4 + row] = t[((c + row) % 4) * 4 + row];
    if (r < n) for (let c = 0; c < 4; c++) {
      const [a0, a1, a2, a3] = s.slice(c * 4, c * 4 + 4);
      s[c * 4] = xt(a0) ^ xt(a1) ^ a1 ^ a2 ^ a3;
      s[c * 4 + 1] = a0 ^ xt(a1) ^ xt(a2) ^ a2 ^ a3;
      s[c * 4 + 2] = a0 ^ a1 ^ xt(a2) ^ xt(a3) ^ a3;
      s[c * 4 + 3] = xt(a0) ^ a0 ^ a1 ^ a2 ^ xt(a3);
    }
    for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i];
  }
}

function decBlock(s, w) {
  const n = w.length / 16 - 1;
  for (let i = 0; i < 16; i++) s[i] ^= w[n * 16 + i];
  for (let r = n - 1; r >= 0; r--) {
    const t = s.slice();
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) s[((c + row) % 4) * 4 + row] = t[c * 4 + row];
    for (let i = 0; i < 16; i++) s[i] = INV[s[i]];
    for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i];
    if (r > 0) for (let c = 0; c < 4; c++) {
      const [a0, a1, a2, a3] = s.slice(c * 4, c * 4 + 4);
      s[c * 4] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
      s[c * 4 + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
      s[c * 4 + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
      s[c * 4 + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
    }
  }
}

const utf8 = (s) => new TextEncoder().encode(s);
function cbcEncrypt(data, key, iv) {
  const w = expandKey(key);
  const pad = 16 - (data.length % 16);
  const buf = new Uint8Array(data.length + pad);
  buf.set(data);
  buf.fill(pad, data.length);
  let prev = iv;
  for (let i = 0; i < buf.length; i += 16) {
    const s = buf.subarray(i, i + 16);
    for (let j = 0; j < 16; j++) s[j] ^= prev[j];
    encBlock(s, w);
    prev = s;
  }
  return buf;
}
function cbcDecrypt(data, key, iv) {
  const w = expandKey(key);
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let i = 0; i < data.length; i += 16) {
    const s = data.slice(i, i + 16);
    decBlock(s, w);
    for (let j = 0; j < 16; j++) out[i + j] = s[j] ^ prev[j];
    prev = data.subarray(i, i + 16);
  }
  return out.subarray(0, out.length - (out[out.length - 1] || 0));
}
const b64 = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };

// The Concept app's RSA public key, as its modulus and exponent.
const RSA_N = BigInt("0xc40a2d0da76511f3bb1cc2bbd3afbd8bea83b4d6b05b6c13eb8920c53f1af7679b32ba0d0edb843240ef1b836efed3ee240734c14c1399fd6594d16af22f52525d14d72e0155c6dcc8638d4f7bb94f3a0b1f4c29f991972f2a160a25eb0a9e724336be7f69bbd319ffab1c6dd8470b021dc434f3faba89f4a2a01b33bdbdd08b");
function modpow(b, e, m) {
  let r = 1n;
  b %= m;
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}
// RSAES-PKCS1-v1_5, in hex.
function rsaPkcs1(text) {
  const m = utf8(text);
  const k = 128;
  const block = new Uint8Array(k);
  block[1] = 2;
  for (let i = 2; i < k - m.length - 1; i++) block[i] = 1 + Math.floor(Math.random() * 255);
  block.set(m, k - m.length);
  let x = 0n;
  for (const b of block) x = (x << 8n) | BigInt(b);
  return modpow(x, 65537n, RSA_N).toString(16).padStart(256, "0");
}

// The same key without padding, as the follow list wants it: the text
// left-aligned in the block and zeros after it.
function rsaRaw(text) {
  const m = utf8(text);
  let x = 0n;
  for (let i = 0; i < 128; i++) x = (x << 8n) | BigInt(m[i] || 0);
  return modpow(x, 65537n, RSA_N).toString(16).padStart(256, "0");
}

// The follow service's encryption: JSON AES-256-CBC with md5 of a random
// 16-letter key (iv its last 16 characters), in hex, and that key sent RSA
// encrypted with the time.
function followCrypt(data, clienttime) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const temp = Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * 36)]).join("");
  const k = md5(temp);
  const str = hexOf(cbcEncrypt(utf8(JSON.stringify(data)), utf8(k), utf8(k.slice(16))));
  return { str, p: rsaPkcs1(JSON.stringify({ clienttime, key: temp })) };
}

// Registers this device with Kugou, for the dfid it then plays to.
async function registerDevice() {
  const a = auth();
  const guid = deviceGuid();
  const info = {
    availableRamSize: 4983533568, availableRomSize: 48114719, availableSDSize: 48114717, basebandVer: "", batteryLevel: 100, batteryStatus: 3,
    brand: "Redmi", buildSerial: "unknown", device: "marble", imei: guid, imsi: "", manufacturer: "Xiaomi", uuid: guid,
    accelerometer: false, accelerometerValue: "", gravity: false, gravityValue: "", gyroscope: false, gyroscopeValue: "", light: false, lightValue: "",
    magnetic: false, magneticValue: "", orientation: false, orientationValue: "", pressure: false, pressureValue: "",
    step_counter: false, step_counterValue: "", temperature: false, temperatureValue: "",
  };
  const k6 = Array.from({ length: 6 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
  const h = md5(k6);
  const key = utf8(h.slice(0, 16)), iv = utf8(h.slice(16, 32));
  const body = b64(cbcEncrypt(utf8(JSON.stringify(info)), key, iv));
  const p = rsaPkcs1(JSON.stringify({ aes: k6, uid: Number(a.userid || 0), token: a.token || "" }));
  const params = { dfid: "-", mid: mid(), uuid: "-", appid: APP_ID, clientver: CLIENT_VER, clienttime: now(), part: 1, platid: 1, p };
  if (a.token) params.token = a.token;
  if (a.userid) params.userid = a.userid;
  params.signature = androidSign(params, body);
  const qs = Object.keys(params).map((k) => `${k}=${encodeURIComponent(params[k])}`).join("&");
  const res = await fetch(`https://userservice.kugou.com/risk/v3/r_register_dev?${qs}`, {
    method: "POST",
    headers: { "User-Agent": UA, dfid: "-", mid: params.mid, clienttime: String(params.clienttime), "Content-Type": "application/json" },
    body,
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const out = JSON.parse(new TextDecoder().decode(cbcDecrypt(bytes, key, iv)));
  if (Number(out.status) !== 1 || !out.data?.dfid) throw new Error(`register_dev: ${JSON.stringify(out).slice(0, 120)}`);
  return String(out.data.dfid);
}

// ---------- shapes ----------

// A track's id carries what Kugou needs to play, like and comment on it:
// hash, mixsongid (album_audio_id) and album id, joined by "_".
const trackId = (hash, mix, album) => [String(hash || "").toUpperCase(), mix || 0, album || 0].join("_");
function parseId(id) {
  const [hash, mix, album] = String(id).split("_");
  return { hash: hash || "", mix: Number(mix) || 0, album: Number(album) || 0 };
}

function artistsOf(r) {
  const v = r.singerinfo || r.authors || r.Singers || r.singers;
  if (Array.isArray(v) && v.length) {
    return v
      .map((a) => ({
        id: String(a.id ?? a.author_id ?? a.singerid ?? a.singer_id ?? ""),
        name: String(a.name ?? a.author_name ?? a.singername ?? a.singer_name ?? ""),
        imageUrl: img(a.avatar || a.sizable_avatar || a.imgurl),
      }))
      .filter((a) => a.name);
  }
  const names = String(r.SingerName || r.singername || r.author_name || r.singer_name || r.singer || "").trim();
  if (!names) return [];
  const ids = Array.isArray(r.SingerId) ? r.SingerId : String(r.singerid || r.author_id || "").split(/[,、]/);
  return names.split(/[、&,，]/).map((n, i) => ({ id: String(ids[i] || "name:" + n.trim()), name: n.trim() })).filter((a) => a.name);
}

// What Kugou calls each song we've shown, "歌手 - 歌名", which adding a song
// to a playlist has to give.
const NAMES = new Map();

function toTrack(raw) {
  if (!raw) return null;
  const r = { ...raw, ...(raw.base || {}), ...(raw.audio_info || {}) };
  const ai = raw.album_info || raw.albuminfo || {};
  const hash = r.hash || r.FileHash || r.HASH || r.audio_hash || r.hash_128 || r.Hash || "";
  if (!hash) return null;
  const mix = r.mixsongid || r.MixSongID || r.album_audio_id || r.audio_id || r.Audioid || r.add_mixsongid || 0;
  const albumId = r.album_id || r.AlbumID || r.albumid || ai.album_id || 0;
  let name = String(r.songname || r.SongName || r.audio_name || r.song_name || r.OriSongName || r.name || r.filename || r.FileName || "");
  const artists = artistsOf(raw).length ? artistsOf(raw) : artistsOf(r);
  // "歌手 - 歌名" → "歌名"
  const dash = name.indexOf(" - ");
  if (dash > 0 && (!r.songname || name === r.filename || name === r.FileName)) name = name.slice(dash + 3);
  name = name.replace(/\.(mp3|flac|ogg|m4a|wav|ape)$/i, "");
  let dur = Number(r.duration || r.Duration || r.timelength || r.timelen || r.time_length || r.timeLength || 0);
  if (dur && dur < 10000) dur *= 1000;
  if (!dur && r.size && r.bitrate) dur = Math.round((Number(r.size) * 8) / Number(r.bitrate));
  const cover = img(
    r.sizable_cover || r.album_sizable_cover || r.Image || r.album_img || r.cover || r.imgurl || r.image ||
      ai.sizable_cover || ai.cover || raw.trans_param?.union_cover,
  );
  const full = `${artists.map((a) => a.name).join("、")}${artists.length ? " - " : ""}${name}`;
  NAMES.set(String(hash).toUpperCase(), full);
  if (NAMES.size > 5000) NAMES.delete(NAMES.keys().next().value);
  return {
    id: trackId(hash, mix, albumId),
    name: name || t("Unknown"),
    artists,
    album: { id: String(albumId || ""), name: String(r.album_name || r.AlbumName || r.albumname || ai.album_name || ai.name || ""), imageUrl: cover },
    duration: dur,

  };
}
const tracksOf = (xs) => xs.map(toTrack).filter(Boolean);

function toArtist(r = {}) {
  return {
    id: String(r.author_id ?? r.AuthorId ?? r.singerid ?? r.singer_id ?? r.SingerId ?? r.id ?? ""),
    name: String(r.author_name ?? r.AuthorName ?? r.singername ?? r.SingerName ?? r.singer_name ?? r.name ?? ""),
    imageUrl: img(r.sizable_avatar || r.Avatar || r.avatar || r.imgurl || r.singer_img || r.Image || r.pic),
  };
}

function toAlbum(r = {}) {
  const authors = r.authors || r.singers;
  return {
    id: String(r.album_id ?? r.AlbumID ?? r.albumid ?? r.id ?? ""),
    name: String(r.album_name ?? r.AlbumName ?? r.albumname ?? r.name ?? ""),
    imageUrl: img(r.sizable_cover || r.Image || r.img || r.imgurl || r.cover || r.album_img),
    artists: Array.isArray(authors) ? authors.map(toArtist).filter((a) => a.name) : artistsOf(r),
    released: String(r.publish_date || r.PublishDate || r.publish_time || r.publishtime || "").slice(0, 10) || undefined,
  };
}

function toPlaylist(r = {}) {
  return {
    id: String(r.global_collection_id || r.gid || r.specialid || r.id || ""),
    name: String(r.specialname || r.name || r.title || ""),
    imageUrl: img(r.flexible_cover || r.imgurl || r.pic || r.cover || r.img),
    description: String(r.intro || r.description || "") || undefined,
    owner: String(r.nickname || r.username || r.list_create_username || "") || undefined,
    trackCount: Number(r.songcount || r.count || r.song_count || r.total || 0) || undefined,
  };
}

// ---------- caches ----------

function remember(key, map) {
  const all = store.get(key, {});
  Object.assign(all, map);
  const keys = Object.keys(all);
  if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete all[k];
  store.set(key, all);
}

// ---------- sign in ----------

async function loginApi(path, params) {
  const p = { dfid: "-", mid: mid(), uuid: "-", appid: APP_ID, clientver: CLIENT_VER, clienttime: now(), ...params };
  return kg(path, { base: "https://login-user.kugou.com", bare: true, params: p, sign: "web" });
}

export async function signIn() {
  const key = await loginApi("/v2/qrcode", {
    appid: 1001, type: 1, plat: 4, srcappid: SRC_APP_ID,
    qrcode_txt: `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=${APP_ID}&`,
  });
  const code = key.qrcode || key.key;
  if (!code) throw new Error(t("Kugou didn't give a QR code, try again"));
  const qr = `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${code}`;
  host.signInPrompt({ qr, text: t("Scan with the Kugou or Kugou Concept app") });
  const until = Date.now() + 4 * 60 * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000));
    let d;
    try {
      d = await loginApi("/v2/get_userinfo_qrcode", { plat: 4, appid: APP_ID, srcappid: SRC_APP_ID, qrcode: code, dev: mid() });
    } catch {
      continue;
    }
    const s = Number(d.status);
    if (s === 0) throw new Error(t("The QR code expired, sign in again"));
    if (s === 2) host.signInPrompt({ qr, text: t("Scanned. Confirm on your phone") });
    if (s === 4 && d.token) {
      store.set("auth", { token: String(d.token), userid: String(d.userid) });
      const me = { id: String(d.userid), name: String(d.nickname || d.userid), imageUrl: img(d.pic) };
      store.set("account", me);
      store.del("likedIndex");
      try {
        await claimVip(true);
      } catch {}
      return { ...me, page: "me" };
    }
  }
  throw new Error(t("Sign-in timed out"));
}

export function signOut() {
  for (const k of ["auth", "account", "likedIndex", "myLists", "vipDay", "vipNote"]) store.del(k);
}

export function account() {
  const a = store.get("account", null);
  return a && signedIn() ? { ...a, page: "me" } : null;
}

// ---------- 概念版 daily VIP ----------

function today() {
  // Kugou's day is China's.
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

async function vipInfo() {
  const d = await kg("/v1/get_union_vip", { base: "https://kugouvip.kugou.com", params: { busi_type: "concept" } });
  const busi = list(d.busi_vip, d.data?.busi_vip).filter((b) => Number(b.is_vip) === 1);
  const ends = busi.map((b) => String(b.vip_end_time || b.end_time || "")).filter(Boolean).sort();
  return { vip: busi.length > 0 || Number(d.is_vip) === 1, end: ends[ends.length - 1] || "" };
}

// Claims the Concept Edition's free listening VIP for today, once a day.
// force claims again even if this device already did today.
async function claimVip(force) {
  if (!signedIn() || host.setting("autoVip") === "0") return null;
  if (!force && store.get("vipDay") === today()) return store.get("vipNote", null);
  let note;
  try {
    await kg("/youth/v1/recharge/receive_vip_listen_song", {
      method: "POST", body: "", form: true, params: { source_id: 90139, receive_day: today() },
    });
    note = t("Today's free VIP claimed");
  } catch (e) {
    const msg = String(e.message || e);
    note = /131001/.test(msg) ? t("Today's free VIP already claimed") : msg.replace(/\s*\(\/youth.*\)$/, "");
  }
  try {
    await kg("/youth/v1/listen_song/upgrade_vip_reward", {
      method: "POST", body: "", params: { kugouid: Number(auth().userid), ad_type: 1 },
    });
  } catch {}
  store.set("vipDay", today());
  store.set("vipNote", note);
  return note;
}

// ---------- search ----------

const SEARCH = { tracks: "song", albums: "album", artists: "author", playlists: "special" };
const ENTITLEMENT_QUALITIES = ["128", "320", "flac", "high", "viper_atmos", "viper_tape", "viper_clear", "super", "multitrack"];
const QUALITY_BY_LEVEL = { 1: "128", 2: "128", 4: "320", 5: "flac", 6: "high" };

async function markUnavailableTracks(tracks) {
  if (!signedIn()) return tracks;

  const groups = new Map();
  for (const track of tracks) {
    const id = parseId(track.id);
    const hash = id.hash.toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(hash)) continue;
    const group = groups.get(hash);
    if (!group) groups.set(hash, { album: id.album, tracks: [track] });
    else if (group.album === id.album) group.tracks.push(track);
    else group.album = null; // The same hash can appear in different album contexts.
  }
  const resource = [];
  for (const [hash, group] of groups) {
    if (group.album !== null) resource.push({ type: "audio", page_id: 0, hash, album_id: group.album });
  }
  if (!resource.length) return tracks;

  let response;
  try {
    response = await kg("/v2/get_res_privilege/lite", {
      router: "media.store.kugou.com",
      body: { appid: APP_ID, area_code: 1, behavior: "play", clientver: CLIENT_VER,
        need_hash_offset: 1, relate: 1, support_verify: 1, resource, qualities: ENTITLEMENT_QUALITIES },
    });
  } catch {
    return tracks; // Rights are unknown when the extra request fails.
  }

  const byHash = new Map();
  for (const row of list(response)) {
    const hash = String(row?.hash || "").toLowerCase();
    if (hash) byHash.set(hash, byHash.has(hash) ? null : row);
  }
  for (const { hash, album_id: album } of resource) {
    const row = byHash.get(hash);
    if (!row || (album && Number(row.album_id) && Number(row.album_id) !== album)) continue;
    const goods = list(row.relate_goods).filter(Boolean);
    const denied = QUALITY.lossless.every((quality) => {
      const variants = goods.filter((item) => String(item.quality ?? QUALITY_BY_LEVEL[item.level]) === quality);
      return variants.length > 0 && variants.every(({ status }) => status === 0 || status === "0");
    });
    if (denied) for (const track of groups.get(hash).tracks) track.unavailable = true;
  }
  return tracks;
}

export async function search({ query, kind, offset = 0 }) {
  if (kind === "shows") return searchShows(query, offset);
  const type = SEARCH[kind];
  if (!type) throw fail("unsupported");
  const size = type === "album" ? 20 : PAGE;
  const page = Math.floor(offset / size) + 1;
  const base = { keyword: query, page, pagesize: size, platform: "AndroidFilter", iscorrection: 1 };
  const params =
    type === "song" ? { ...base, privilegefilter: 0, area_code: 1, dopicfull: 1, clientver: 201 }
    : { ...base, albumhide: 0, nocollect: 0 };
  // Kugou's search now and then answers nothing for what it has: ask again.
  let d, items;
  for (let attempt = 0; attempt < 3; attempt++) {
    d = await kg(type === "song" ? "/v2/search/song" : `/v1/search/${type}`, { params, router: "complexsearch.kugou.com" });
    items = list(d.lists, d.info, d.list);
    if (items.length || page > 1) break;
  }
  const total = Number(d.total || 0);
  const more = total ? page * size < total : items.length >= size;
  if (type === "song") return { tracks: await markUnavailableTracks(tracksOf(items)), more };
  if (type === "album") return { albums: items.map(toAlbum).filter((a) => a.id), more };
  if (type === "author") return { artists: items.map(toArtist).filter((a) => a.id), more };
  return { playlists: items.map(toPlaylist).filter((p) => p.id), more };
}

export async function suggest({ query }) {
  if (!query.trim()) return [];
  const d = await kg("/v2/getSearchTip", {
    params: { keyword: query, AlbumTipCount: 0, CorrectTipCount: 0, MVTipCount: 0, MusicTipCount: 10, radiotip: 0 },
    router: "searchtip.kugou.com",
  });
  const out = [];
  for (const g of list(d, d.data)) for (const r of list(g.RecordDatas, g.records)) out.push(String(r.HintInfo || r.hintinfo || ""));
  return [...new Set(out.filter(Boolean))].slice(0, 10);
}

// ---------- discovery ----------

async function dailyTracks() {
  const d = await kg("/everyday_song_recommend", { method: "POST", params: { platform: "ios" }, router: "everydayrec.service.kugou.com" });
  return tracksOf(list(d.song_list, d.songs, d.info));
}

async function recommendedPlaylists() {
  const clienttime = String(now());
  const body = {
    appid: APP_ID, mid: mid(), clientver: CLIENT_VER, platform: "android", clienttime,
    userid: String(auth().userid || 0), module_id: 1, page: 1, pagesize: PAGE,
    key: md5(`${APP_ID}${SALT}${CLIENT_VER}${clienttime}`),
    special_recommend: { withtag: 1, withsong: 1, sort: 1, ugc: 1, is_selected: 0, withrecommend: 1, area_code: 1, categoryid: 0 },
    req_multi: 1, retrun_min: 5, return_special_falg: 1,
  };
  const d = await kg("/v2/special_recommend", { body, router: "specialrec.service.kugou.com" });
  return list(d.special_list, d.list).map(toPlaylist).filter((p) => p.id);
}

async function ranks() {
  const d = await kg("/ocean/v6/rank/list", { params: { plat: 2, withsong: 0, parentid: 0 } });
  return list(d.info, d.list).filter((r) => r.rankid);
}

async function rankTracks(id, page = 1) {
  const body = { show_portrait_mv: 1, show_type_total: 1, filter_original_remarks: 1, area_code: 1, pagesize: 100, rank_cid: 0, type: 1, page, rank_id: Number(id) };
  const d = await kg("/openapi/kmr/v2/rank/audio", { body, headers: { "kg-tid": "369" } });
  return tracksOf(list(d.songlist, d.song_list, d.info, d.list));
}

async function newSongs() {
  const body = { rank_id: 21608, userid: Number(auth().userid || 0), page: 1, pagesize: PAGE, tags: [] };
  const d = await kg("/musicadservice/container/v1/newsong_publish", { body });
  return tracksOf(list(d, d.info, d.list, d.songlist));
}

export async function home() {
  const vip = await claimVip(false).catch(() => null);
  const [daily, lists, fresh, played] = await Promise.all([
    dailyTracks().catch(() => []),
    recommendedPlaylists().catch(() => []),
    newSongs().catch(() => []),
    signedIn() ? recent().catch(() => []) : [],
  ]);
  const sections = [];
  if (played.length) sections.push({ title: t("Recently played"), tracks: played.slice(0, 10), morePage: "recent" });
  if (daily.length) sections.push({ title: t("Daily picks"), tracks: daily.slice(0, 10), morePage: "daily" });
  if (lists.length) sections.push({ title: t("Recommended playlists"), playlists: lists });
  if (fresh.length) sections.push({ title: t("New songs"), tracks: fresh.slice(0, 10), morePage: "new" });
  sections.push({
    title: t("Explore"),
    links: [
      { title: t("Charts"), subtitle: t("Kugou's charts"), page: "charts" },
      { title: t("Private FM"), subtitle: t("Endless songs picked for you"), page: "fm" },
      { title: t("Discover"), subtitle: t("Playlists, new albums, artists and more"), page: "discover" },
      { title: t("Audiobooks"), subtitle: t("Novels, talks and radio dramas"), page: "audiobooks" },
    ],
  });
  return { title: t("Kugou Concept"), subtitle: vip || undefined, sections };
}

export async function browse({ page }) {
  if (page === "daily") return { title: t("Daily picks"), sections: [{ tracks: await dailyTracks(), empty: t("Nothing today") }] };
  if (page === "new") return { title: t("New songs"), sections: [{ tracks: await newSongs() }] };
  if (page === "fm") return { title: t("Private FM"), sections: [{ stations: await stations() }] };
  if (page === "recent") return { title: t("Recently played"), sections: [{ tracks: await recent(), empty: t("Nothing yet") }] };
  if (page === "cloud") return { title: t("Music cloud"), sections: [{ tracks: await cloudDrive(), empty: t("Nothing in your music cloud") }] };
  if (page === "charts") {
    const rs = await ranks();
    return {
      title: t("Charts"),
      sections: [{
        links: rs.map((r) => ({
          title: String(r.rankname), subtitle: String(r.update_frequency || r.intro || "").slice(0, 40) || undefined,
          imageUrl: img(r.imgurl || r.img_9 || r.banner_9), page: `rank:${r.rankid}`,
        })),
      }],
    };
  }
  if (page.startsWith("rank:")) {
    const id = page.slice(5);
    const r = (await ranks().catch(() => [])).find((x) => String(x.rankid) === id);
    return { title: r ? String(r.rankname) : t("Charts"), imageUrl: undefined, sections: [{ tracks: await rankTracks(id) }] };
  }
  if (page === "me") {
    const a = needSignIn();
    const sections = [];
    const vip = await vipInfo().catch(() => null);
    const note = store.get("vipNote", "");
    const lines = [];
    if (vip) lines.push(vip.vip ? (vip.end ? `${t("VIP until")} ${vip.end}` : t("VIP")) : t("Not VIP right now"));
    if (note) lines.push(note);
    sections.push({ title: t("Recently played"), tracks: (await recent().catch(() => [])).slice(0, 20), empty: t("Nothing yet") });
    sections.push({ title: t("My playlists"), playlists: await playlists().catch(() => []) });
    sections.push({
      links: [
        { title: t("Followed artists"), subtitle: t("The artists you follow"), page: "following" },
        { title: t("My listening chart"), subtitle: t("What you play most"), page: "listen" },
        { title: t("Purchased songs"), subtitle: t("Songs you bought on Kugou"), page: "bought" },
        { title: t("Claim today's VIP again"), subtitle: t("Concept Edition's free daily VIP"), page: "vip" },
      ],
    });
    const me = store.get("account", {});
    return { title: me.name || a.userid, imageUrl: me.imageUrl, description: lines.join("\n") || undefined, sections };
  }
  if (page === "discover") return discoverPage();
  if (page === "square") return squarePage();
  if (page.startsWith("plTag:")) return playlistTagPage(page.slice(6));
  if (page === "newAlbums") return { title: t("New albums"), sections: await newAlbums(PAGE) };
  if (page.startsWith("theme:")) return themePage(page.slice(6));
  if (page.startsWith("scene:")) return scenePage(page.slice(6));
  if (page.startsWith("singers:")) return singersPage(page.slice(8));
  if (page === "ai") return aiPage();
  if (page.startsWith("similar:")) return similarPage(page.slice(8));
  if (page === "hot") return hotPage();
  if (page.startsWith("q:")) return queryPage(page.slice(2));
  if (page === "listen") return listenPage();
  if (page === "bought") return purchasedPage();
  if (page === "audiobooks") return audiobooksPage();
  if (page.startsWith("books:")) return audiobookTagPage(page.slice(6));
  if (page === "following") {
    return { title: t("Followed artists"), sections: [{ artists: await followedArtists(true), empty: t("You don't follow any artists yet") }] };
  }
  if (page === "vip") {
    needSignIn();
    const note = await claimVip(true);
    const vip = await vipInfo().catch(() => null);
    return {
      title: t("Concept VIP"),
      description: [note, vip ? (vip.vip ? (vip.end ? `${t("VIP until")} ${vip.end}` : t("VIP")) : t("Not VIP right now")) : ""].filter(Boolean).join("\n"),
      sections: [],
    };
  }
  if (page.startsWith("artistAlbums:")) {
    const id = page.slice(13);
    return { title: t("Albums"), sections: [{ albums: await artistAlbums(id, 100) }] };
  }
  throw fail("unavailable", "no such page");
}

// ---------- more to discover ----------

// The playlist square: Kugou's recommended playlists, of one category or all.
async function squarePlaylists(categoryid = 0, pagesize = PAGE) {
  const clienttime = String(now());
  const body = {
    appid: APP_ID, mid: mid(), clientver: CLIENT_VER, platform: "android", clienttime,
    userid: Number(auth().userid || 0), module_id: 1, page: 1, pagesize,
    key: md5(`${APP_ID}${SALT}${CLIENT_VER}${clienttime}`),
    special_recommend: { withtag: 1, withsong: 1, sort: 1, ugc: 1, is_selected: 0, withrecommend: 1, area_code: 1, categoryid: Number(categoryid) },
    req_multi: 1, retrun_min: 5, return_special_falg: 1,
  };
  const d = await kg("/v2/special_recommend", { body, router: "specialrec.service.kugou.com" });
  return list(d.special_list, d.list).map(toPlaylist).filter((x) => x.id);
}

async function playlistTags() {
  const d = await kg("/pubsongs/v1/get_tags_by_type", { body: { tag_type: "collection", tag_id: 0, source: 3 } });
  return list(d, d.info, d.list).filter((g) => list(g.son).length);
}

async function squarePage() {
  const [lists, tags] = await Promise.all([squarePlaylists(0, 40), playlistTags().catch(() => [])]);
  const sections = [{ title: t("Recommended playlists"), playlists: lists }];
  for (const g of tags) sections.push({ title: String(g.tag_name), links: list(g.son).map((x) => ({ title: String(x.tag_name), page: `plTag:${x.tag_id}` })) });
  return { title: t("Playlist square"), sections };
}

async function playlistTagPage(id) {
  const [lists, tags] = await Promise.all([squarePlaylists(id, PAGE), playlistTags().catch(() => [])]);
  const tag = tags.flatMap((g) => list(g.son)).find((x) => String(x.tag_id) === String(id));
  return { title: tag ? String(tag.tag_name) : t("Playlists"), sections: [{ playlists: lists, empty: t("Nothing here yet") }] };
}

// New albums, by where they're from, as Kugou groups them.
const REGIONS = { chn: "Chinese", eur: "Western", jpn: "Japanese", kor: "Korean" };
async function newAlbums(pagesize = PAGE) {
  const d = await kg("/musicadservice/v1/mobile_newalbum_sp", { body: { apiver: 20, token: auth().token || "", page: 1, pagesize, withpriv: 1 } });
  return Object.entries(d)
    .filter(([, v]) => Array.isArray(v))
    .map(([k, v]) => ({ title: REGIONS[k] ? t(REGIONS[k]) : k, albums: v.map(toAlbum).filter((a) => a.id) }))
    .filter((x) => x.albums.length);
}

async function themes() {
  const d = await kg("/v2/getthemelist", {
    body: { platform: "android", clientver: CLIENT_VER, clienttime: Date.now(), area_code: 1, module_id: 1, userid: Number(auth().userid || 0) },
    router: "everydayrec.service.kugou.com",
  });
  return list(d.theme_list, d.list).filter((x) => x.id);
}

async function themePage(id) {
  const d = await kg("/v2/gettheme_songidlist", {
    body: { platform: "android", clientver: CLIENT_VER, clienttime: Date.now(), area_code: 1, module_id: 1, userid: Number(auth().userid || 0), theme_id: Number(id) },
    router: "everydayrec.service.kugou.com",
  });
  const th = d.theme_detail || {};
  return { title: String(th.title || t("Themes")), description: String(th.intro || "") || undefined, sections: [{ tracks: tracksOf(list(d.song_list)) }] };
}

async function scenes() {
  const d = await kg("/scene/v1/scene/list");
  return list(d.list).filter((x) => x.scene_id && Number(x.is_publish ?? 1) === 1);
}

// A scene's songs, as Kugou's scene music recommends them for it.
async function scenePage(id) {
  const [all, d] = await Promise.all([
    scenes().catch(() => []),
    kg("/genesisapi/v1/scene_music/rec_music", { params: { scene_id: id, page: 1, pagesize: PAGE }, body: { exposure: [] } }),
  ]);
  const sc = all.find((x) => String(x.scene_id) === String(id)) || {};
  const tracks = tracksOf(list(d.list).map((x) => x.song).filter((x) => x && x.hash));
  return { title: String(sc.title || t("Scenes")), description: String(sc.label || sc.intro || "") || undefined, sections: [{ tracks, empty: t("Nothing here yet") }] };
}

// Artists by where they sing, the most popular first.
const SINGER_TYPES = [
  { key: "0", name: "All" }, { key: "1", name: "Chinese" }, { key: "7", name: "Cantonese" }, { key: "8", name: "Hokkien" },
  { key: "6", name: "Korean" }, { key: "5", name: "Japanese" }, { key: "2", name: "Western" }, { key: "0m", name: "Independent musicians" }, { key: "4", name: "Other" },
];
const SINGER_SEX = [{ key: 0, name: "All" }, { key: 1, name: "Male" }, { key: 2, name: "Female" }, { key: 3, name: "Groups" }];

async function singersPage(spec) {
  const [type = "0", sex = "0"] = spec.split(":");
  const musician = type.endsWith("m") ? 3 : 0;
  const d = await kg("/ocean/v6/singer/list", { params: { hotsize: 100, musician, sextype: Number(sex), showtype: 2, type: Number(type.replace("m", "")) } });
  const groups = list(d.info);
  const hot = groups.find((g) => g.title === "热门") || groups[0] || {};
  const artists = list(hot.singer).map(toArtist).filter((a) => a.id && a.id !== "0");
  const name = SINGER_TYPES.find((x) => x.key === type)?.name || "Artists";
  return {
    title: t(name === "All" ? "Artists" : name),
    sections: [
      { links: SINGER_SEX.filter((x) => String(x.key) !== sex).map((x) => ({ title: t(x.name), page: `singers:${type}:${x.key}` })) },
      { title: sex !== "0" ? t(SINGER_SEX.find((x) => String(x.key) === sex)?.name || "") : t("Popular"), artists, empty: t("Nothing here yet") },
    ],
  };
}

// Songs Kugou's AI picks: for the listener, and like the songs they played.
async function aiSongs(pagesize = PAGE) {
  const d = await kg("/concepts/v1/ai/recommend_song", { body: { apiver: 2, source: 2, pagesize, page: 1 } });
  return tracksOf(list(d.list, d.song_list));
}

async function likeThese(mixes) {
  const clienttime = Date.now();
  const body = {
    platform: "ios", clientver: CLIENT_VER, clienttime, userid: Number(auth().userid || 0), client_playlist: [], source_type: 2, playlist_ver: 2,
    area_code: 1, appid: APP_ID, key: md5(`${APP_ID}${SALT}${CLIENT_VER}${clienttime}`), mid: mid(), recommend_source: mixes.map((ID) => ({ ID: Number(ID) })),
  };
  const d = await kg("/recommend", { bare: true, body, router: "songlistairec.kugou.com" });
  return tracksOf(list(d.song_list, d.list));
}

// The few songs played last, to ask for more like them.
async function lastPlayed(n = 3) {
  const a = auth();
  if (!a.token) return [];
  const d = await kg("/playhistory/v1/get_songs", { body: { token: a.token, userid: Number(a.userid), source_classify: "app", to_subdivide_sr: 1 } });
  return list(d.songs).sort((x, y) => Number(y.ot || 0) - Number(x.ot || 0)).map((x) => ({ mix: x.mxid || x.info?.mixsongid, name: x.info?.name })).filter((x) => x.mix).slice(0, n);
}

async function aiPage() {
  const seeds = await lastPlayed(3).catch(() => []);
  const [picks, like] = await Promise.all([aiSongs(PAGE).catch(() => []), seeds.length ? likeThese(seeds.map((x) => x.mix)).catch(() => []) : []]);
  const sections = [];
  if (like.length) sections.push({ title: t("Like what you played lately"), tracks: like });
  sections.push({ title: t("AI picks"), tracks: picks, empty: t("Nothing here yet") });
  return { title: t("AI picks"), sections };
}

// Playlists like one the listener saved: Kugou's similar lists of it.
async function similarPlaylists(gid) {
  const clienttime = Date.now();
  const d = await kg("/pubsongs/v1/kmr_get_similar_lists", {
    body: {
      appid: APP_ID, clientver: CLIENT_VER, clienttime, key: md5(`${APP_ID}${SALT}${CLIENT_VER}${clienttime}`), userid: Number(auth().userid || 0),
      ugc: 1, show_list: 1, need_songs: 0, data: [{ global_collection_id: gid }],
    },
  });
  return list(list(d)[0]?.collection_list).map((r) => ({
    ...toPlaylist({ ...r, specialname: r.collection_name, nickname: r.user_name, songcount: r.song_count }),
  })).filter((x) => x.id && x.id !== gid);
}

async function similarPage(gid) {
  const info = await playlistInfo(gid).catch(() => ({}));
  const name = String(info.specialname || info.name || "");
  return { title: t("Similar playlists"), subtitle: name || undefined, sections: [{ playlists: await similarPlaylists(gid), empty: t("Nothing here yet") }] };
}

// What Kugou's search is hot on now, a list of words per chart; each opens
// that search's songs.
async function hotPage() {
  const d = await kg("/api/v3/search/hot_tab", { params: { navid: 1, plat: 2 }, router: "msearch.kugou.com" });
  return {
    title: t("Hot searches"),
    sections: list(d.list).map((g) => ({
      title: String(g.name),
      links: list(g.keywords).filter((k) => k.keyword).map((k) => ({ title: String(k.keyword), subtitle: k.reason && k.reason !== k.keyword ? String(k.reason) : undefined, page: `q:${k.keyword}` })),
    })).filter((x) => x.links.length),
  };
}

async function queryPage(q) {
  const r = await search({ query: q, kind: "tracks", offset: 0 });
  return { title: q, sections: [{ tracks: r.tracks, empty: t("Nothing found") }] };
}

// The listener's own listening chart: this week's and all time's.
async function listenRank(type) {
  const a = needSignIn();
  const clienttime = now();
  const body = { t_userid: Number(a.userid), userid: Number(a.userid), list_type: type, area_code: 1, cover: 2, p: rsaRaw(JSON.stringify({ clienttime, token: a.token })).toUpperCase() };
  const d = await kg("/v2/get_list", { base: "https://listenservice.kugou.com", params: { clienttime, plat: 0 }, body });
  return tracksOf(list(d.lists, d.list));
}

async function listenPage() {
  const [week, all] = await Promise.all([listenRank(0).catch(() => []), listenRank(1).catch(() => [])]);
  return {
    title: t("My listening chart"),
    sections: [
      { title: t("This week"), tracks: week, empty: t("Nothing this week yet") },
      { title: t("All time"), tracks: all, empty: t("Nothing yet") },
    ],
  };
}

async function purchasedPage() {
  const a = needSignIn();
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const d = await kg("/openapi/copyright/v1/audio/get_goods", {
      body: { appid: APP_ID, userid: Number(a.userid), token: a.token, page, pagesize: 50, clientver: String(CLIENT_VER), deleted: 0, need_audio_info: 1, area_code: "1" },
    });
    const goods = list(d.goods, d.list);
    all.push(...goods.map((g) => g.audio_info || g.audio || g));
    if (goods.length < 50 || all.length >= Number(d.total || 0)) break;
  }
  return { title: t("Purchased songs"), sections: [{ tracks: tracksOf(all), empty: t("You haven't bought any songs") }] };
}

// The Discover page: a little of each, with a way into the rest.
async function discoverPage() {
  const saved = signedIn() ? store.get("myLists", []).find((l) => !l.mine && (l.cgid || l.gid)) : null;
  const [ai, lists, albums, th, sc, similar] = await Promise.all([
    aiSongs(10).catch(() => []),
    squarePlaylists(0, 12).then((x) => x.slice(0, 12)).catch(() => []),
    newAlbums(6).catch(() => []),
    themes().catch(() => []),
    scenes().catch(() => []),
    saved ? similarPlaylists(saved.cgid || saved.gid).catch(() => []) : [],
  ]);
  const sections = [];
  if (ai.length) sections.push({ title: t("AI picks"), tracks: ai, morePage: "ai" });
  if (lists.length) sections.push({ title: t("Playlist square"), playlists: lists, morePage: "square" });
  const fresh = albums.flatMap((g) => g.albums.slice(0, 3));
  if (fresh.length) sections.push({ title: t("New albums"), albums: fresh, morePage: "newAlbums" });
  if (similar.length) sections.push({ title: `${t("More like")} ${saved.name}`, playlists: similar.slice(0, 12), morePage: `similar:${saved.cgid || saved.gid}` });
  if (sc.length) sections.push({ title: t("Scenes"), links: sc.map((x) => ({ title: String(x.title), subtitle: String(x.label || "") || undefined, page: `scene:${x.scene_id}` })) });
  if (th.length) sections.push({ title: t("Themes"), links: th.map((x) => ({ title: String(x.title), subtitle: String(x.intro || "") || undefined, page: `theme:${x.id}` })) });
  sections.push({ title: t("Artists"), links: SINGER_TYPES.map((x) => ({ title: t(x.name === "All" ? "All artists" : x.name), page: `singers:${x.key}:0` })) });
  sections.push({ links: [{ title: t("Hot searches"), subtitle: t("What everyone is searching for"), page: "hot" }] });
  return { title: t("Discover"), sections };
}

// ---------- long audio: audiobooks and radio shows ----------

// Kugou keeps audiobooks as albums of their own (category 2) with episodes
// for songs, which play through the same song url as any song.

function toShow(r = {}) {
  return {
    id: String(r.album_id ?? r.albumid ?? ""),
    name: String(r.album_name ?? r.albumname ?? "").replace(/<\/?em>/g, ""),
    imageUrl: img(r.sizable_cover_source || r.sizable_cover || r.img || r.cover),
    description: String(r.intro || r.mix_intro || "").trim() || undefined,
    publisher: String(r.author_name || (Array.isArray(r.authors) ? r.authors.map((a) => a.author_name).filter(Boolean).join("、") : "") || "") || undefined,
    episodeCount: Number(r.audio_total || 0) || undefined,
  };
}
const showsOf = (xs) => list(xs).map(toShow).filter((x) => x.id && x.name);

async function showDetails(ids) {
  if (!ids.length) return [];
  const d = await kg("/openapi/v2/broadcast", {
    body: {
      data: ids.map((album_id) => ({ album_id: String(album_id) })), show_album_tag: 1,
      fields: "album_name,album_id,category,authors,sizable_cover,intro,author_name,trans_param,album_tag,mix_intro,full_intro,is_publish",
    },
    headers: { "KG-TID": "78" },
  });
  return list(d, d.info, d.list).filter((r) => r && r.album_id && String(r.category ?? "2") === "2");
}

async function showEpisodes(id, page) {
  const d = await kg("/longaudio/v2/album_audios", {
    body: { album_id: String(id), area_code: 1, tagid: 0, page, pagesize: PAGE }, router: "openapi.kugou.com", headers: { "KG-TID": "78" }, whole: true,
  });
  const episodes = list(d.data, d.data?.list).map((r) => {
    const tr = toTrack(r);
    if (!tr) return null;
    tr.showId = String(id);
    const day = String(r.publish_date || r.publish_time || "").slice(0, 10);
    if (day && day !== "0000-00-00") tr.published = day;
    return tr;
  }).filter(Boolean);
  return { episodes, total: Number(d.total || 0) };
}

export async function show({ id, offset = 0 }) {
  const page = Math.floor(offset / PAGE) + 1;
  const [detail, eps] = await Promise.all([showDetails([id]).catch(() => []), showEpisodes(id, page)]);
  const sh = toShow(detail[0] || { album_id: id, album_name: eps.episodes[0]?.album.name });
  sh.id = String(id);
  if (!sh.imageUrl) sh.imageUrl = eps.episodes[0]?.album.imageUrl;
  if (eps.total) sh.episodeCount = eps.total;
  for (const e of eps.episodes) if (!e.album.imageUrl) e.album.imageUrl = sh.imageUrl;
  return { show: sh, episodes: await markUnavailableTracks(eps.episodes), more: eps.total ? page * PAGE < eps.total : eps.episodes.length >= PAGE };
}

// Kugou has no search of audiobooks as such: its long audio search answers
// episodes, which are gathered here into the books they belong to. One book's
// episodes can fill page after page, so four pages are read at once, and a
// read that finds no new book ends the search.
const showSearches = new Map();
async function searchShows(query, offset) {
  let s = showSearches.get(query);
  if (!s || offset === 0) {
    s = { page: 0, ids: [], shows: [], done: false };
    showSearches.set(query, s);
    if (showSearches.size > 20) showSearches.delete(showSearches.keys().next().value);
  }
  const a = auth();
  const episodes = (page) =>
    kg("/complexsearch/v4/search/song", {
      params: {
        area_code: 1, albumhide: 1, com_user_type: 0, privilegefilter: 0, dopicfull: 1, filter: 12, platform: "AndroidFilter", tag: "em", recver: 2,
        iscorrection: 1, search_ability: 223, sec_aggre: 1, sec_aggre_bitmap: 0, mode_ability: 1, nocollect: 1, user_type: 0,
        userid: a.userid || "0", keyword: query, page, pagesize: PAGE, clientver: 20789,
      },
    }).catch(() => ({}));
  for (let round = 0; s.shows.length < offset + 10 && !s.done && round < 2; round++) {
    const pages = await Promise.all([1, 2, 3, 4].map((i) => episodes(s.page + i)));
    s.page += 4;
    const items = pages.flatMap((d) => list(d.lists, d.list));
    const total = Number(pages[0].total || 0);
    const fresh = [...new Set(items.map((x) => String(x.AlbumID || x.album_id || "")).filter((x) => x && x !== "0" && !s.ids.includes(x)))];
    s.ids.push(...fresh);
    const found = await showDetails(fresh).catch(() => []);
    const byId = new Map(found.map((r) => [String(r.album_id), r]));
    const shows = fresh.filter((x) => byId.has(x)).map((x) => toShow(byId.get(x)));
    s.shows.push(...shows);
    if (!shows.length || pages.some((d) => list(d.lists, d.list).length < PAGE) || s.page * PAGE >= total) s.done = true;
  }
  return { shows: s.shows.slice(offset), more: !s.done };
}

// The audiobook front page: what Kugou recommends today, this week's new
// books, its charts, and its categories, each opening a page of books.
async function audiobooksPage() {
  const [daily, week, vip, rank, tags] = await Promise.all([
    kg("/longaudio/v1/home_new/daily_recommend", { method: "POST", params: { module_id: 1, size: PAGE, page: 1 } }).catch(() => ({})),
    kg("/longaudio/v1/home_new/week_new_albums_recommend", { body: { album_playlist: [] }, params: { clientver: 12329 } }).catch(() => ({})),
    kg("/longaudio/v1/home_new/vip_select_recommend", { body: { album_playlist: [] }, params: { position: "2", clientver: 12329 } }).catch(() => ({})),
    kg("/longaudio/v1/home_new/rank_card_recommend", { params: { platform: "ios" } }).catch(() => []),
    audiobookTags().catch(() => []),
  ]);
  const sections = [];
  const add = (title, shows) => shows.length && sections.push({ title, shows });
  add(t("Picked for you today"), showsOf(daily.albums));
  add(String(week.title || t("New this week")), showsOf(week.list));
  for (const r of list(rank)) add(String(r.rank_name || t("Charts")), showsOf(r.albums));
  add(String(vip.title || t("VIP picks")), showsOf(vip.list));
  if (tags.length) {
    sections.push({
      title: t("Categories"),
      links: tags.map((g) => ({ title: String(g.tag_name), imageUrl: img(g.pic_img || g.icon) || undefined, page: `books:${g.tag_id}` })),
    });
  }
  return { title: t("Audiobooks"), sections };
}

async function audiobookTags() {
  const d = await kg("/v3/list_audiobook_tags", { params: { platform: "android", clientver: 20789 }, router: "longaudio.kugou.com" });
  return list(d, d.list, d.info).filter((g) => g.tag_id);
}

// One category of books: its most played first, and its sub-categories.
async function audiobookTagPage(tagId) {
  const tags = await audiobookTags().catch(() => []);
  const top = tags.find((g) => String(g.tag_id) === String(tagId));
  const parent = tags.find((g) => list(g.son).some((x) => String(x.tag_id) === String(tagId)));
  const me = top || list(parent?.son).find((x) => String(x.tag_id) === String(tagId));
  const d = await kg("/longaudio/v1/album/list", {
    params: { api_ver: 2, gender: 0, sort: 0, tag_id: Number(tagId), free: 1, status: 0, page: 1, page_size: 60, clientver: 20789 },
  });
  const sections = [{ shows: showsOf(d.data_list || d.list), empty: t("Nothing here yet") }];
  if (top && list(top.son).length) {
    sections.push({ title: t("More in this category"), links: list(top.son).map((x) => ({ title: String(x.tag_name), page: `books:${x.tag_id}` })) });
  }
  return { title: me ? String(me.tag_name) : t("Audiobooks"), sections };
}

// ---------- the listener's library ----------

// Own playlists, as Kugou's cloud list has them. Their id here is "u<listid>";
// someone else's playlist is its global_collection_id.
async function myLists() {
  const a = needSignIn();
  const body = { userid: String(a.userid), token: String(a.token), total_ver: 979, type: 2, page: 1, pagesize: 200 };
  const d = await kg("/v7/get_all_list", { body, params: { plat: 1, userid: Number(a.userid), token: a.token }, router: "cloudlist.service.kugou.com" });
  const lists = list(d.info, d.list);
  store.set("myLists", lists.map((l) => ({ listid: l.listid, gid: l.global_collection_id, cgid: l.list_create_gid, name: l.name, pic: l.pic || l.cover || "", intro: l.intro || "", mine: Number(l.type) !== 1 && Number(l.list_create_userid) === Number(a.userid), type: l.type })));
  return lists;
}

function likedList(lists) {
  return lists.find((l) => l.name === "我喜欢") || lists.find((l) => Number(l.listid) === 2) || lists.find((l) => Number(l.is_def) === 2);
}

function myPlaylist(l, userid) {
  const mine = Number(l.type) !== 1 && Number(l.list_create_userid || userid) === Number(userid);
  return {
    id: mine ? `u${l.listid}` : String(l.global_collection_id || l.list_create_gid),
    name: String(l.name),
    imageUrl: img(l.pic || l.cover),
    description: String(l.intro || "") || undefined,
    owner: mine ? String(l.list_create_username || "") || undefined : undefined,
    trackCount: Number(l.count || 0) || undefined,
    mine,
    saved: !mine,
  };
}

export async function playlists() {
  if (!signedIn()) return [];
  const a = auth();
  const lists = await myLists();
  const liked = likedList(lists);
  const own = lists.filter((l) => l !== liked);
  const out = own.map((l) => myPlaylist(l, a.userid));
  await fillOwnCovers(own, out);
  return out;
}

// Kugou leaves pic empty on own lists without a custom cover; its app shows the first song's cover.
// Fetch that one song per list, cached by list_ver so it is only refetched after the list changes.
async function fillOwnCovers(lists, out) {
  const cache = store.get("listCovers", {});
  const next = {};
  await Promise.all(out.map(async (p, i) => {
    const l = lists[i];
    if (!p.mine || p.imageUrl || !Number(l.count)) return;
    const key = String(l.listid), ver = String(l.list_ver ?? "");
    let url = cache[key]?.ver === ver ? cache[key].url : undefined;
    if (url === undefined) {
      try {
        const { tracks } = await listTracks(l.listid, 1, 1);
        url = tracks[0]?.album?.imageUrl || "";
      } catch {
        return;
      }
    }
    next[key] = { ver, url };
    if (url) p.imageUrl = url;
  }));
  store.set("listCovers", next);
}

async function listTracks(listid, page = 1, pagesize = 300) {
  const a = needSignIn();
  const body = { listid: Number(listid), userid: String(a.userid), type: 0, page, pagesize, area_code: 1, allplatform: 1, show_cover: 1, token: a.token };
  const d = await kg("/v4/get_list_all_file_v3", { body, router: "cloudlist.service.kugou.com" });
  const items = list(d.songs, d.info, d.list);
  const fileids = {};
  const tracks = [];
  const rows = [];
  for (const s of items) {
    const tr = toTrack(s);
    if (!tr) continue;
    tracks.push(tr);
    rows.push({ track: tr, fileid: Number(s.fileid || 0), sort: Number(s.sort ?? 0) });
    if (s.fileid) fileids[`${listid}:${tr.id}`] = s.fileid;
  }
  remember("fileids", fileids);
  return { tracks, rows, total: Number(d.count || d.total || items.length), ver: Number(d.list_ver || 0) };
}

// Every song of an own list, 300 a page, which is the most Kugou gives at once.
// Kugou hands them out by fileid, the order they were added; its app shows
// them by each song's sort, smallest first, which is newest first until the
// listener moves songs about. withRows answers the fileids and list_ver too.
async function allListTracks(listid, withRows) {
  const first = await listTracks(listid, 1, 300);
  const pages = Math.min(Math.ceil(first.total / 300), 20);
  const rest = await Promise.all(Array.from({ length: Math.max(pages - 1, 0) }, (_, i) => listTracks(listid, i + 2, 300).then((r) => r.rows)));
  const rows = [...first.rows, ...rest.flat()].sort((x, y) => x.sort - y.sort || y.fileid - x.fileid);
  if (withRows) return { rows, ver: first.ver };
  return rows.map((r) => r.track);
}

// Moves a song of an own list from one place to another: Kugou takes the
// whole new order as each song's sort, with the list's version.
export async function movePlaylistTrack({ id, from, to }) {
  if (!String(id).startsWith("u")) throw fail("unsupported");
  const listid = Number(String(id).slice(1));
  const { rows, ver } = await allListTracks(listid, true);
  if (from < 0 || from >= rows.length || to < 0 || to >= rows.length) throw new Error(t("That song isn't in this playlist anymore"));
  rows.splice(to, 0, rows.splice(from, 1)[0]);
  const data = rows.map((r, i) => ({ fileid: r.fileid, sort: i }));
  await cloud("/v1/modify_song_sort", { listid, list_ver: ver, type: 0, data });
  likedRead = null;
}

async function publicTracks(gid) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const params = {
      area_code: 1, begin_idx: (page - 1) * 300, plat: 1, type: 1, mode: 1, personal_switch: 1,
      extend_fields: "abtags,hot_cmt,popularization", pagesize: 300, global_collection_id: gid,
    };
    const d = await kg("/pubsongs/v2/get_other_list_file_nofilt", { params });
    const got = tracksOf(list(d.songs, d.info, d.list));
    all.push(...got);
    if (got.length < 300 || all.length >= Number(d.count || 0)) break;
  }
  return all;
}

async function playlistInfo(gid) {
  const a = auth();
  const body = { data: [{ global_collection_id: gid }], userid: String(a.userid || 0), token: String(a.token || "") };
  const d = await kg("/v3/get_list_info", { body, router: "pubsongs.kugou.com" });
  return list(d, d.info, d.list)[0] || {};
}

export async function playlist({ id }) {
  if (id.startsWith("u")) {
    const listid = id.slice(1);
    const meta = store.get("myLists", []).find((l) => String(l.listid) === listid) || {};
    const tracks = await allListTracks(listid);
    // Kugou leaves pic empty on lists without a custom cover; its app shows the first song's cover then.
    const imageUrl = img(meta.pic) || tracks.find((x) => x.album?.imageUrl)?.album.imageUrl;
    return { id, name: meta.name || t("Playlist"), imageUrl, description: meta.intro || undefined, mine: true, trackCount: tracks.length, tracks };
  }
  const [info, tracks] = await Promise.all([playlistInfo(id).catch(() => ({})), publicTracks(id)]);
  const saved = store.get("myLists", []).some((l) => (l.gid === id || l.cgid === id) && !l.mine);
  return { ...toPlaylist({ ...info, global_collection_id: id }), saved, trackCount: tracks.length, tracks };
}

async function likedListId() {
  const lists = await myLists();
  const l = likedList(lists);
  if (!l) throw fail("unavailable", t("Couldn't find your 我喜欢 list"));
  return l.listid;
}

async function likedIndex(refresh) {
  let idx = store.get("likedIndex", null);
  if (!idx || refresh || Date.now() - idx.at > 10 * 60 * 1000) {
    const listid = await likedListId();
    const tracks = await allListTracks(listid);
    idx = { at: Date.now(), listid, hashes: tracks.map((x) => parseId(x.id).hash) };
    store.set("likedIndex", idx);
  }
  return idx;
}

// 我喜欢 reads in the app's order (newest first unless the listener moved songs).
// The whole list is read once when its first page is asked for, and the
// pages after it come from that read.
let likedRead = null;

export async function liked({ offset = 0 }) {
  needSignIn();
  if (offset === 0 || !likedRead || Date.now() - likedRead.at > 10 * 60 * 1000) {
    const listid = await likedListId();
    const tracks = await allListTracks(listid);
    likedRead = { at: Date.now(), tracks };
    store.set("likedIndex", { at: Date.now(), listid, hashes: tracks.map((x) => parseId(x.id).hash) });
  }
  const tracks = likedRead.tracks.slice(offset, offset + 100);
  return { tracks, more: offset + 100 < likedRead.tracks.length };
}

export async function isLiked({ ids }) {
  if (!signedIn()) return Object.fromEntries(ids.map((i) => [i, false]));
  const idx = await likedIndex(false);
  const set = new Set(idx.hashes);
  return Object.fromEntries(ids.map((i) => [i, set.has(parseId(i).hash)]));
}

async function addSongs(listid, trackIds) {
  const a = needSignIn();
  const data = trackIds.map((i) => {
    const p = parseId(i);
    return { number: 1, name: NAMES.get(p.hash) || p.hash, hash: p.hash, size: 0, sort: 0, timelen: 0, bitrate: 0, album_id: p.album, mixsongid: p.mix };
  });
  const body = { userid: a.userid, token: a.token, listid: String(listid), list_ver: 0, type: 0, slow_upload: 1, scene: "false;null", data };
  await kg("/cloudlist.service/v6/add_song", { body, params: { last_time: now(), last_area: "gztx", userid: a.userid, token: a.token } });
}

async function removeSongs(listid, trackIds) {
  const a = needSignIn();
  let map = store.get("fileids", {});
  if (trackIds.some((i) => !map[`${listid}:${i}`])) {
    await allListTracks(listid);
    map = store.get("fileids", {});
  }
  // Match by hash too, as the same song can come with another mixsongid.
  const byHash = {};
  for (const [k, v] of Object.entries(map)) if (k.startsWith(`${listid}:`)) byHash[parseId(k.slice(String(listid).length + 1)).hash] = v;
  const data = trackIds.map((i) => map[`${listid}:${i}`] || byHash[parseId(i).hash]).filter(Boolean).map((f) => ({ fileid: Number(f) }));
  if (!data.length) return;
  const body = { listid: Number(listid), userid: Number(a.userid), data, type: 0, token: a.token, list_ver: 0 };
  await kg("/v4/delete_songs", { body, router: "cloudlist.service.kugou.com" });
}

export async function like({ id, on }) {
  const idx = await likedIndex(false);
  if (on) await addSongs(idx.listid, [id]);
  else await removeSongs(idx.listid, [id]);
  const h = parseId(id).hash;
  idx.hashes = on ? [...new Set([...idx.hashes, h])] : idx.hashes.filter((x) => x !== h);
  store.set("likedIndex", idx);
  likedRead = null;
}

export async function addToPlaylist({ id, trackIds }) {
  if (!id.startsWith("u")) throw fail("unsupported");
  await addSongs(id.slice(1), trackIds);
}
export async function removeFromPlaylist({ id, trackIds }) {
  if (!id.startsWith("u")) throw fail("unsupported");
  await removeSongs(id.slice(1), trackIds);
}

export async function createPlaylist({ name }) {
  const a = needSignIn();
  const body = { userid: Number(a.userid), token: a.token, total_ver: 0, name, type: 0, source: 1, is_pri: 0, list_create_userid: Number(a.userid), list_create_listid: 0, list_create_gid: "", from_shupinmv: 0 };
  const d = await kg("/cloudlist.service/v5/add_list", { body, params: { last_time: now(), last_area: "gztx", userid: a.userid, token: a.token } });
  let listid = d.listid || d.info?.listid;
  if (!listid) listid = (await myLists()).find((l) => l.name === name)?.listid;
  await myLists().catch(() => {});
  return { id: `u${listid}`, name, mine: true, trackCount: 0, tracks: [] };
}

// Saving someone else's playlist to the listener's collection.
export async function savePlaylist({ id, on }) {
  const a = needSignIn();
  if (on) {
    const info = await playlistInfo(id).catch(() => ({}));
    const body = {
      userid: Number(a.userid), token: a.token, total_ver: 0, name: String(info.specialname || info.name || ""), type: 1, source: 1, is_pri: 0,
      list_create_userid: Number(info.list_create_userid || 0), list_create_listid: Number(info.list_create_listid || 0),
      list_create_gid: id, from_shupinmv: 0,
    };
    await kg("/cloudlist.service/v5/add_list", { body });
  } else {
    const l = await ownList(id);
    if (l) await cloudLegacy("/v2/delete_list", { listid: Number(l.listid), total_ver: 0, type: 1 });
    await myLists().catch(() => {});
  }
  await myLists().catch(() => {});
}

// Kugou hands the history out a page at a time, not in order across pages,
// so this reads a few pages and sorts them by when each song was played.
export async function recent() {
  const a = needSignIn();
  const seen = new Map();
  let bp;
  for (let i = 0; i < 5; i++) {
    const body = { token: a.token, userid: Number(a.userid), source_classify: "app", to_subdivide_sr: 1 };
    if (bp) body.bp = bp;
    const d = await kg("/playhistory/v1/get_songs", { body });
    for (const s of list(d.songs, d.list, d.info)) {
      const k = String(s.mxid || s.info?.mixsongid || s.info?.hash || "");
      const at = Number(s.ot || 0);
      if (k && (!seen.has(k) || seen.get(k).at < at)) seen.set(k, { at, s });
    }
    if (!Number(d.has_more) || !d.bp || d.bp === bp) break;
    bp = d.bp;
  }
  const rows = [...seen.values()].sort((x, y) => y.at - x.at);
  return tracksOf(rows.map((r) => r.s.info || r.s));
}

// ---------- cloud playlists: Kugou's encrypted cloudlist protocol ----------

const CLOUD_KEY = "LnT6xpN3khm36zse0QzvmgTZ3waWdRSA";
const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// One cloudlist call: the body AES-CBC encrypted with a session key, the key
// sent RSA encrypted, and the answer decrypted with the same key.
async function cloud(path, data) {
  await ensureDevice();
  const a = needSignIn();
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const aes = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * 62)]).join("");
  const h = md5(aes);
  const key = utf8(h.slice(0, 16)), iv = utf8(h.slice(16, 32));
  const clienttime = now();
  const params = {
    appid: APP_ID, clientver: CLIENT_VER, mid: mid(), clienttime,
    key: md5(`${APP_ID}${CLOUD_KEY}${CLIENT_VER}${clienttime}`),
    dfid: dfid(),
    p: rsaPkcs1(JSON.stringify({ aes, uid: Number(a.userid), token: a.token })).toUpperCase(),
  };
  const qs = Object.keys(params).map((k) => `${k}=${encodeURIComponent(params[k])}`).join("&");
  const body = cbcEncrypt(utf8(JSON.stringify(data)), key, iv);
  const res = await fetch(`${GATEWAY}${path}?${qs}`, {
    method: "POST",
    headers: {
      "User-Agent": UA, "Content-Type": "application/json;charset=utf-8", "x-router": "cloudlist.service.kugou.com",
      dfid: params.dfid, mid: params.mid, clienttime: String(clienttime),
      "kg-rc": "1", "kg-thash": "5d816a0", "kg-rec": "1", "kg-rf": "B9EDA08A64250DEFFBCADDEE00F8F25F",
    },
    body,
  });
  const raw = new Uint8Array(await res.arrayBuffer());
  let text;
  try {
    text = new TextDecoder().decode(cbcDecrypt(raw, key, iv));
    JSON.parse(text);
  } catch {
    text = new TextDecoder().decode(raw);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${t("Kugou sent something unreadable")} (${path})`);
  }
  const code = Number(json.error_code || 0);
  if (json.status === 0 || code) throw new Error(`${t("Kugou said no")} (${code || json.status} ${path})`);
  return json.data || json;
}

// The listener's own list behind a playlist id: u<listid> for theirs, or the
// collection id of one they saved.
async function ownList(id) {
  const lists = await myLists();
  const s = String(id);
  const l = s.startsWith("u") ? lists.find((x) => String(x.listid) === s.slice(1)) : lists.find((x) => x.global_collection_id === s || x.list_create_gid === s);
  return l;
}

export async function deletePlaylist({ id }) {
  const l = await ownList(id);
  if (!l) throw fail("not_found", t("That playlist isn't in your library"));
  if (Number(l.is_def) === 1 || Number(l.is_def) === 2) throw fail("unsupported", t("Kugou doesn't let you delete this list"));
  await cloudLegacy("/v2/delete_list", { listid: Number(l.listid), total_ver: 0, type: Number(l.type) === 1 ? 1 : 0 });
  await myLists().catch(() => {});
}

export async function renamePlaylist({ id, name }) {
  const l = await ownList(id);
  if (!l || Number(l.type) === 1) throw fail("not_found", t("That playlist isn't yours"));
  await cloud("/v1/modify_list", { total_ver: Number(l.total_ver || 0), listid: Number(l.listid), type: 0, sort: Number(l.sort || 0), tags: l.tags || "", intro: l.intro || "", name });
  await myLists().catch(() => {});
}

// Kugou keeps a play history per account; this is what fills "Recently played".
export async function played({ id }) {
  const a = auth();
  if (!a.token) return;
  const { mix } = parseId(id);
  if (!mix) return;
  await kg("/playhistory/v1/upload_songs", { params: { plat: 3 }, body: { songs: [{ mxid: mix, op: 1, ot: now(), pc: 1 }], token: a.token, userid: Number(a.userid) } });
}

// The older cloudlist form a few calls still want: the body sent as base64,
// a lowercase session key, and the usual Android signature on top.
async function cloudLegacy(path, data) {
  await ensureDevice();
  const a = needSignIn();
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const aes = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * 36)]).join("");
  const h = md5(aes);
  const key = utf8(h.slice(0, 16)), iv = utf8(h.slice(16, 32));
  const clienttime = now();
  const body = b64(cbcEncrypt(utf8(JSON.stringify(data)), key, iv));
  const params = {
    dfid: dfid(), mid: mid(), uuid: "-", appid: APP_ID, clientver: CLIENT_VER, clienttime, token: a.token, userid: a.userid,
    key: md5(`${APP_ID}${CLOUD_KEY}${CLIENT_VER}${clienttime}`), last_area: "gztx", last_time: clienttime,
    p: rsaPkcs1(JSON.stringify({ aes, uid: Number(a.userid), token: a.token })).toUpperCase(),
  };
  params.signature = androidSign(params, body);
  const qs = Object.keys(params).map((k) => `${k}=${encodeURIComponent(params[k])}`).join("&");
  const res = await fetch(`${GATEWAY}${path}?${qs}`, {
    method: "POST",
    headers: {
      "User-Agent": UA, "Content-Type": "application/json", "x-router": "cloudlist.service.kugou.com",
      dfid: params.dfid, mid: params.mid, clienttime: String(clienttime),
      "kg-rc": "1", "kg-thash": "5d816a0", "kg-rec": "1", "kg-rf": "B9EDA08A64250DEFFBCADDEE00F8F25F",
    },
    body,
  });
  const raw = new Uint8Array(await res.arrayBuffer());
  let text;
  try {
    text = new TextDecoder().decode(cbcDecrypt(raw, key, iv));
    JSON.parse(text);
  } catch {
    text = new TextDecoder().decode(raw);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${t("Kugou sent something unreadable")} (${path})`);
  }
  const code = Number(json.error_code || 0);
  if (json.status === 0 || code) throw new Error(`${t("Kugou said no")} (${code || json.status} ${path})`);
  return json.data || json;
}

// ---------- albums & artists ----------

export async function album({ id }) {
  const detailBody = {
    data: [{ album_id: String(id) }], is_buy: 0,
    fields: "album_id,album_name,publish_date,sizable_cover,intro,language,is_publish,heat,type,quality,authors,exclusive,author_name,trans_param",
  };
  const songsPage = (page) =>
    kg("/v1/album_audio/lite", { body: { album_id: String(id), is_buy: "", page, pagesize: 30 }, router: "openapi.kugou.com", headers: { "kg-tid": "255" } });
  const [detail, first] = await Promise.all([
    kg("/kmr/v2/albums", { body: detailBody, router: "openapi.kugou.com", headers: { "kg-tid": "255" } }).catch(() => ({})),
    songsPage(1),
  ]);
  const raw = list(detail, detail.info, detail.list)[0] || {};
  const al = toAlbum(raw);
  al.id = String(id);
  const pages = Math.min(Math.ceil(Number(first.total || 0) / 30), 10);
  const rest = await Promise.all(Array.from({ length: Math.max(pages - 1, 0) }, (_, i) => songsPage(i + 2).catch(() => ({}))));
  const tracks = tracksOf([first, ...rest].flatMap((d) => list(d.songs, d.info, d.list)));
  for (const tr of tracks) {
    if (!tr.album.imageUrl) tr.album.imageUrl = al.imageUrl;
    if (!tr.album.name) tr.album.name = al.name;
    if (!tr.album.id) tr.album.id = al.id;
  }
  if (!al.name && tracks[0]) al.name = tracks[0].album.name;
  if (!al.imageUrl && tracks[0]) al.imageUrl = tracks[0].album.imageUrl;
  return { album: al, tracks };
}

async function artistAlbums(id, size = 30) {
  const body = { author_id: String(id), pagesize: size, page: 1, sort: 1, category: 1, area_code: "all" };
  const d = await kg("/kmr/v1/author/albums", { body, router: "openapi.kugou.com", headers: { "kg-tid": "36" } });
  return list(d, d.info, d.list).map(toAlbum).filter((a) => a.id);
}

export async function artist({ id }) {
  if (String(id).startsWith("name:")) {
    const found = await search({ query: id.slice(5), kind: "artists", offset: 0 });
    if (!found.artists[0]) throw fail("unavailable");
    id = found.artists[0].id;
  }
  const clienttime = now();
  const audiosBody = {
    appid: APP_ID, clientver: CLIENT_VER, mid: mid(), clienttime, key: md5(`${APP_ID}${SALT}${CLIENT_VER}${clienttime}`),
    author_id: String(id), pagesize: 100, page: 1, sort: 1, area_code: "all",
  };
  const [detail, songs, albums] = await Promise.all([
    kg("/kmr/v3/author", { body: { author_id: String(id) }, router: "openapi.kugou.com", headers: { "kg-tid": "36" } }).catch(() => ({})),
    kg("/kmr/v1/audio_group/author", { base: "https://openapi.kugou.com", body: audiosBody, router: "openapi.kugou.com", headers: { "kg-tid": "220" } }).catch(() => []),
    artistAlbums(id).catch(() => []),
  ]);
  const a = toArtist(Array.isArray(detail) ? detail[0] : detail);
  a.id = String(id);
  if (signedIn()) a.following = (await followedArtists(false).catch(() => [])).some((x) => x.id === a.id);
  return { artist: a, tracks: tracksOf(list(songs, songs.info, songs.list)), albums };
}

// ---------- followed artists ----------

// The artists the listener follows, newest first. Kept for ten minutes, so
// artist pages can say whether they're followed without asking each time.
let followRead = null;
async function followedArtists(refresh) {
  const a = needSignIn();
  if (!refresh && followRead && followRead.user === a.userid && Date.now() - followRead.at < 10 * 60 * 1000) return followRead.artists;
  const body = {
    merge: 2, need_iden_type: 1, ext_params: "k_pic,jumptype,singerid,score", userid: Number(a.userid), type: 0, id_type: 0,
    p: rsaRaw(JSON.stringify({ clienttime: now(), token: a.token })).toUpperCase(),
  };
  const d = await kg("/v4/follow_list", { body, params: { plat: 1 }, router: "relationuser.kugou.com" });
  // The list also holds people who aren't artists; those have no singerid.
  const artists = list(d.lists, d.list, d.info)
    .filter((r) => Number(r.singerid) > 0)
    .map((r) => ({ id: String(r.singerid), name: String(r.nickname || ""), imageUrl: img(r.pic), following: true }));
  followRead = { at: Date.now(), user: a.userid, artists };
  return artists;
}

export async function followArtist({ id, on }) {
  const a = needSignIn();
  const singerid = Number(String(id).replace(/^name:/, ""));
  if (!singerid) throw fail("unsupported", t("Kugou can't follow this artist"));
  const clienttime = now();
  const enc = followCrypt({ singerid, token: a.token }, clienttime);
  const body = { plat: 0, userid: Number(a.userid), singerid, source: 7, p: enc.p, params: enc.str };
  await kg(on ? "/followservice/v3/follow_singer" : "/followservice/v3/unfollow_singer", { body, params: { clienttime } });
  followRead = null;
}

// ---------- playback ----------

// "high" is Kugou's Hi-Res (24-bit FLAC); the app's highest level asks for it first.
const QUALITY = { standard: ["128"], high: ["320", "128"], lossless: ["high", "flac", "320", "128"] };

export async function stream({ id, quality }) {
  if (String(id).endsWith(CLOUD_TAG)) return cloudStream(String(id));
  const p = parseId(id);
  const a = auth();
  let lastErr;
  for (const q of QUALITY[quality] || QUALITY.high) {
    const params = {
      dfid: dfid(), mid: mid(), uuid: "-", appid: APP_ID, clientver: 11430, clienttime: now(),
      album_id: p.album, area_code: 1, hash: p.hash.toLowerCase(), ssa_flag: "is_fromtrack", version: 11430,
      page_id: 967177915, quality: q, album_audio_id: p.mix, behavior: "play", pid: 411, cmd: 26, pidversion: 3001,
      IsFreePart: 0, ppage_id: "356753938,823673182,967485191", cdnBackup: 1, module: "",
    };
    if (a.token) params.token = a.token;
    if (a.userid) params.userid = a.userid;
    params.key = md5(`${params.hash}${KEY_SALT}${APP_ID}${params.mid}${params.userid || 0}`);
    let d;
    try {
      d = await kg("/v5/url", { bare: true, params, router: "trackercdn.kugou.com" });
    } catch (e) {
      lastErr = e;
      continue;
    }
    const url = list(d.url, d.backupUrl, d.backup_url).find((u) => typeof u === "string" && u.startsWith("http"));
    if (!url) {
      lastErr = null;
      continue;
    }
    const ext = String(d.extName || d.ext || url.split("?")[0].split(".").pop()).toLowerCase();
    if (!["mp3", "flac", "ogg"].includes(ext)) continue; // what the app plays
    if (q === "high" && ext !== "flac") continue; // Hi-Res or nothing: else plain FLAC is better
    let kbps = Number(d.bitRate || d.bitrate || 0);
    if (kbps > 10000) kbps = Math.round(kbps / 1000);
    return {
      url, type: ext,
      quality: ext === "flac" ? "lossless" : kbps >= 300 ? "high" : "standard",
      bitRate: kbps || undefined,
      size: Number(d.fileSize || d.filesize || 0) || undefined,
    };
  }
  if (lastErr && lastErr.code) throw lastErr;
  throw fail("unavailable", signedIn() ? t("Kugou won't play this one: VIP or copyright") : t("Sign in to play this"));
}


// ---------- lyrics ----------

function bytesOf(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function decodeKrc(b64) {
  const key = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];
  const all = bytesOf(b64).slice(4);
  for (let i = 0; i < all.length; i++) all[i] ^= key[i % 16];
  const deflate = all.subarray(2); // zlib header
  let size = Math.max(deflate.length * 8, 1 << 18);
  for (;;) {
    const out = tinf_uncompress(deflate, new Uint8Array(size));
    if (out.length < size) return new TextDecoder().decode(out);
    size *= 4;
    if (size > 64 << 20) throw new Error("lyrics too large");
  }
}

function krcLines(text) {
  const lines = [];
  let translation = [];
  for (const row of text.split(/\r?\n/)) {
    const lang = row.match(/^\[language:(.*)\]$/);
    if (lang) {
      try {
        const j = JSON.parse(new TextDecoder().decode(bytesOf(lang[1])));
        const tr = (j.content || []).find((c) => Number(c.type) === 1);
        if (tr) translation = tr.lyricContent.map((l) => l.join(""));
      } catch {}
      continue;
    }
    const m = row.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!m) continue;
    const start = Number(m[1]);
    const end = start + Number(m[2]);
    const words = [];
    const re = /<(\d+),(\d+),\d+>([^<]*)/g;
    let w;
    while ((w = re.exec(m[3]))) words.push({ start: start + Number(w[1]), end: start + Number(w[1]) + Number(w[2]), text: w[3] });
    const plain = words.length ? words.map((x) => x.text).join("") : m[3];
    lines.push({ start, end, text: plain, words: words.length ? words : undefined });
  }
  lines.forEach((l, i) => {
    if (translation[i] && translation[i].trim() && translation[i].trim() !== "//") l.translation = translation[i];
  });
  return lines;
}

export async function lyrics({ id }) {
  const p = parseId(id);
  const found = await kg("/search", {
    base: "https://lyrics.kugou.com", bare: true, sign: false,
    params: { ver: 1, man: "yes", client: "mobi", keyword: "", duration: "", hash: p.hash, album_audio_id: p.mix || "" },
  });
  const c = list(found.candidates)[0];
  if (!c) throw fail("unavailable", t("No lyrics for this one"));
  const base = { ver: 1, client: "android", id: c.id, accesskey: c.accesskey, charset: "utf8" };
  try {
    const d = await kg("/download", { base: "https://lyrics.kugou.com", bare: true, sign: false, params: { ...base, fmt: "krc" } });
    if (d.content) {
      const lines = krcLines(Number(d.contenttype) === 0 ? decodeKrc(d.content) : new TextDecoder().decode(bytesOf(d.content)));
      if (lines.length) return { lines };
    }
  } catch {}
  const d = await kg("/download", { base: "https://lyrics.kugou.com", bare: true, sign: false, params: { ...base, fmt: "lrc" } });
  if (!d.content) throw fail("unavailable", t("No lyrics for this one"));
  return { lrc: new TextDecoder().decode(bytesOf(d.content)) };
}

// ---------- comments ----------

export async function comments({ trackId, offset = 0 }) {
  const p = parseId(trackId);
  if (!p.mix) throw fail("unsupported");
  const page = Math.floor(offset / PAGE) + 1;
  const d = await kg("/mcomment/v1/cmtlist", {
    method: "POST",
    params: { ver: 6, mixsongid: p.mix, need_show_image: 1, p: page, pagesize: PAGE, show_classify: 1, show_hotword_list: 1, extdata: "0", code: COMMENT_CODE },
  });
  const raw = list(d.list, d.comments, d.weightList);
  const total = Number(d.count || d.combine_count || 0);
  return {
    comments: raw.map((c) => ({
      id: String(c.id || c.cmtid), author: String(c.user_name || c.username || ""), avatarUrl: img(c.user_pic),
      text: String(c.content || ""), time: c.addtime ? Date.parse(String(c.addtime).replace(" ", "T") + "+08:00") || undefined : undefined,
      likes: Number(c.like?.count || c.like_count || 0) || undefined,
    })),
    total: total || undefined,
    more: total ? page * PAGE < total : raw.length >= PAGE,
  };
}

// Posting goes to the comment service itself, by the song's comment id
// (childrenid), which the comment list answers for its mixsongid.
const COMMENT_CODE = "fc4be23b4e972707f36b8a828a93ba8a";

async function commentTarget(mix) {
  const d = await kg("/mcomment/v1/cmtlist", {
    method: "POST",
    params: { ver: 6, mixsongid: mix, need_show_image: 1, p: 1, pagesize: 1, show_classify: 1, show_hotword_list: 1, extdata: "0", code: COMMENT_CODE },
  });
  const first = list(d.list)[0] || {};
  const id = String(d.childrenid || first.special_child_id || "");
  if (!id || id === "0") throw fail("unavailable", t("Kugou has no comments for this song"));
  return { id, name: String(first.special_child_name || first.song_show_text || NAMES.get(first.hash) || "") };
}

// The comment service's query: the account, unsigned, with a key of the
// time and mid (and the body, for a post) salted as the Concept app does.
function commentQuery(extra, keyTail) {
  const a = needSignIn();
  const clienttime = now();
  return {
    ...extra, kugouid: a.userid, ver: 6, clienttoken: a.token, appid: APP_ID, clientver: CLIENT_VER, mid: mid(), clienttime,
    key: md5(`${APP_ID}${SALT}${CLIENT_VER}${clienttime}${mid()}${keyTail || ""}`), uuid: "-", dfid: dfid(),
  };
}

export async function postComment({ trackId, text }) {
  const p = parseId(trackId);
  const content = String(text || "").trim();
  if (!p.mix) throw fail("unsupported");
  if (!content) throw new Error(t("Write something first"));
  const target = await commentTarget(p.mix);
  const body = JSON.stringify({ data: { content, album_audio_id: p.mix, images: [] } });
  const params = commentQuery({ r: "commentsv3/add", code: COMMENT_CODE, childrenid: target.id, childrenname: target.name || undefined }, body);
  if (!params.childrenname) delete params.childrenname;
  const d = await kg("/index.php", { bare: true, sign: false, params, body, router: "m.comment.service.kugou.com", headers: { "Content-Type": "application/json; charset=UTF-8" } });
  const me = store.get("account", {});
  return {
    id: String(d.id || d.cmtid || d.cid || d.data?.id || ""),
    author: String(me.name || ""), avatarUrl: me.imageUrl, text: content, time: Date.now(),
  };
}

// Takes one of the listener's own comments down again. Not an export the app
// calls: it is here so a test can undo a post.
async function deleteComment({ trackId, commentId }) {
  const target = await commentTarget(parseId(trackId).mix);
  const params = commentQuery({ r: "commentsv2/delcomment", code: COMMENT_CODE, childrenid: target.id, cid: commentId });
  return kg("/index.php", { bare: true, sign: false, params, router: "m.comment.service.kugou.com" });
}

// ---------- private FM ----------

const STATION_MODES = [
  { id: "normal", name: "Private FM", description: "Plays on, to your taste" },
  { id: "small", name: "Niche FM", description: "Good songs few people know" },
];

export async function stations() {
  return STATION_MODES.map((s) => ({ id: s.id, name: t(s.name), description: t(s.description) }));
}

export async function stationNext({ id }) {
  const a = auth();
  const clienttime = Date.now();
  const body = {
    appid: APP_ID, clienttime, mid: mid(), action: "play", recommend_source_locked: 0, song_pool_id: 0, callerid: 0, m_type: 1,
    platform: "ios", area_code: 1, remain_songcnt: 0, clientver: CLIENT_VER, is_overplay: 0, mode: id || "normal",
    fakem: "ca981cfc583a4c37f28d2d49000013c16a0a", key: md5(`${APP_ID}${SALT}${CLIENT_VER}${clienttime}`),
  };
  if (a.userid) Object.assign(body, { userid: Number(a.userid), kguid: Number(a.userid), token: a.token });
  const d = await kg("/v2/personal_recommend", { body, router: "persnfm.service.kugou.com" });
  return tracksOf(list(d.song_list, d.songs, d.list));
}

// ---------- 音乐云盘: the songs the listener uploaded to Kugou ----------

// Its songs carry "_c" after the usual id, so they play from the cloud drive.
const CLOUD_TAG = "_c";

// One call to the cloud drive service: the same AES body and RSA key as the
// cloud lists, sent to mcloudservice as raw bytes with only these params.
async function mcloud(path, data) {
  await ensureDevice();
  const a = needSignIn();
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const aes = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * 36)]).join("");
  const h = md5(aes);
  const key = utf8(h.slice(0, 16)), iv = utf8(h.slice(16, 32));
  const clienttime = now();
  const params = {
    clienttime, mid: mid(), key: md5(`${APP_ID}${CLOUD_KEY}${CLIENT_VER}${clienttime}`), clientver: CLIENT_VER, appid: APP_ID,
    p: rsaPkcs1(JSON.stringify({ aes, uid: Number(a.userid), token: a.token })).toUpperCase(),
  };
  const qs = Object.keys(params).map((k) => `${k}=${encodeURIComponent(params[k])}`).join("&");
  const res = await fetch(`https://mcloudservice.kugou.com${path}?${qs}`, {
    method: "POST",
    headers: {
      "User-Agent": UA, dfid: dfid(), mid: params.mid, clienttime: String(clienttime),
      "kg-rc": "1", "kg-thash": "5d816a0", "kg-rec": "1", "kg-rf": "B9EDA08A64250DEFFBCADDEE00F8F25F",
    },
    body: cbcEncrypt(utf8(JSON.stringify(data)), key, iv),
  });
  const raw = new Uint8Array(await res.arrayBuffer());
  let text;
  try {
    text = new TextDecoder().decode(cbcDecrypt(raw, key, iv));
    JSON.parse(text);
  } catch {
    text = new TextDecoder().decode(raw);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${t("Kugou sent something unreadable")} (${path})`);
  }
  const code = Number(json.error_code || 0);
  if (json.status === 0 || code) throw new Error(`${t("Kugou said no")} (${code || json.status} ${path})`);
  return json.data || json;
}

async function cloudDrive() {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const d = await mcloud("/v1/get_list", { page, pagesize: 100, getkmr: 1 });
    const items = list(d.list, d.info, d.songs, d);
    for (const s of items) {
      const tr = toTrack(s);
      if (tr) all.push({ ...tr, id: tr.id + CLOUD_TAG });
    }
    const total = Number(d.list_count || d.total || d.count || 0);
    if (items.length < 100 || (total && all.length >= total)) break;
  }
  return all;
}

async function cloudStream(id) {
  const p = parseId(id.slice(0, -CLOUD_TAG.length));
  const hash = p.hash.toLowerCase();
  const params = {
    hash, ssa_flag: "is_fromtrack", version: "20102", ssl: 0, album_audio_id: p.mix, pid: 20026, audio_id: 0, kv_id: 2,
    key: md5(`musicclound${hash}20026ebd1ac3134c880bda6a2194537843caa0162e2e7`), bucket: "musicclound", name: "", with_res_tag: 0,
  };
  const d = await kg("/bsstrackercdngz/v2/query_musicclound_url", { params });
  let url = [d.url, d.backup_url, d.data?.url, d.data?.backup_url].find((u) => typeof u === "string" && u.startsWith("http"));
  if (!url) throw fail("unavailable", t("Kugou won't play this one: VIP or copyright"));
  url = url.replace(/^http:/, "https:");
  const ext = String(d.extName || d.data?.extName || url.split("?")[0].split(".").pop()).toLowerCase();
  return { url, type: ["mp3", "flac", "ogg"].includes(ext) ? ext : "mp3", quality: ext === "flac" ? "lossless" : "high" };
}

// ---------- inflate: tiny-inflate 1.0.3, (c) Devon Govett, MIT ----------
var TINF_OK = 0;
var TINF_DATA_ERROR = -3;

function Tree() {
  this.table = new Uint16Array(16);   /* table of code length counts */
  this.trans = new Uint16Array(288);  /* code -> symbol translation table */
}

function Data(source, dest) {
  this.source = source;
  this.sourceIndex = 0;
  this.tag = 0;
  this.bitcount = 0;
  
  this.dest = dest;
  this.destLen = 0;
  
  this.ltree = new Tree();  /* dynamic length/symbol tree */
  this.dtree = new Tree();  /* dynamic distance tree */
}

/* --------------------------------------------------- *
 * -- uninitialized global data (static structures) -- *
 * --------------------------------------------------- */

var sltree = new Tree();
var sdtree = new Tree();

/* extra bits and base tables for length codes */
var length_bits = new Uint8Array(30);
var length_base = new Uint16Array(30);

/* extra bits and base tables for distance codes */
var dist_bits = new Uint8Array(30);
var dist_base = new Uint16Array(30);

/* special ordering of code length codes */
var clcidx = new Uint8Array([
  16, 17, 18, 0, 8, 7, 9, 6,
  10, 5, 11, 4, 12, 3, 13, 2,
  14, 1, 15
]);

/* used by tinf_decode_trees, avoids allocations every call */
var code_tree = new Tree();
var lengths = new Uint8Array(288 + 32);

/* ----------------------- *
 * -- utility functions -- *
 * ----------------------- */

/* build extra bits and base tables */
function tinf_build_bits_base(bits, base, delta, first) {
  var i, sum;

  /* build bits table */
  for (i = 0; i < delta; ++i) bits[i] = 0;
  for (i = 0; i < 30 - delta; ++i) bits[i + delta] = i / delta | 0;

  /* build base table */
  for (sum = first, i = 0; i < 30; ++i) {
    base[i] = sum;
    sum += 1 << bits[i];
  }
}

/* build the fixed huffman trees */
function tinf_build_fixed_trees(lt, dt) {
  var i;

  /* build fixed length tree */
  for (i = 0; i < 7; ++i) lt.table[i] = 0;

  lt.table[7] = 24;
  lt.table[8] = 152;
  lt.table[9] = 112;

  for (i = 0; i < 24; ++i) lt.trans[i] = 256 + i;
  for (i = 0; i < 144; ++i) lt.trans[24 + i] = i;
  for (i = 0; i < 8; ++i) lt.trans[24 + 144 + i] = 280 + i;
  for (i = 0; i < 112; ++i) lt.trans[24 + 144 + 8 + i] = 144 + i;

  /* build fixed distance tree */
  for (i = 0; i < 5; ++i) dt.table[i] = 0;

  dt.table[5] = 32;

  for (i = 0; i < 32; ++i) dt.trans[i] = i;
}

/* given an array of code lengths, build a tree */
var offs = new Uint16Array(16);

function tinf_build_tree(t, lengths, off, num) {
  var i, sum;

  /* clear code length count table */
  for (i = 0; i < 16; ++i) t.table[i] = 0;

  /* scan symbol lengths, and sum code length counts */
  for (i = 0; i < num; ++i) t.table[lengths[off + i]]++;

  t.table[0] = 0;

  /* compute offset table for distribution sort */
  for (sum = 0, i = 0; i < 16; ++i) {
    offs[i] = sum;
    sum += t.table[i];
  }

  /* create code->symbol translation table (symbols sorted by code) */
  for (i = 0; i < num; ++i) {
    if (lengths[off + i]) t.trans[offs[lengths[off + i]]++] = i;
  }
}

/* ---------------------- *
 * -- decode functions -- *
 * ---------------------- */

/* get one bit from source stream */
function tinf_getbit(d) {
  /* check if tag is empty */
  if (!d.bitcount--) {
    /* load next tag */
    d.tag = d.source[d.sourceIndex++];
    d.bitcount = 7;
  }

  /* shift bit out of tag */
  var bit = d.tag & 1;
  d.tag >>>= 1;

  return bit;
}

/* read a num bit value from a stream and add base */
function tinf_read_bits(d, num, base) {
  if (!num)
    return base;

  while (d.bitcount < 24) {
    d.tag |= d.source[d.sourceIndex++] << d.bitcount;
    d.bitcount += 8;
  }

  var val = d.tag & (0xffff >>> (16 - num));
  d.tag >>>= num;
  d.bitcount -= num;
  return val + base;
}

/* given a data stream and a tree, decode a symbol */
function tinf_decode_symbol(d, t) {
  while (d.bitcount < 24) {
    d.tag |= d.source[d.sourceIndex++] << d.bitcount;
    d.bitcount += 8;
  }
  
  var sum = 0, cur = 0, len = 0;
  var tag = d.tag;

  /* get more bits while code value is above sum */
  do {
    cur = 2 * cur + (tag & 1);
    tag >>>= 1;
    ++len;

    sum += t.table[len];
    cur -= t.table[len];
  } while (cur >= 0);
  
  d.tag = tag;
  d.bitcount -= len;

  return t.trans[sum + cur];
}

/* given a data stream, decode dynamic trees from it */
function tinf_decode_trees(d, lt, dt) {
  var hlit, hdist, hclen;
  var i, num, length;

  /* get 5 bits HLIT (257-286) */
  hlit = tinf_read_bits(d, 5, 257);

  /* get 5 bits HDIST (1-32) */
  hdist = tinf_read_bits(d, 5, 1);

  /* get 4 bits HCLEN (4-19) */
  hclen = tinf_read_bits(d, 4, 4);

  for (i = 0; i < 19; ++i) lengths[i] = 0;

  /* read code lengths for code length alphabet */
  for (i = 0; i < hclen; ++i) {
    /* get 3 bits code length (0-7) */
    var clen = tinf_read_bits(d, 3, 0);
    lengths[clcidx[i]] = clen;
  }

  /* build code length tree */
  tinf_build_tree(code_tree, lengths, 0, 19);

  /* decode code lengths for the dynamic trees */
  for (num = 0; num < hlit + hdist;) {
    var sym = tinf_decode_symbol(d, code_tree);

    switch (sym) {
      case 16:
        /* copy previous code length 3-6 times (read 2 bits) */
        var prev = lengths[num - 1];
        for (length = tinf_read_bits(d, 2, 3); length; --length) {
          lengths[num++] = prev;
        }
        break;
      case 17:
        /* repeat code length 0 for 3-10 times (read 3 bits) */
        for (length = tinf_read_bits(d, 3, 3); length; --length) {
          lengths[num++] = 0;
        }
        break;
      case 18:
        /* repeat code length 0 for 11-138 times (read 7 bits) */
        for (length = tinf_read_bits(d, 7, 11); length; --length) {
          lengths[num++] = 0;
        }
        break;
      default:
        /* values 0-15 represent the actual code lengths */
        lengths[num++] = sym;
        break;
    }
  }

  /* build dynamic trees */
  tinf_build_tree(lt, lengths, 0, hlit);
  tinf_build_tree(dt, lengths, hlit, hdist);
}

/* ----------------------------- *
 * -- block inflate functions -- *
 * ----------------------------- */

/* given a stream and two trees, inflate a block of data */
function tinf_inflate_block_data(d, lt, dt) {
  while (1) {
    var sym = tinf_decode_symbol(d, lt);

    /* check for end of block */
    if (sym === 256) {
      return TINF_OK;
    }

    if (sym < 256) {
      d.dest[d.destLen++] = sym;
    } else {
      var length, dist, offs;
      var i;

      sym -= 257;

      /* possibly get more bits from length code */
      length = tinf_read_bits(d, length_bits[sym], length_base[sym]);

      dist = tinf_decode_symbol(d, dt);

      /* possibly get more bits from distance code */
      offs = d.destLen - tinf_read_bits(d, dist_bits[dist], dist_base[dist]);

      /* copy match */
      for (i = offs; i < offs + length; ++i) {
        d.dest[d.destLen++] = d.dest[i];
      }
    }
  }
}

/* inflate an uncompressed block of data */
function tinf_inflate_uncompressed_block(d) {
  var length, invlength;
  var i;
  
  /* unread from bitbuffer */
  while (d.bitcount > 8) {
    d.sourceIndex--;
    d.bitcount -= 8;
  }

  /* get length */
  length = d.source[d.sourceIndex + 1];
  length = 256 * length + d.source[d.sourceIndex];

  /* get one's complement of length */
  invlength = d.source[d.sourceIndex + 3];
  invlength = 256 * invlength + d.source[d.sourceIndex + 2];

  /* check length */
  if (length !== (~invlength & 0x0000ffff))
    return TINF_DATA_ERROR;

  d.sourceIndex += 4;

  /* copy block */
  for (i = length; i; --i)
    d.dest[d.destLen++] = d.source[d.sourceIndex++];

  /* make sure we start next block on a byte boundary */
  d.bitcount = 0;

  return TINF_OK;
}

/* inflate stream from source to dest */
function tinf_uncompress(source, dest) {
  var d = new Data(source, dest);
  var bfinal, btype, res;

  do {
    /* read final block flag */
    bfinal = tinf_getbit(d);

    /* read block type (2 bits) */
    btype = tinf_read_bits(d, 2, 0);

    /* decompress block */
    switch (btype) {
      case 0:
        /* decompress uncompressed block */
        res = tinf_inflate_uncompressed_block(d);
        break;
      case 1:
        /* decompress block with fixed huffman trees */
        res = tinf_inflate_block_data(d, sltree, sdtree);
        break;
      case 2:
        /* decompress block with dynamic huffman trees */
        tinf_decode_trees(d, d.ltree, d.dtree);
        res = tinf_inflate_block_data(d, d.ltree, d.dtree);
        break;
      default:
        res = TINF_DATA_ERROR;
    }

    if (res !== TINF_OK)
      throw new Error('Data error');

  } while (!bfinal);

  if (d.destLen < d.dest.length) {
    if (typeof d.dest.slice === 'function')
      return d.dest.slice(0, d.destLen);
    else
      return d.dest.subarray(0, d.destLen);
  }
  
  return d.dest;
}

/* -------------------- *
 * -- initialization -- *
 * -------------------- */

/* build fixed huffman trees */
tinf_build_fixed_trees(sltree, sdtree);

/* build extra bits and base tables */
tinf_build_bits_base(length_bits, length_base, 4, 3);
tinf_build_bits_base(dist_bits, dist_base, 2, 1);

/* fix a special case */
length_bits[28] = 0;
length_base[28] = 258;


