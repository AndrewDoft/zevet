// Sign-in from Masora: a signed assertion that this person belongs to this Masora workspace.
// Contract: masora2 docs/contracts/cross_app_context.md, "Hub sign-in". HS256 over the secret Masora's
// API and this hub share (ZEVET_MASORA_SECRET here, ZEVET_HUB_SECRET there); node:crypto only.
import { createHmac, timingSafeEqual } from "node:crypto";

const b64 = (s) => Buffer.from(s, "base64url");

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
