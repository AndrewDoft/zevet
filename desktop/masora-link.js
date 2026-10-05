// Linking zevet to Masora, in the background.
//
// It used to be a button that had to be pressed and a code that had to be
// carried across. Now it starts when the board opens, waits for Masora to be
// running, asks it for a pairing code, and polls for the answer. Nothing here
// is awaited by onboarding: `start()` returns at once, `status()` is what
// Settings reads, and every failure lands in the status rather than a throw.
//
// Pairing is still an approval on Masora's side, so the browser is opened only
// by `approve()`, from a click in Settings -- never on launch.
"use strict";

const RETRY_MS = 60_000;
const PROBE_TIMEOUT_MS = 3000;

class MasoraLink {
  constructor({ readConfig, MasoraPair, saveToken, openExternal, host, platform, fetchImpl, retryMs = RETRY_MS } = {}) {
    this.readConfig = readConfig;
    this.MasoraPair = MasoraPair;
    this.saveToken = saveToken;
    this.openExternal = openExternal;
    this.host = host;
    this.platform = platform;
    this.fetch = typeof fetchImpl === "function" ? fetchImpl : (...a) => fetch(...a);
    this.retryMs = retryMs;
    this.gen = 0; // bumped by cancel(); a loop whose gen is stale stops and stays silent
    this.active = null;
    this.pair = null;
    this.wake = null;
    this.state = { phase: "idle" };
  }

  status() {
    return { ...this.state, paired: this.readConfig().paired };
  }

  /** Begin (or retry now). Never throws, never blocks. */
  start() {
    if (this.active === this.gen) {
      if (this.wake) this.wake(); // sitting out a retry delay: go again now
      return;
    }
    const gen = this.gen;
    this.active = gen;
    void this.#loop(gen)
      .catch((err) => {
        if (gen === this.gen) this.state = { phase: "error", error: err && err.message ? err.message : String(err) };
      })
      .finally(() => {
        if (this.active === gen) this.active = null;
      });
  }

  cancel() {
    this.gen++;
    if (this.pair) this.pair.cancel();
    if (this.wake) this.wake();
    this.state = { phase: "idle" };
  }

  /** Open the approval page. False when there is nothing to approve yet. */
  approve() {
    if (this.state.phase !== "waiting" || !this.state.verifyUrl) return false;
    Promise.resolve(this.openExternal(this.state.verifyUrl)).catch(() => {});
    return true;
  }

  #delay() {
    return new Promise((resolve) => {
      const t = setTimeout(done, this.retryMs);
      if (typeof t.unref === "function") t.unref();
      const self = this;
      function done() {
        clearTimeout(t);
        self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }

  async #reachable(url) {
    try {
      const res = await this.fetch(`${url.replace(/\/+$/, "")}/healthz`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async #loop(gen) {
    const live = () => gen === this.gen;
    while (live()) {
      const cfg = this.readConfig();
      if (cfg.paired) {
        this.state = { phase: "linked" };
        return;
      }
      if (!(await this.#reachable(cfg.url))) {
        if (!live()) return;
        this.state = { phase: "unreachable" };
        await this.#delay();
        continue;
      }
      const pair = new this.MasoraPair({ baseUrl: cfg.url });
      this.pair = pair;
      try {
        const r = await pair.start();
        if (!live()) return;
        this.state = { phase: "waiting", code: r.userCode, verifyUrl: r.verifyUrl };
        const { token } = await pair.wait(this.host, this.platform);
        if (!live()) return;
        try {
          this.saveToken(token);
        } catch (err) {
          // No keychain is not a thing a retry fixes; stop and say so.
          this.state = { phase: "error", error: err && err.message ? err.message : String(err) };
          return;
        }
        this.state = { phase: "linked" };
        return;
      } catch (err) {
        if (!live()) return;
        this.state = { phase: "error", error: err && err.message ? err.message : String(err) };
        await this.#delay();
      } finally {
        if (this.pair === pair) this.pair = null;
      }
    }
  }
}

module.exports = { MasoraLink, RETRY_MS };
