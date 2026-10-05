// When a downloaded installer may run without the Restart row: nobody is here. Electron-free; main.js reads
// powerMonitor and the windows and passes them in.
//
// Ported from masora2 apps/desktop/shell/idle-install.js (decideIdleInstall). Zevet differences: `busy` is
// payload-swap.js's busyReason, so agents, a chat turn and recent input gate this exactly as they gate a payload
// swap; and the install is the Restart-now path (--force-run), so the relaunch restores the consoles. There is no
// hidden-relaunch marker: Zevet has no launched-hidden state to honour.
"use strict";

const { busyReason } = require("./payload-swap.js");

/** The machine untouched, or no window focused, this long counts as away ("a few minutes"). */
const IDLE_SECONDS = 3 * 60;
const CHECK_MS = 60 * 1000;
/** A failed attempt is retried, at most this often and this many times per version. After that the quit-time install
 *  (app-update.js installOnQuit) is what is left, so a version is never stranded by one bad run. */
const RETRY_GAP_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

/**
 * "install" only when nobody is in the middle of anything:
 *   rendererIdle  must be true — false means an answer streaming, typed text or a dialog (never interrupted)
 *   then either the person was away (`windowsAway`: no window focused for IDLE_SECONDS), the machine idle for
 *   IDLE_SECONDS, or the machine just woke from sleep (`resumed`: they were not looking, and nothing was running).
 * `hidden` says the person was not looking.
 */
function decideIdleInstall({ phase, systemIdleSeconds, windowsAway, rendererIdle, busy, attempted, resumed }) {
  if (phase !== "ready" || busy || attempted || rendererIdle !== true) return { install: false };
  if (windowsAway || resumed) return { install: true, hidden: true };
  if (Number.isFinite(systemIdleSeconds) && systemIdleSeconds >= IDLE_SECONDS) return { install: true, hidden: false };
  return { install: false };
}

/**
 * Install attempts per version, bounded. `gate` is the same { activity, chatBusy, lastInputAt, windows } the
 * payload swapper gets, plus `working()` (consoles mid-turn): a console that is working is never restarted, resumable
 * or not. `windowsAway()` says no window is focused right now; this measures how long that has held. `persist` saves
 * the resumable consoles and MUST run before the installer is spawned; `install` is appUpdater.install. `canSilent`
 * is false where the install would open a disk image instead of replacing the app (an unwritable Mac bundle).
 *
 * rendererIdle is true here because the board reports none: a chat turn in flight and input in the last two
 * minutes are already in busyReason. A non-resumable console never installs (busyReason: nonResumable > 0),
 * since the relaunch would end it. `tick({ resumed: true })` is the resume-from-sleep trigger.
 */
function createIdleInstaller({ updater, gate, canSilent = () => true, systemIdleSeconds, windowsAway, persist, log = () => {}, now = Date.now }) {
  let tried = { version: null, n: 0, at: 0 };
  let awaySince = null;
  return async function tick({ resumed = false } = {}) {
    const s = updater.state;
    const t = now();
    if (windowsAway()) { if (awaySince === null) awaySince = t; } else awaySince = null;
    if (s.phase !== "ready" || !s.canInstall || !canSilent()) return false;
    const why = busyReason({ now: t, ...gate });
    const midTurn = typeof gate.working === "function" && gate.working() > 0;
    const spent = tried.version === s.version && (tried.n >= MAX_ATTEMPTS || t - tried.at < RETRY_GAP_MS);
    const d = decideIdleInstall({
      phase: s.phase,
      systemIdleSeconds: systemIdleSeconds(),
      windowsAway: awaySince !== null && t - awaySince >= IDLE_SECONDS * 1000,
      rendererIdle: true,
      busy: Boolean(why) || midTurn,
      attempted: spent,
      resumed,
    });
    if (!d.install) return false;
    tried = { version: s.version, n: tried.version === s.version ? tried.n + 1 : 1, at: t };
    log(`idle install of ${s.version} (attempt ${tried.n}${resumed ? ", after sleep" : ""})`);
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

module.exports = { IDLE_SECONDS, CHECK_MS, RETRY_GAP_MS, MAX_ATTEMPTS, decideIdleInstall, createIdleInstaller };
