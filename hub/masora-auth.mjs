// Sign-in from Masora: a signed assertion that this person belongs to this Masora workspace.
// Contract: masora2 docs/contracts/cross_app_context.md, "Hub sign-in". HS256 over the secret Masora's
// API and this hub share (ZEVET_MASORA_SECRET here, ZEVET_HUB_SECRET there); node:crypto only.
import { createHmac, timingSafeEqual, createPrivateKey, createPublicKey, createHash, randomBytes, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";

const b64 = (s) => Buffer.from(s, "base64url");
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

/* ── The reverse direction: the hub vouches for a person to Masora (docs/specs/2026-10-07-single-sign-in.md,
 * "Hub -> Masora sign-in"). Ed25519 (JWS alg EdDSA), NOT the shared HMAC secret above: Masora holds only the public
 * key, so nothing Masora stores can mint one, and an assertion can never be reflected into /auth/masora (different
 * key, alg, typ and aud). */
export const MASORA_ASSERT_TTL_S = 60;
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/** ZEVET_MASORA_ASSERT_KEY (base64 or base64url of the 32-byte Ed25519 seed) -> a KeyObject; null when unset or not
 *  exactly 32 bytes, so a typo turns the route off rather than signing with something else. */
export function masoraAssertKey(raw) {
  const s = String(raw || "").trim();
  if (!/^[A-Za-z0-9+/_-]+=*$/.test(s)) return null;
  const seed = Buffer.from(s, "base64");
  if (seed.length !== 32) return null;
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
}

/** A single-use (jti), 60-second, audience-bound assertion carrying only the emails the provider verified at the
 *  sign-in behind this session (`Accounts#masoraClaims`). Never logged. */
export function mintMasoraAssertion(key, { sub, provider, emails }, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const claims = { iss: "zevet-hub", aud: "masora", typ: "masora_hub_assertion", iat, exp: iat + MASORA_ASSERT_TTL_S,
    jti: randomBytes(16).toString("hex"), sub, provider, emails };
  const input = `${enc({ alg: "EdDSA", typ: "JWT" })}.${enc(claims)}`;
  return `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
}

/** `{claims}` for a valid assertion, `{error}` otherwise. Pins alg (no "none", no RS/HS confusion), the typ and aud
 *  Masora mints, expiry, and the fields the hub needs; says nothing about replay (see `replayGuard`). */
export function verifyAssertion(token, secret, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (!secret || parts.length !== 3) return { error: "malformed" };
  let header, claims;
  try {
    header = JSON.parse(b64(parts[0]).toString());
    claims = JSON.parse(b64(parts[1]).toString());
  } catch {
    return { error: "malformed" };
  }
  if (!header || header.alg !== "HS256") return { error: "malformed" };
  const want = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  const got = b64(parts[2]);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { error: "bad signature" };
  if (!claims || claims.typ !== "zevet_hub_assertion" || claims.aud !== "zevet-hub") return { error: "wrong token" };
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return { error: "expired" };
  for (const k of ["sub", "email", "wid", "workspace", "jti"]) if (typeof claims[k] !== "string" || !claims[k]) return { error: "incomplete" };
  if (!claims.email.includes("@")) return { error: "incomplete" };
  return { claims };
}

/** Single use: `take(jti, expSeconds)` is true the first time, false on a replay. Entries drop when the token would
 *  have expired anyway. With `file` the set survives a restart (atomic rewrite on every take; pruned on load). */
export function replayGuard(now = () => Date.now(), file = null) {
  const seen = new Map();
  const live = () => { for (const [k, e] of seen) if (e * 1000 <= now()) seen.delete(k); };
  if (file) {
    try {
      for (const [k, e] of Object.entries(JSON.parse(readFileSync(file, "utf8")))) if (typeof e === "number") seen.set(k, e);
      live();
    } catch (err) {
      if (err.code !== "ENOENT") console.error(`zevet: replay file ${file} unreadable (${err.message}); starting empty`);
    }
  }
  return {
    take(jti, exp) {
      live();
      if (seen.has(jti)) return false;
      seen.set(jti, exp);
      if (file) {
        try {
          mkdirSync(path.dirname(file), { recursive: true });
          const tmp = `${file}.${process.pid}.tmp`;
          writeFileSync(tmp, JSON.stringify(Object.fromEntries(seen)), { mode: 0o600 });
          renameSync(tmp, file);
        } catch (err) {
          console.error(`zevet: could not persist replay file ${file} (${err.message}); replay protection is in-memory only`);
        }
      }
      return true;
    },
  };
}

/* ── Masora -> hub bridge (docs/specs/forum-bridge-protocol.md). Ed25519 (EdDSA); Masora holds the private key, the hub
 * only this public one. A different key, alg, typ and aud from the HS256 sign-in assertion above, so neither is
 * accepted where the other is expected. Bound to one request by `req`. */
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
export const BRIDGE_MAX_TTL_S = 60;
export const BRIDGE_SKEW_S = 30;

/** ZEVET_BRIDGE_PUBLIC_KEY (base64 or base64url of the raw 32-byte public key) -> KeyObject, or null. */
export function bridgePublicKey(raw) {
  const s = String(raw || "").trim();
  if (!/^[A-Za-z0-9+/_-]+=*$/.test(s)) return null;
  const k = Buffer.from(s, "base64");
  if (k.length !== 32) return null;
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519, k]), format: "der", type: "spki" });
}

/** base64url(sha256(METHOD + LF + PATH_WITH_QUERY + LF + RAW_BODY)) */
export const bridgeReqHash = (method, pathAndQuery, rawBody) =>
  createHash("sha256").update(`${String(method).toUpperCase()}
${pathAndQuery}
${rawBody}`).digest("base64url");

/** `{claims}` or `{error}`. Says nothing about replay (see `replayGuard`). */
export function verifyBridge(token, pub, { method, path: pq, body = "" }, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return { error: "malformed" };
  let header, claims;
  try {
    header = JSON.parse(b64(parts[0]).toString());
    claims = JSON.parse(b64(parts[1]).toString());
  } catch {
    return { error: "malformed" };
  }
  if (!header || header.alg !== "EdDSA") return { error: "bad alg" };
  const sig = b64(parts[2]);
  if (sig.length !== 64 || !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), pub, sig)) return { error: "bad signature" };
  if (!claims || claims.typ !== "zevet_bridge" || claims.aud !== "zevet-hub-bridge" || claims.iss !== "masora") return { error: "wrong token" };
  if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp)) return { error: "incomplete" };
  if (claims.exp - claims.iat > BRIDGE_MAX_TTL_S || claims.exp <= claims.iat) return { error: "window too large" };
  if (claims.exp * 1000 <= now) return { error: "expired" };
  if (claims.iat * 1000 > now + BRIDGE_SKEW_S * 1000) return { error: "from the future" };
  for (const k of ["wid", "email", "jti", "req"]) if (typeof claims[k] !== "string" || !claims[k]) return { error: "incomplete" };
  if (!claims.email.includes("@")) return { error: "incomplete" };
  const want = Buffer.from(bridgeReqHash(method, pq, body)), got = Buffer.from(claims.req);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { error: "request mismatch" };
  return { claims };
}

/** "wid=team,wid=team" -> Map. A team named here is bound to that Masora workspace; the slug must already exist. */
export function parseTeamMap(raw) {
  const m = new Map();
  for (const pair of String(raw || "").split(/[\s,]+/)) {
    const [wid, slug] = pair.split("=");
    if (wid && slug) m.set(wid.trim().toLowerCase(), slug.trim());
  }
  return m;
}
