// When a downloaded installer may run without the Restart row: nobody is here. Electron-free; main.js reads
// powerMonitor and the windows and passes them in.
//
// Ported from masora2 apps/desktop/shell/idle-install.js (decideIdleInstall). Zevet differences: `busy` is
// payload-swap.js's busyReason, so agents, a chat turn and recent input gate this exactly as they gate a payload
// swap; and the install is the Restart-now path (--force-run), so the relaunch restores the consoles. There is no
// hidden-relaunch marker: Zevet has no launched-hidden state to honour.
"use strict";

const { busyReason } = require("./payload-swap.js");

/** The machine untouched this long counts as away. */
const IDLE_SECONDS = 10 * 60;
const CHECK_MS = 60 * 1000;

/**
 * "install" only when nobody is in the middle of anything:
 *   rendererIdle  must be true — false means an answer streaming, typed text or a dialog (never interrupted)
 *   then either every window hidden/minimised, or the machine idle for IDLE_SECONDS
 * `hidden` says the person was not looking.
 */
function decideIdleInstall({ phase, systemIdleSeconds, windowsAway, rendererIdle, busy, attempted }) {
  if (phase !== "ready" || busy || attempted || rendererIdle !== true) return { install: false };
  if (windowsAway) return { install: true, hidden: true };
  if (Number.isFinite(systemIdleSeconds) && systemIdleSeconds >= IDLE_SECONDS) return { install: true, hidden: false };
  return { install: false };
}

/**
 * One idle-install attempt per version. `gate` is the same { activity, chatBusy, lastInputAt, windows } the
 * payload swapper gets, so nothing here re-implements "busy". `persist` saves the resumable consoles and MUST
 * run before the installer is spawned; `install` is appUpdater.install. `canSilent` is false where the install
 * would open a disk image instead of replacing the app (an unwritable Mac bundle).
 *
 * rendererIdle is true here because the board reports none: a chat turn in flight and input in the last two
 * minutes are already in busyReason. A non-resumable console never installs (busyReason: nonResumable > 0),
 * since the relaunch would end it.
 */
function createIdleInstaller({ updater, gate, canSilent = () => true, systemIdleSeconds, windowsAway, persist, log = () => {}, now = Date.now }) {
  let attemptedVersion = null;
  return async function tick() {
    const s = updater.state;
    if (s.phase !== "ready" || !s.canInstall || !canSilent()) return false;
    const why = busyReason({ now: now(), ...gate });
    const d = decideIdleInstall({
      phase: s.phase,
      systemIdleSeconds: systemIdleSeconds(),
      windowsAway: windowsAway(),
      rendererIdle: true,
      busy: Boolean(why),
      attempted: attemptedVersion === s.version,
    });
    if (!d.install) return false;
    attemptedVersion = s.version;
    log(`idle install of ${s.version}`);
    try {
      persist();
    } catch (err) {
      log(`idle install of ${s.version} cancelled: consoles not saved (${err && err.message})`);
      return false;
    }
    const r = await updater.install();
    if (r && r.ok === false) log(`idle install of ${s.version} failed: ${r.error}`);
    return !r || r.ok !== false;
  };
}

module.exports = { IDLE_SECONDS, CHECK_MS, decideIdleInstall, createIdleInstaller };
