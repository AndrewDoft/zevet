"use strict";
// The board window's way back from a failed load: show Zevet's own waiting page at once (never Chromium's
// "this site can't be reached"), retry on a short capped backoff forever, and retry immediately when the machine
// wakes or the network comes back. Before this, one retry after 1.5 s and then a dead "Offline" page until the
// person reloaded by hand.

/** Wait before the nth retry (1-based): 0.4 s, 0.8 s, 1.5 s, 3 s, then 5 s. */
const STEPS = [400, 800, 1500, 3000];
const CAP_MS = 5000;
const delayFor = (n) => STEPS[n - 1] ?? CAP_MS;

/**
 * @param {{ load: () => void, showPage: () => void, isOnline?: () => boolean, pollMs?: number,
 *           setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout, setTick?: typeof setInterval, clearTick?: typeof clearInterval }} o
 */
function createReconnect({ load, showPage, isOnline = () => true, pollMs = 1000, setTimer = setTimeout, clearTimer = clearTimeout, setTick = setInterval, clearTick = clearInterval }) {
  let failures = 0, timer = null, tick = null, wasOnline = true;
  const stopTimers = () => { if (timer) clearTimer(timer); if (tick) clearTick(tick); timer = tick = null; };
  const retry = () => { timer = null; load(); };
  const arm = () => { if (!timer) timer = setTimer(retry, delayFor(failures)); };
  return {
    /** A load failed (not an abort). */
    failed() {
      failures += 1;
      if (failures === 1) {
        showPage();
        wasOnline = isOnline();
        tick = setTick(() => { const now = isOnline(); if (now && !wasOnline) this.nudge(); wasOnline = now; }, pollMs);
        tick.unref?.();
      }
      arm();
    },
    /** The hub page loaded. */
    loaded() { failures = 0; stopTimers(); },
    /** Wake, unlock, network back: try now instead of at the end of the backoff. */
    nudge() {
      if (!failures) return;
      if (timer) clearTimer(timer);
      timer = null;
      load();
    },
    stop() { failures = 0; stopTimers(); },
    get failing() { return failures > 0; },
  };
}

module.exports = { delayFor, createReconnect, CAP_MS };
