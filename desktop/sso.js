// Single sign-in on this computer: <family dir>/sso.json is the last hub
// sign-in or sign-out any app in the family made (Zevet, Zevet Voice; Masora
// later). Design: docs/specs/2026-10-07-single-sign-in.md.
//
// The file is AES-256-GCM under a key derived (HKDF-SHA256, info
// "zevet-sso/v1") from family.key, the user-only pairing secret, so the hub
// session token is never on disk in plain text and an envelope written without
// that key fails authentication and is ignored. Byte-compatible with zevet-voice
// masora_dictation/sso.py (each suite opens a fixture the other sealed).
//
//   envelope {v:1, alg:"A256GCM", nonce:b64, ct:b64(ciphertext||tag)}
//   payload  {v:1, state:"signed_in"|"signed_out", hub, issued_at (ms), by,
//             token, login, provider, team, owner, secret}   (signed_in only)
//
// `sync` never throws and never logs a token.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const kit = require("@masora/desktop-kit");

const FILE = "sso.json";
const KEY_FILE = "family.key";
const INFO = "zevet-sso/v1";
const SKEW_MS = 60_000; // an envelope stamped further in the future than this is not trusted
const RETRY_MS = 30_000; // hub unreachable while checking a token: ask again after this
const norm = (u) => String(u || "").trim().replace(/\/+$/, "");

/** family.key as bytes when well formed (64 hex) and, on POSIX, ours and not group/world readable. */
function readKey(dir, platform = process.platform) {
  const file = path.join(dir, KEY_FILE);
  try {
    if (platform !== "win32") {
      const st = fs.statSync(file);
      if (st.uid !== process.getuid() || st.mode & 0o077) return null;
    }
    const k = fs.readFileSync(file, "ascii").trim();
    return /^[0-9a-f]{64}$/i.test(k) ? Buffer.from(k, "ascii") : null;
  } catch {
    return null;
  }
}

/** Create family.key when no app has yet (Masora keeps an existing one): exclusive create, restricted while still
 *  empty, so two apps starting at once cannot end up with two keys. Same format as kit.ensureKey. */
function ensureKey(dir, { restrict = kit.restrictToCurrentUser } = {}) {
  const have = readKey(dir);
  if (have) return have;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, KEY_FILE);
  try {
    fs.closeSync(fs.openSync(file, "wx", 0o600));
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    for (let i = 0; i < 20; i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); // another app is between create and write
      const k = readKey(dir);
      if (k) return k;
    }
    throw new Error("family.key exists but is not usable");
  }
  try {
    restrict(file);
    fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), "ascii");
  } catch (err) {
    try { fs.unlinkSync(file); } catch { /* gone */ }
    throw err;
  }
  return readKey(dir);
}

const aeadKey = (key) => Buffer.from(crypto.hkdfSync("sha256", key, Buffer.alloc(0), INFO, 32));

function seal(key, payload, nonce = crypto.randomBytes(12)) {
  const c = crypto.createCipheriv("aes-256-gcm", aeadKey(key), nonce);
  c.setAAD(Buffer.from(INFO));
  const ct = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final(), c.getAuthTag()]);
  return { v: 1, alg: "A256GCM", nonce: nonce.toString("base64"), ct: ct.toString("base64") };
}

function unseal(key, env) {
  try {
    if (!env || env.v !== 1 || env.alg !== "A256GCM") return null;
    const nonce = Buffer.from(env.nonce, "base64");
    const all = Buffer.from(env.ct, "base64");
    if (nonce.length !== 12 || all.length < 16) return null;
    const d = crypto.createDecipheriv("aes-256-gcm", aeadKey(key), nonce);
    d.setAAD(Buffer.from(INFO));
    d.setAuthTag(all.subarray(all.length - 16));
    const out = JSON.parse(Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString("utf8"));
    return out && typeof out === "object" && !Array.isArray(out) ? out : null;
  } catch {
    return null;
  }
}

/** {exists, payload}: payload is null unless authentic. */
function read(dir) {
  const file = path.join(dir, FILE);
  if (!fs.existsSync(file)) return { exists: false, payload: null };
  const key = readKey(dir);
  return { exists: true, payload: key ? unseal(key, kit.readJson(file)) : null };
}

function publish(dir, state, hub, fields = {}, now = Date.now()) {
  const extra = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  const payload = { v: 1, state, hub: norm(hub), issued_at: now, by: "zevet", ...extra };
  const file = path.join(dir, FILE);
  kit.writeJsonAtomic(file, seal(ensureKey(dir), payload));
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  return payload;
}

/** The hub's word on a token: its whoami body for a live personal session, false when refused, null when the hub
 *  could not be reached. */
async function whoami(fetchImpl, hub, token) {
  let res;
  try {
    res = await fetchImpl(`${norm(hub)}/auth/whoami`, { headers: { "x-zevet-token": token }, signal: AbortSignal.timeout(10000) });
  } catch {
    return null;
  }
  if (res.status >= 500) return null;
  const body = await res.json().catch(() => null);
  return res.status === 200 && body && body.ok && typeof body.login === "string" && body.login ? body : false;
}

/**
 * One app's side of single sign-in. `session()` is this app's current hub session ({hub, token, login, provider,
 * team, owner, secret} or null); `adopt(payload, who)` stores a session another app published (who = whoami body);
 * `endSession()` signs this app out locally without publishing. `hub()` is this app's own hub: a session for any
 * other hub is never adopted, so a token is only ever sent to the origin it was minted by.
 */
class Sso {
  constructor({ dir, hub, session, adopt, endSession, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), log = () => {} }) {
    Object.assign(this, { dir, hub, session, adopt, endSession, fetchImpl, now, log });
    this.seen = 0; // issued_at of the newest envelope applied or written here
    this.retryAt = 0;
    this.busy = false;
  }

  /** Publish this app's sign-in (fields from session()) or sign-out. Never throws: the sign-in itself stands. */
  publish(state) {
    try {
      const s = state === "signed_in" ? this.session() : null;
      if (state === "signed_in" && !(s && s.token)) return null;
      const { hub: _h, ...fields } = s || {};
      const p = publish(this.dir, state, this.hub(), fields, this.now());
      this.seen = p.issued_at;
      return p;
    } catch (err) {
      this.log(`sso: could not publish the ${state} (${err.message})`);
      return null;
    }
  }

  /** Apply sso.json when newer than anything seen. Resolves "signed_in" | "signed_out" | "published" | null. */
  async sync() {
    if (this.busy) return null;
    this.busy = true;
    try {
      return await this.#sync();
    } catch (err) {
      this.log(`sso: sync failed (${err.message})`);
      return null;
    } finally {
      this.busy = false;
    }
  }

  async #sync() {
    const { exists, payload: p } = read(this.dir);
    const mine = this.session();
    if (!exists) {
      if (mine && mine.token) return this.publish("signed_in") ? "published" : null; // seed it for the others
      return null;
    }
    const at = p && p.issued_at;
    if (!p || !Number.isInteger(at) || at <= this.seen || at > this.now() + SKEW_MS) return null;
    if (norm(p.hub) !== norm(this.hub())) {
      this.seen = at;
      return null;
    }
    if (p.state === "signed_out") {
      this.seen = at;
      if (!(mine && mine.token)) return null;
      this.log(`sso: signed out by ${p.by || "another app"}`);
      await this.endSession();
      return "signed_out";
    }
    if (p.state !== "signed_in" || typeof p.token !== "string" || !p.token || (mine && mine.token === p.token)) {
      this.seen = at;
      return null;
    }
    if (this.now() < this.retryAt) return null;
    const who = await whoami(this.fetchImpl, this.hub(), p.token);
    if (who === null) {
      this.retryAt = this.now() + RETRY_MS;
      return null;
    }
    this.seen = at;
    if (who === false) {
      this.log("sso: ignored a family sign-in the hub does not accept");
      return null;
    }
    await this.adopt(p, who);
    this.log(`sso: signed in by ${p.by || "another app"}`);
    return "signed_in";
  }
}

module.exports = { Sso, readKey, ensureKey, seal, unseal, read, publish, whoami, FILE, INFO };
