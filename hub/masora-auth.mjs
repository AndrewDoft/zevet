// Sign-in from Masora: a signed assertion that this person belongs to this Masora workspace.
// Contract: masora2 docs/contracts/cross_app_context.md, "Hub sign-in". HS256 over the secret Masora's
// API and this hub share (ZEVET_MASORA_SECRET here, ZEVET_HUB_SECRET there); node:crypto only.
import { createHmac, timingSafeEqual, createPrivateKey, randomBytes, sign } from "node:crypto";

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
 *  have expired anyway, so the map is bounded by one TTL of sign-ins. */
export function replayGuard(now = () => Date.now()) {
  const seen = new Map();
  return {
    take(jti, exp) {
      for (const [k, e] of seen) if (e * 1000 <= now()) seen.delete(k);
      if (seen.has(jti)) return false;
      seen.set(jti, exp);
      return true;
    },
  };
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
