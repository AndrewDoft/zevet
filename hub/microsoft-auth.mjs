// Microsoft (Entra ID + personal Microsoft accounts) OpenID Connect, authorization-code
// flow, tenant "common". The twin of google-auth.mjs — read that file's header first; the
// shape (start / callback / finish, pairing code as `state`, id token fetched by THIS
// process over TLS) is identical and is not re-argued here. Only the differences are.
//
// ⚠️ THIS FILE RUNS ON THE HUB, NOT IN THE DESKTOP APP, for Google's reasons: the client
// secret is real and confidential.

export const AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
export const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

/** `openid email` and nothing else: a subject, an email, the tenant. No Graph access. */
export const SCOPES = "openid email";

const SKEW_S = 120;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function call(url, init, fetchImpl) {
  const f = typeof fetchImpl === "function" ? fetchImpl : fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await f(url, { ...init, signal: ac.signal });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, error: `Microsoft answered ${res.status} with something that is not JSON: ${text.slice(0, 200)}` };
    }
    return { ok: true, status: res.status, body };
  } catch (err) {
    if (err && err.name === "AbortError") return { ok: false, error: "Microsoft did not answer in 10 seconds" };
    return { ok: false, error: `could not reach Microsoft: ${err && err.message ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Where to send the browser. `state` is the hub's pairing code (CSRF, single use);
 * `nonce` is minted per attempt too and must come back inside the id token.
 * `prompt=select_account` for Google's reason: a shared machine must be able to say who.
 */
export function authorizeUrl({ clientId, redirectUri, state, nonce, scopes = SCOPES } = {}) {
  const p = new URLSearchParams({
    client_id: String(clientId),
    redirect_uri: String(redirectUri),
    response_type: "code",
    response_mode: "query",
    scope: scopes,
    state: String(state),
    prompt: "select_account",
  });
  if (nonce) p.set("nonce", String(nonce));
  return `${AUTH_URL}?${p.toString()}`;
}

/** Trade the code for an id token. Form-encoded, like Google's. */
export async function exchangeCode({ clientId, clientSecret, code, redirectUri, fetchImpl } = {}) {
  if (!clientId || !clientSecret) return { ok: false, error: "Microsoft sign-in is not configured" };
  if (!code) return { ok: false, error: "Microsoft did not return a code" };

  const r = await call(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: String(clientId),
        client_secret: String(clientSecret),
        code: String(code),
        redirect_uri: String(redirectUri),
        grant_type: "authorization_code",
        scope: SCOPES,
      }).toString(),
    },
    fetchImpl,
  );
  if (!r.ok) return r;

  const b = r.body || {};
  if (b.error) {
    const desc = b.error_description ? String(b.error_description).split(/\r?\n/)[0] : "";
    if (/AADSTS50011/.test(String(b.error_description || ""))) {
      return { ok: false, error: "Microsoft refused the callback URL — ZEVET_MICROSOFT_REDIRECT must match a Redirect URI on the app registration exactly" };
    }
    return { ok: false, error: desc ? `${desc} (${b.error})` : `Microsoft said: ${b.error}` };
  }
  if (!b.id_token) return { ok: false, error: "Microsoft exchanged the code but returned no id token" };
  return { ok: true, idToken: String(b.id_token) };
}

/**
 * Who is this?  `{ ok: true, provider: "microsoft", id, login, display, emails, tid }` or `{ ok: false, error }`.
 *
 * ⚠️ THE SIGNATURE IS NOT VERIFIED — same trust path as google-auth.mjs `readIdToken` (OIDC
 * Core §3.1.3.7: a token received straight from the token endpoint over TLS). Same
 * condition too: the moment an id token reaches here from anywhere but `exchangeCode`,
 * JWKS verification becomes mandatory.
 *
 * Differences from Google, each a trap:
 *  - tenant "common" means `iss` carries the token's own tenant id, so it is checked as
 *    `https://login.microsoftonline.com/<tid>/v2.0` with `tid` a GUID from the same token —
 *    a token whose iss and tid disagree is refused.
 *  - Microsoft's `email` is NOT verified by default (nOAuth: an Entra tenant admin can set
 *    anybody's mail attribute to anything). It is evidence ONLY when `xms_edov` says the
 *    domain owner was verified. Otherwise `emails` is empty — no auto-link, no admission by
 *    an email invite — and the login is namespaced `ms:` so it cannot equal a Google or
 *    GitHub login that carries real proof.
 *  - `sub` is pairwise per app, stable, and the identity key (unique only within "microsoft").
 *  - No `hd`; see DECISIONS.md — `tid` is a tenant, not a domain, so there is no domain door.
 */
export function readIdToken(idToken, { clientId, nonce = "", now = () => Date.now() } = {}) {
  const claims = decodeClaims(idToken);
  if (!claims) return { ok: false, error: "Microsoft returned an id token that could not be read" };

  const tid = String(claims.tid || "");
  if (!GUID.test(tid) || String(claims.iss || "") !== `https://login.microsoftonline.com/${tid}/v2.0`) {
    return { ok: false, error: `that token was not issued by Microsoft (iss: ${claims.iss || "missing"})` };
  }
  if (String(claims.aud || "") !== String(clientId)) {
    return { ok: false, error: "that token was issued for a different application" };
  }
  const nowS = Math.floor(now() / 1000);
  if (!claims.exp || nowS > Number(claims.exp) + SKEW_S) {
    return { ok: false, error: "that sign-in expired — start again" };
  }
  // The nonce this attempt minted must come back. Missing counts as wrong.
  if (nonce && String(claims.nonce || "") !== String(nonce)) {
    return { ok: false, error: "that sign-in does not belong to this attempt — start again" };
  }

  const sub = String(claims.sub || "");
  if (!sub) return { ok: false, error: "Microsoft did not say who you are" };

  const mail = String(claims.email || "").trim().toLowerCase();
  const upn = String(claims.preferred_username || "").trim().toLowerCase();
  const name = mail || upn;
  const edov = claims.xms_edov === true || claims.xms_edov === 1 || ["true", "1"].includes(String(claims.xms_edov).toLowerCase());
  const verified = Boolean(mail && mail.includes("@") && edov);

  if (!verified && !name) return { ok: false, error: "Microsoft did not say who you are" };

  return {
    ok: true,
    provider: "microsoft",
    id: sub,
    login: verified ? mail : `ms:${name}`,
    display: name || sub,
    emails: verified ? [mail] : [],
    tid,
    hd: "",
  };
}

function decodeClaims(idToken) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}
