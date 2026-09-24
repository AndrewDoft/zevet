// GitHub's OAuth device flow, which is the only one a desktop app should use.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY DEVICE FLOW AND NOT THE WEB FLOW
//
// The web flow (redirect to github.com, come back to a callback URL) needs a
// CLIENT SECRET to exchange the code. A desktop app cannot hold a secret — it
// is on the user's disk, and "confidential client" stops being true the moment
// you ship it. The usual workaround is to put the exchange on a server, which
// means the hub, which means a public callback URL and a browser round trip
// through it.
//
// Device flow needs NO client secret. The app asks GitHub for a code, the user
// authorises it in their own browser, the app polls until GitHub says yes. It
// is the flow GitHub's own CLI uses, for the same reason.
//
// And it is the one that answers what Andrew actually asked for — "people
// should be able to use the app without having to enter some long code."
// GitHub hands back a `verification_uri_complete` with the user code ALREADY IN
// THE URL, so the app opens a browser on it and the person clicks one green
// button. The 8-character code is shown anyway, because the browser might open
// on the wrong profile, or not open at all.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ THIS FILE RUNS ON THE HUB, NOT IN THE DESKTOP APP.
//
// The desktop app talks only to the hub; the hub talks to GitHub. That is one
// extra hop and it buys three things:
//
//   • The client id lives in one place. Rotating the OAuth app does not need a
//     new zevet release on three machines.
//   • The allowlist is enforced somewhere the user cannot edit. If the app
//     called GitHub directly it would hold its own access token and could
//     simply lie to the hub about who it is.
//   • GitHub is reached from one IP that is already in the deployment, rather
//     than from every teammate's laptop and whatever network it is on.
//
// The cost is that the hub sees each person's GitHub login and, for a moment,
// their access token. It does NOT store the access token — see accounts.mjs.

/** GitHub's endpoints. Constants rather than inline strings so the tests can
 *  assert what is being called without matching on a URL in three places. */
export const DEVICE_CODE_URL = "https://github.com/login/device/code";
export const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const USER_URL = "https://api.github.com/user";

/**
 * The scopes requested.
 *
 * ⚠️ DELIBERATELY THE NARROWEST THING THAT WORKS. `read:user` reads the public
 * profile — a login and a numeric id — and nothing else. It does not grant
 * access to code, to private repositories, to organisations or to email.
 *
 * It is tempting to ask for `repo` now, because the ORIGINAL request that
 * started this ("a way to edit the github repos it can access... that might
 * mean we need to build in github oauth") was about browsing repositories. It
 * is not asked for, because `repo` is read-write access to every private
 * repository the person can see, it would be requested from everyone including
 * people who only ever wanted to sign in, and nothing in zevet uses it yet. The
 * day something does, it is one string here and a re-authorisation prompt —
 * which is the correct moment to ask, rather than years earlier.
 */
export const SCOPES = "read:user";

/** GitHub answers JSON only when asked. Without this header both OAuth
 *  endpoints reply with a form-urlencoded body, which is the single most common
 *  way to get `undefined` out of this flow. */
const JSON_HEADERS = { Accept: "application/json", "Content-Type": "application/json" };

/** A user agent is REQUIRED by api.github.com — it answers 403 without one. */
const UA = "zevet-hub";

/**
 * Every network call in this file goes through here, so that the timeout, the
 * JSON handling and the failure shape are decided once.
 *
 * ⚠️ NEVER THROWS FOR A NETWORK REASON. It answers `{ ok: false, error }`. The
 * caller is an HTTP handler on a hub that must not 500 because GitHub is
 * having an afternoon, and an error a person can read ("GitHub did not answer
 * in 10 seconds") is worth more than a stack trace in a log nobody reads.
 */
async function call(url, init, fetchImpl) {
  const f = typeof fetchImpl === "function" ? fetchImpl : fetch;
  const ac = new AbortController();
  // 10s: long enough for a slow TLS handshake from a cold container, short
  // enough that a hung call does not hold a browser's spinner for a minute.
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await f(url, { ...init, signal: ac.signal });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // GitHub returning non-JSON means an outage page or a proxy, and the
      // first 200 characters of it are far more diagnostic than "parse error".
      return { ok: false, error: `GitHub answered ${res.status} with something that is not JSON: ${text.slice(0, 200)}` };
    }
    return { ok: true, status: res.status, body };
  } catch (err) {
    if (err && err.name === "AbortError") return { ok: false, error: "GitHub did not answer in 10 seconds" };
    return { ok: false, error: `could not reach GitHub: ${err && err.message ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Step one: ask GitHub for a device code.
 *
 * Returns `{ ok: true, deviceCode, userCode, verificationUri,
 * verificationUriComplete, interval, expiresIn }`, or `{ ok: false, error }`.
 *
 * `interval` is GitHub's, not ours. Polling faster than it asks earns a
 * `slow_down` and then a refusal, so it is passed through to the caller rather
 * than replaced with a number that seemed nice here.
 */
export async function deviceStart({ clientId, scopes = SCOPES, fetchImpl } = {}) {
  if (!clientId) return { ok: false, error: "GitHub sign-in is not configured" };

  const r = await call(
    DEVICE_CODE_URL,
    { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ client_id: clientId, scope: scopes }) },
    fetchImpl,
  );
  if (!r.ok) return r;

  const b = r.body || {};
  if (b.error) return { ok: false, error: githubError(b) };
  if (!b.device_code || !b.user_code) {
    // The overwhelmingly likely cause, named, because the GitHub UI does not
    // make it obvious and the symptom is this exact shape.
    return { ok: false, error: "GitHub did not return a device code — check that “Enable Device Flow” is ticked on the OAuth app" };
  }

  return {
    ok: true,
    deviceCode: String(b.device_code),
    userCode: String(b.user_code),
    verificationUri: String(b.verification_uri || "https://github.com/login/device"),
    // Present on GitHub today, but constructed as a fallback rather than
    // assumed: this is the URL that makes the flow typing-free, and losing it
    // silently would quietly reintroduce the thing this was built to remove.
    verificationUriComplete: String(
      b.verification_uri_complete ||
        `${b.verification_uri || "https://github.com/login/device"}?user_code=${encodeURIComponent(b.user_code)}`,
    ),
    interval: Number(b.interval) || 5,
    expiresIn: Number(b.expires_in) || 900,
  };
}

/**
 * Step two: has the person authorised it yet?
 *
 * ONE poll, not a loop. The loop belongs to the caller, because the caller is
 * an HTTP handler being driven by a desktop app that has its own timer and its
 * own cancel button, and a loop here would hold a socket open for fifteen
 * minutes to produce the same answer.
 *
 * Returns one of:
 *   `{ ok: true, pending: true, slowDown?: true }`  — keep waiting
 *   `{ ok: true, accessToken }`                     — done
 *   `{ ok: false, error }`                          — stop, and say this
 */
export async function devicePoll({ clientId, deviceCode, fetchImpl } = {}) {
  if (!clientId) return { ok: false, error: "GitHub sign-in is not configured" };
  if (!deviceCode) return { ok: false, error: "no device code" };

  const r = await call(
    ACCESS_TOKEN_URL,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    },
    fetchImpl,
  );
  if (!r.ok) return r;

  const b = r.body || {};

  // ⚠️ `authorization_pending` IS THE NORMAL ANSWER, and it arrives as an
  // HTTP 200 with an `error` field. Treating any `error` as fatal here would
  // make the flow fail instantly, every time, for everyone — it is the whole
  // reason this function distinguishes the three cases by NAME rather than by
  // the presence of `error`.
  if (b.error === "authorization_pending") return { ok: true, pending: true };
  if (b.error === "slow_down") return { ok: true, pending: true, slowDown: true };
  if (b.error) return { ok: false, error: githubError(b) };

  if (!b.access_token) return { ok: false, error: "GitHub authorised the device but returned no access token" };
  return { ok: true, accessToken: String(b.access_token) };
}

/**
 * Step three: who is this?
 *
 * The `id` matters more than the `login`: a GitHub login can be changed by its
 * owner and then claimed by somebody else, so an allowlist keyed on login alone
 * is an allowlist that can be inherited. accounts.mjs stores both and checks
 * the id when it has one.
 */
export async function githubUser({ accessToken, fetchImpl } = {}) {
  if (!accessToken) return { ok: false, error: "no access token" };

  const r = await call(
    USER_URL,
    { method: "GET", headers: { Accept: "application/vnd.github+json", "User-Agent": UA, Authorization: `Bearer ${accessToken}` } },
    fetchImpl,
  );
  if (!r.ok) return r;
  if (r.status !== 200) return { ok: false, error: `GitHub refused to identify the token (${r.status})` };

  const b = r.body || {};
  if (!b.login || !b.id) return { ok: false, error: "GitHub returned a user with no login" };
  return { ok: true, login: String(b.login), id: String(b.id), name: b.name ? String(b.name) : null, avatar: b.avatar_url ? String(b.avatar_url) : null };
}

/** GitHub's errors carry a human sentence in `error_description` often enough
 *  that it is worth preferring, and a code worth keeping when it does not. */
function githubError(b) {
  const code = b.error ? String(b.error) : "unknown";
  const desc = b.error_description ? String(b.error_description) : "";
  if (code === "expired_token") return "that sign-in expired — start again";
  if (code === "access_denied") return "the request was declined on GitHub";
  return desc ? `${desc} (${code})` : `GitHub said: ${code}`;
}
