// Google's OAuth 2.0 authorization-code flow, which is the only one that gets a
// Workspace domain in without anybody typing anything.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY NOT THE DEVICE FLOW, GIVEN github-auth.mjs USES IT
//
// Device flow was chosen for GitHub because GitHub hands back a
// `verification_uri_complete` — the URL with the user code ALREADY IN IT — so
// the person clicks one button and never reads an eight-character code. That is
// the whole reason it satisfied "people should be able to use the app without
// having to enter some long code."
//
// GOOGLE DOES NOT RETURN `verification_url_complete`. Its device flow shows a
// code and makes the person type it at google.com/device. Copying the GitHub
// shape here would therefore reintroduce the exact friction the GitHub work
// removed, and would ALSO still need a client secret, because Google's device
// flow requires one. Device flow costs more and buys less.
//
// So: the ordinary web flow, with the redirect landing back on the hub. The hub
// is a real server at a fixed HTTPS origin, so it can hold a client secret and
// register a callback — the two things a desktop app cannot do. The desktop app
// still never talks to Google; it opens a browser and polls the hub, which is
// the same two-call shape `desktop/github-signin.js` already drives.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ THIS FILE RUNS ON THE HUB, NOT IN THE DESKTOP APP — same as its GitHub
// sibling, for the same three reasons written out at the top of that file. The
// one that is sharper here: the client SECRET is real and confidential, and a
// desktop app that held it would be publishing it.

/** Google's endpoints. Constants rather than inline strings so the tests can
 *  assert what is being called without matching on a URL in three places. */
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * The scopes requested.
 *
 * ⚠️ DELIBERATELY THE NARROWEST THING THAT WORKS. `openid email` yields a
 * subject id, a verified email address and — for Workspace accounts — the `hd`
 * claim this hub gates on. It does not grant Drive, Calendar, Gmail or contacts.
 *
 * `profile` is NOT requested. It would add a display name and an avatar, which
 * the board would use for exactly nothing that the email does not already say,
 * and it widens the consent screen for every person who only wanted to sign in.
 */
export const SCOPES = "openid email";

/** The two spellings Google uses for `iss`. Both are legitimate and which one
 *  arrives is not something to depend on, so both are accepted and anything
 *  else is refused. */
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

/** Small allowance for clock skew between this box and Google, in seconds. An
 *  `exp` check with no slack rejects a token that is valid everywhere else the
 *  moment the hub's clock runs a second fast. */
const SKEW_S = 120;

/**
 * Every network call in this file goes through here, so that the timeout, the
 * JSON handling and the failure shape are decided once.
 *
 * ⚠️ NEVER THROWS FOR A NETWORK REASON — it answers `{ ok: false, error }`,
 * exactly as its GitHub sibling does and for the same reason: the caller is an
 * HTTP handler that must not 500 because Google is having an afternoon.
 */
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
      return { ok: false, error: `Google answered ${res.status} with something that is not JSON: ${text.slice(0, 200)}` };
    }
    return { ok: true, status: res.status, body };
  } catch (err) {
    if (err && err.name === "AbortError") return { ok: false, error: "Google did not answer in 10 seconds" };
    return { ok: false, error: `could not reach Google: ${err && err.message ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Step one: where to send the browser.
 *
 * `state` is the hub's pairing code. It is 32 random bytes minted per attempt,
 * single-use, and looked up on the way back — which is what makes this flow
 * CSRF-proof without a second cookie. A callback carrying a state the hub did
 * not mint is a callback the hub never started.
 *
 * ⚠️ `hd` HERE IS A UI HINT AND NOTHING MORE. It tells the account chooser to
 * offer Workspace accounts on that domain first. It does not stop anybody
 * signing in with a personal account, it is not signed, and it is not a
 * security control. The control is the `hd` CLAIM checked in `readIdToken`.
 */
export function authorizeUrl({ clientId, redirectUri, state, domain = "", scopes = SCOPES } = {}) {
  const p = new URLSearchParams({
    client_id: String(clientId),
    redirect_uri: String(redirectUri),
    response_type: "code",
    scope: scopes,
    state: String(state),
    // Nothing here calls Google again on anybody's behalf, so there is no
    // refresh token to want. `online` is what says so.
    access_type: "online",
    // Without this, a person already signed into one Google account is silently
    // signed in as that one — which on a shared machine is the wrong person,
    // with no screen anywhere that let them say so.
    prompt: "select_account",
  });
  if (domain) p.set("hd", String(domain));
  return `${AUTH_URL}?${p.toString()}`;
}

/**
 * Step two: trade the code for an id token.
 *
 * Returns `{ ok: true, idToken }` or `{ ok: false, error }`.
 *
 * ⚠️ FORM-ENCODED, NOT JSON. Google's token endpoint answers a JSON body but
 * only accepts `application/x-www-form-urlencoded`. Sending JSON returns a 400
 * `invalid_request` whose description does not mention the content type, which
 * is a good half hour of looking at the wrong things.
 */
export async function exchangeCode({ clientId, clientSecret, code, redirectUri, fetchImpl } = {}) {
  if (!clientId || !clientSecret) return { ok: false, error: "Google sign-in is not configured" };
  if (!code) return { ok: false, error: "Google did not return a code" };

  const r = await call(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: String(clientId),
        client_secret: String(clientSecret),
        code: String(code),
        // Sent again, and it must be byte-identical to the one in step one.
        // Google compares them, and a trailing slash is a mismatch.
        redirect_uri: String(redirectUri),
        grant_type: "authorization_code",
      }).toString(),
    },
    fetchImpl,
  );
  if (!r.ok) return r;

  const b = r.body || {};
  if (b.error) {
    const desc = b.error_description ? String(b.error_description) : "";
    if (b.error === "redirect_uri_mismatch") {
      // Named, because the message Google sends says only "redirect_uri_mismatch"
      // and the cause is always the same two places disagreeing.
      return { ok: false, error: "Google refused the callback URL — ZEVET_GOOGLE_REDIRECT must match the Authorised redirect URI on the OAuth client exactly" };
    }
    return { ok: false, error: desc ? `${desc} (${b.error})` : `Google said: ${b.error}` };
  }
  if (!b.id_token) return { ok: false, error: "Google exchanged the code but returned no id token" };
  return { ok: true, idToken: String(b.id_token) };
}

/**
 * Step three: who is this, and are they on the right domain?
 *
 * Returns `{ ok: true, provider: "google", id, login, display, hd }` — the
 * shape `accounts.mjs` expects from any provider — or `{ ok: false, error }`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ THE SIGNATURE IS NOT VERIFIED, AND THAT IS CORRECT HERE. READ THIS BEFORE
 * "FIXING" IT.
 *
 * This token was not presented by a client. It was fetched by this process, in
 * `exchangeCode` above, over TLS, directly from `oauth2.googleapis.com`, in the
 * same function call. Nothing untrusted has touched it in between. OpenID
 * Connect Core §3.1.3.7 says exactly this case out loud: a token received by
 * direct communication with the token endpoint MAY use TLS server validation in
 * place of checking the signature.
 *
 * So verifying it would mean fetching Google's JWKS, caching it, handling key
 * rotation and adding an RS256 implementation — to re-prove a fact TLS already
 * proved, in a file whose whole point is that it is small enough to read.
 *
 * ⚠️ THE CONDITION IS "WE FETCHED IT OURSELVES". If an id token ever arrives
 * here from ANYWHERE else — posted by the desktop app, forwarded by a proxy,
 * read out of a cookie — this function is no longer safe for it and the JWKS
 * verification becomes mandatory. `iss`, `aud`, `exp` and `hd` are all claims
 * inside a blob anybody can mint if nobody checks who signed it.
 */
export function readIdToken(idToken, { clientId, domain = "", now = () => Date.now() } = {}) {
  const claims = decodeClaims(idToken);
  if (!claims) return { ok: false, error: "Google returned an id token that could not be read" };

  if (!ISSUERS.has(String(claims.iss || ""))) {
    return { ok: false, error: `that token was not issued by Google (iss: ${claims.iss || "missing"})` };
  }
  // A token minted for a DIFFERENT OAuth client is a valid Google token and is
  // still not ours. Skipping this is the classic id-token confusion bug.
  if (String(claims.aud || "") !== String(clientId)) {
    return { ok: false, error: "that token was issued for a different application" };
  }
  const nowS = Math.floor(now() / 1000);
  if (!claims.exp || nowS > Number(claims.exp) + SKEW_S) {
    return { ok: false, error: "that sign-in expired — start again" };
  }

  const email = String(claims.email || "").toLowerCase();
  const sub = String(claims.sub || "");
  if (!email || !sub) return { ok: false, error: "Google did not say who you are" };
  // `email_verified` false means Google is passing on an address it has not
  // confirmed the person controls. Admitting on it would make the allowlist
  // decidable by whoever can type an address.
  if (claims.email_verified !== true && String(claims.email_verified) !== "true") {
    return { ok: false, error: "that Google account's email address is not verified" };
  }

  const hd = claims.hd ? String(claims.hd).toLowerCase() : "";
  if (domain && hd !== String(domain).toLowerCase()) {
    // ⚠️ THE DOMAIN CHECK IS `hd`, NEVER THE EMAIL SUFFIX. `hd` is asserted by
    // Google and is present only on Workspace accounts it administers.
    // `email.endsWith("@domain")` is asserted by the account holder, and a
    // personal Google account that has verified a mailbox at the domain would
    // pass it — which is how a domain gate becomes no gate at all.
    return {
      ok: false,
      error: hd
        ? `${email} is on ${hd}, not ${domain}`
        : `${email} is not a ${domain} Google Workspace account — a personal Google account with that address is not enough`,
    };
  }

  return {
    ok: true,
    provider: "google",
    id: sub,
    login: email,
    display: email,
    hd,
  };
}

/** The claims, or null. Base64url, no padding, and the payload is the second of
 *  three segments. Deliberately not a JWT library: nothing here verifies a
 *  signature (see above), so a library would contribute a dependency and a
 *  split. */
function decodeClaims(idToken) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const claims = JSON.parse(json);
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}
