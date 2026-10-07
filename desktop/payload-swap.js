"use strict";

/**
 * When a staged payload may take over, and how it is confirmed afterwards.
 * Pure: everything it touches is passed in, so node --test loads it (main.js cannot be).
 *
 * A swap is `app.relaunch(); app.exit(0)`. That kills every child the main process
 * owns, so it NEVER happens while a console (agent, zagent-hosted agent or agent-API
 * spawn: they all go through startAgentCore) has a live process, or spoke in the last
 * 5 minutes, or while a chat turn is in flight, or while a window had input in the
 * last 2 minutes, or with no window open (a macOS app in the dock: a relaunch would
 * open a window nobody asked for). What the gate refuses waits for the next tick or
 * for quit, which applies the staged build without relaunching.
 */

const AGENT_QUIET_MS = 5 * 60 * 1000;
const INPUT_QUIET_MS = 2 * 60 * 1000;
const POLL_MS = 30 * 1000;
const CONFIRM_TIMEOUT_MS = 120 * 1000;

/** Why a swap must wait, or null when it may go. */
function busyReason({ now, activity, chatBusy, lastInputAt, windows, inputQuietMs = INPUT_QUIET_MS, working }) {
  // A console mid-turn is never restarted, resumable or not: a restore resumes the session but the waiter on the old
  // turn, and the turn's own in-flight tool calls, are lost (0.2.125, 2026-10-07).
  // Required, not optional: a caller that forgot to pass it would silently restart through a mid-turn agent.
  if (typeof working !== "function") throw new TypeError("busyReason: working() is required");
  if (working() > 0) return "an agent is mid-turn";
  const a = activity();
  if (a.nonResumable > 0) return "a non-resumable agent is running";
  if (a.running > 0 && !a.resumable) return "an agent is running";
  if (!a.resumable && now - a.lastAt < AGENT_QUIET_MS) return "an agent ran in the last 5 minutes";
  if (chatBusy()) return "a chat turn is in flight";
  if (now - lastInputAt() < inputQuietMs) return "a window had input in the last 2 minutes";
  if (windows() === 0) return "no window is open";
  return null;
}

function createSwapper({ payload, app, activity, chatBusy, lastInputAt, windows, inputQuietMs, working, onWaiting = () => {}, release, log, now = Date.now, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
  let swapping = false;
  let timer = null;
  let lastWhy = null;

  async function tick() {
    if (swapping || !payload.staged()) return "idle";
    const why = busyReason({ now: now(), activity, chatBusy, lastInputAt, windows, inputQuietMs, working });
    if (why !== lastWhy) onWaiting(why);
    if (why !== lastWhy) log(`payload ${payload.staged().build} staged; ${why ? `waiting: ${why}` : "idle"}`);
    lastWhy = why;
    if (why) return why;
    swapping = true;
    try {
      const next = await payload.activate();
      log(`payload ${next.build} activated; relaunching`);
      release();
      app.relaunch();
      app.exit(0);
    } catch (err) {
      swapping = false;
      log(`payload swap failed: ${err && err.message}`);
      return "failed";
    }
    return "swapped";
  }

  return {
    tick,
    start() {
      payload.on("staged", () => { tick(); });
      timer = setIntervalImpl(tick, POLL_MS);
      if (timer && timer.unref) timer.unref();
    },
    stop() {
      clearIntervalImpl(timer);
    },
    pending: () => Boolean(payload.staged()),
    /** will-quit: the staged build becomes current for the NEXT launch. No relaunch. */
    async applyOnQuit() {
      if (!payload.staged()) return false;
      await payload.activate();
      return true;
    },
  };
}

/** Resolves true once a window has finished loading AND the agent API answers, false when `timeoutMs` passes first. */
function awaitHealthy({ loaded, apiAnswers, timeoutMs = CONFIRM_TIMEOUT_MS, retryMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  return (async () => {
    const deadline = now() + timeoutMs;
    let isLoaded = false;
    loaded.then(() => { isLoaded = true; });
    while (now() < deadline) {
      if (isLoaded && (await apiAnswers().catch(() => false))) return true;
      await sleep(retryMs);
    }
    return false;
  })();
}

/**
 * A trial build is confirmed once a window has finished its load attempt (load OR
 * fail: a hub that is unreachable is the network's fault, not the payload's) AND the
 * agent API answers. If that has not happened in 120 s the boot counts as failed and
 * the app relaunches: onto the previous build once the third strike lands.
 */
function confirmWhenHealthy({ payload, loaded, apiAnswers, app, log, timeoutMs, retryMs, sleep, now }) {
  return (async () => {
    if (await awaitHealthy({ loaded, apiAnswers, timeoutMs, retryMs, sleep, now })) {
      // confirm() writes the verdict, THEN runs gc, and gc can throw on Windows (EPERM removing an old versions/ dir
      // something still holds open). The build IS confirmed by then: never let the sweep turn that into a crash.
      // The leftover dir is swept by the next confirm, which is the retry.
      try {
        payload.confirm();
        log("payload confirmed healthy");
      } catch (err) {
        log(`payload confirmed healthy; cleanup of old versions failed, retried at the next confirm: ${err && err.message}`);
      }
      return true;
    }
    const r = payload.bootFailed("no healthy signal within 120s");
    log(`payload unhealthy: ${r.reverted ? "reverted" : "strike counted"}; relaunching`);
    app.relaunch();
    app.exit(1);
    return false;
  })();
}

module.exports = { createSwapper, confirmWhenHealthy, awaitHealthy, busyReason, AGENT_QUIET_MS, INPUT_QUIET_MS, POLL_MS, CONFIRM_TIMEOUT_MS };
