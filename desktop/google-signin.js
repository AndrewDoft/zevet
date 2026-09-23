// Signing in with Google, from the desktop side.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT JUST github-signin.js WITH A DIFFERENT URL
//
// GitHub's device flow answers "has the person authorised it yet?" from GitHub
// itself, so the app polls a code GitHub minted. Google's web flow sends the
// person to a BROWSER, which lands back on the HUB — this app is not in that
// conversation at all. What it polls is therefore not Google's code but the
// hub's PAIRING code: a value the hub minted for this attempt, that the browser
// carried round as the OAuth `state`, and that the hub will trade exactly once
// for the session the callback established.
//
// So the two-call shape is identical and the thing being polled is not. The
// visible difference for a person: there is no eight-character code to read,
// because Google never asks for one when the flow is this way round.
//
// ⚠️ THIS TALKS TO THE HUB, NOT TO GOOGLE. Every call goes to
// `<hub>/auth/google/*`. There is no client id in this file, no client secret,
// and nothing to configure on this machine — see hub/google-auth.mjs for why
// the secret can only live on the hub.
//
// ⚠️ NOTHING HERE TOUCHES `electron`, for the same reason its GitHub sibling
// does not: the polling state machine is the part most likely to be wrong, and
// a module that can only run inside Electron is a module that never gets a test.
"use strict";

/** Poll for at most this long regardless of what the hub said. The hub expires
 *  a pairing code after ten minutes; this is the belt to that braces, so a hub
 *  returning a nonsense `expiresIn` cannot leave a timer running for ever. */
const MAX_WAIT_MS = 11 * 60 * 1000;

/** How often to ask. Two seconds is the app waiting on a human in a browser —
 *  fast enough that the window does not feel stuck once they click, slow enough
 *  that ten minutes of waiting is three hundred requests, not thirty thousand. */
const DEFAULT_INTERVAL_MS = 2000;

class SignInError extends Error {}

/**
 * One sign-in attempt.
 *
 * `start()` asks the hub where to send the browser and returns that URL.
 * `wait()` polls until it resolves — safe to call once, after `start()`.
 * `cancel()` stops the polling; `wait()` then rejects with "cancelled".
 */
class GoogleSignIn {
  constructor({ hub, team = "", fetchImpl, now = () => Date.now(), sleep } = {}) {
    if (!hub) throw new SignInError("Enter a hub address.");
    this.base = String(hub).replace(/\/+$/, "");
    // Empty/absent means the hub's DEFAULT team. `finish`/`callback` need no
    // copy of this — the hub records it against the pairCode at `start`.
    this.team = String(team || "");
    this.fetch = typeof fetchImpl === "function" ? fetchImpl : (...a) => fetch(...a);
    this.now = now;
    // Injectable so a test does not spend real seconds inside a poll loop.
    this.sleep = typeof sleep === "function" ? sleep : (ms) => new Promise((r) => setTimeout(r, ms));
    this.cancelled = false;
    this.pair = null;
  }

  async #post(route, body) {
    let res;
    try {
      res = await this.fetch(`${this.base}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new SignInError(`Could not reach the hub: ${err && err.message ? err.message : String(err)}`);
    }
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      throw new SignInError(`The hub returned an invalid response (HTTP ${res.status}).`);
    }
    if (!res.ok) {
      // 503 is the hub saying it has no Google client. That is a DEPLOYMENT
      // problem, not a user problem, and "sign-in failed" would send somebody
      // looking at their own Google account for an hour.
      if (res.status === 503) throw new SignInError("Google sign-in is not configured for this hub.");
      throw new SignInError(parsed && parsed.error ? parsed.error : `The hub returned HTTP ${res.status}.`);
    }
    return parsed;
  }

  async start() {
    const r = await this.#post("/auth/google/start", { team: this.team });
    if (!r || !r.pairCode || !r.authUrl) throw new SignInError("The hub did not start a Google sign-in. Try again.");
    this.pair = r;
    this.deadline = this.now() + Math.min(MAX_WAIT_MS, (Number(r.expiresIn) || 600) * 1000);
    this.intervalMs = Math.max(1, Number(r.interval) || 2) * 1000 || DEFAULT_INTERVAL_MS;
    return { authUrl: r.authUrl, expiresIn: Number(r.expiresIn) || 600, domain: r.domain || "" };
  }

  cancel() {
    this.cancelled = true;
  }

  /**
   * Poll until the browser has come back, or not.
   *
   * Resolves `{ token, secret, login, owner }` — the caller writes the config.
   * Rejects with a SignInError carrying a sentence meant for a human.
   */
  async wait() {
    if (!this.pair) throw new SignInError("Start Google sign-in first.");

    // The first wait comes before the first poll: the person has not even seen
    // the account chooser yet in the moment the browser is opened, so the first
    // request could only ever be answered `pending`.
    while (!this.cancelled) {
      await this.sleep(this.intervalMs);
      if (this.cancelled) break;
      if (this.now() > this.deadline) {
        throw new SignInError("Sign-in expired. Try again.");
      }

      const r = await this.#post("/auth/google/finish", { pairCode: this.pair.pairCode });
      if (r && r.pending) continue;
      if (r && r.ok && r.token) return { token: r.token, secret: r.secret || "", login: r.login, owner: Boolean(r.owner) };
      throw new SignInError((r && r.error) || "The hub returned an invalid sign-in response. Try again.");
    }
    throw new SignInError("cancelled");
  }
}

module.exports = { GoogleSignIn, SignInError, MAX_WAIT_MS };
