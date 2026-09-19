// Signing in with GitHub, from the desktop side.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS REPLACES
//
// A 48-character hex string that somebody read aloud, pasted into Slack, or
// typed from a phone screen. Andrew, 2026-09-19: "idk what this master secret
// thing means, but people should be able to use the app without having to enter
// some long code."
//
// What happens now: a button, a browser tab that is already on the right page
// with the code already in it, one click on GitHub, and the app is signed in.
// The user code is shown in the window as well, because a browser that opens on
// the wrong profile — or does not open at all, which happens on Linux and on
// locked-down Windows — must not be a dead end.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ THIS TALKS TO THE HUB, NOT TO GITHUB. Every call here goes to
// `<hub>/auth/github/*`, which proxies to GitHub. See hub/github-auth.mjs for
// why. The practical consequence for anyone reading this file: there is no
// client id in it, and there is nothing to configure on this machine.
//
// ⚠️ NOTHING HERE TOUCHES `electron`. It is required by main.js, but it is
// plain Node with an injectable `fetch` and an injectable clock, because the
// polling state machine below is the part most likely to be wrong and a module
// that can only run inside Electron is a module that never gets a test.
"use strict";

/** Poll for at most this long regardless of what GitHub said. GitHub's own
 *  `expires_in` is 15 minutes; this is the belt to that braces, so a hub that
 *  returns a nonsense `expiresIn` cannot leave a timer running forever. */
const MAX_WAIT_MS = 16 * 60 * 1000;

/** Added to the interval every time GitHub says `slow_down`. GitHub's spec says
 *  5 seconds; obeying it is what keeps a flow from being refused outright. */
const SLOW_DOWN_STEP_MS = 5000;

class SignInError extends Error {}

/**
 * One sign-in attempt.
 *
 * `start()` asks the hub for a code and returns what to show the person.
 * `wait()` polls until it resolves — it is safe to call once, after `start()`.
 * `cancel()` stops the polling; `wait()` then rejects with "cancelled".
 *
 * The two-call shape exists because the UI has to paint the code IMMEDIATELY
 * and then sit there for up to a quarter of an hour. A single call that did
 * both would leave the window blank for the whole flow.
 */
class GithubSignIn {
  constructor({ hub, fetchImpl, now = () => Date.now(), sleep } = {}) {
    if (!hub) throw new SignInError("no hub address");
    this.base = String(hub).replace(/\/+$/, "");
    this.fetch = typeof fetchImpl === "function" ? fetchImpl : (...a) => fetch(...a);
    this.now = now;
    // Injectable so a test does not spend real seconds inside a poll loop.
    this.sleep = typeof sleep === "function" ? sleep : (ms) => new Promise((r) => setTimeout(r, ms));
    this.cancelled = false;
    this.device = null;
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
      throw new SignInError(`The hub answered ${res.status} with something that is not JSON.`);
    }
    if (!res.ok) {
      // 503 is the hub saying it has no client id. That is a DEPLOYMENT
      // problem, not a user problem, and saying "sign-in failed" would send
      // somebody looking at their own GitHub account for an hour.
      if (res.status === 503) throw new SignInError("This hub does not have GitHub sign-in switched on yet.");
      throw new SignInError(parsed && parsed.error ? parsed.error : `The hub answered ${res.status}.`);
    }
    return parsed;
  }

  async start() {
    const r = await this.#post("/auth/github/start", {});
    this.device = r;
    this.deadline = this.now() + Math.min(MAX_WAIT_MS, (Number(r.expiresIn) || 900) * 1000);
    this.intervalMs = Math.max(1, Number(r.interval) || 5) * 1000;
    return {
      userCode: r.userCode,
      verificationUri: r.verificationUri,
      verificationUriComplete: r.verificationUriComplete,
      expiresIn: Number(r.expiresIn) || 900,
    };
  }

  cancel() {
    this.cancelled = true;
  }

  /**
   * Poll until GitHub says yes, no, or nothing for long enough.
   *
   * Resolves `{ token, secret, login, owner }` — the caller writes the config.
   * Rejects with a SignInError carrying a sentence meant for a human.
   */
  async wait() {
    if (!this.device) throw new SignInError("start() has not been called");

    // ⚠️ THE FIRST WAIT COMES BEFORE THE FIRST POLL, not after. GitHub cannot
    // possibly have an answer in the moment between handing out a code and
    // being asked about it, and polling immediately earns a `slow_down` on the
    // very first request — which then raises the interval for the whole flow.
    while (!this.cancelled) {
      await this.sleep(this.intervalMs);
      if (this.cancelled) break;
      if (this.now() > this.deadline) {
        throw new SignInError("That sign-in expired. Start again and the code will be new.");
      }

      const r = await this.#post("/auth/github/finish", { deviceCode: this.device.deviceCode });
      if (r && r.pending) {
        if (r.slowDown) this.intervalMs += SLOW_DOWN_STEP_MS;
        continue;
      }
      if (r && r.ok && r.token) return { token: r.token, secret: r.secret || "", login: r.login, owner: Boolean(r.owner) };
      throw new SignInError((r && r.error) || "The hub gave an answer that made no sense.");
    }
    throw new SignInError("cancelled");
  }
}

module.exports = { GithubSignIn, SignInError, MAX_WAIT_MS, SLOW_DOWN_STEP_MS };
