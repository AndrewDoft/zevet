// After an installer update, the new version must prove itself: healthy within the boot budget on its
// first launch. If not, the previous installer (kept in the updates cache) is run again and the bad
// version is never offered again. Electron-free; every side effect is injected.
//
// State is <updates>/rollback.json:
//   pending   { from, to, entry, prev, rolledBack, head, strikes } — an install that has not yet proved itself
//   lastGood  { version, file, bytes, sha256 }                — the installer that produced the running version
//   bad       [version]                                       — never offered, never installed again
//
// Semver hazard (memory canary-version-feed-hazard): a machine on a prerelease build (0.3.111-canary.1)
// must never be offered a plain release of the same number — it may lack that build's on-disk migration.
// offerable() enforces it here rather than leaning on compareVersions' handling of the suffix.
//
// The payload path needs none of this: bootstrap.js keeps the previous tree, reverts after three failed
// boots and lists the build in bad.json. Nothing here touches it.
//
// Ported from masora2 apps/desktop/shell/update-rollback.js. Zevet differences: the installer arguments and spawn
// options are injected (app-update.js's INSTALL_ARGS plus the running install's own scope and /D=), and a spawn
// that fails asynchronously cancels the quit instead of closing the app for an installer that never ran.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STATE_FILE = "rollback.json";
/** Boot failures that say nothing about the build. */
const NOT_THE_BUILD = new Set(["foreign", "not-bundled"]);
/** Alive but not healthy in the budget: a slow first boot (2-core runner, §9.1) looks the same as a bad build, so it
 *  takes two consecutive strikes. A crash or exit is the build's fault at once. */
const SLOW = new Set(["timeout", "unhealthy"]);
const STRIKES_TO_ROLL_BACK = 2;
const QUIT_AFTER_SPAWN_MS = 600;

const base = (v) => String(v).split("-")[0];
const isPrerelease = (v) => String(v).includes("-");

/** May `candidate` be offered to a machine running `running`? `bad` is the list of withdrawn versions. */
function offerable(running, candidate, bad = []) {
  if (bad.includes(base(candidate))) return false;
  if (isPrerelease(running) && base(candidate) === base(running)) return false;
  return true;
}

/**
 * What to do on a launch. `boot` is the first-boot result ({ ok, reason }), or null before booting.
 *   none | confirm | clear | settle | rollback | report
 */
function decideBoot({ running, pending, boot, canRollback, migrated = false }) {
  if (!pending) return { action: "none" };
  if (base(pending.to) !== base(running)) {
    // Running the version we came from: a finished rollback, or an installer that never took.
    return { action: pending.rolledBack ? "settle" : "clear" };
  }
  if (!boot || NOT_THE_BUILD.has(boot.reason)) return { action: "none" };
  if (boot.ok) return { action: "confirm" };
  if (SLOW.has(boot.reason) && (pending.strikes || 0) + 1 < STRIKES_TO_ROLL_BACK) return { action: "retry" };
  // The new build migrated the database: the previous installer would meet a schema it does not know.
  if (migrated) return { action: "report" };
  return { action: canRollback ? "rollback" : "report" };
}

function createRollback({ dir, running, schemaHead = () => null, platform = process.platform, spawn, installArgs = () => ["--updated", "/S", "--force-run"], spawnOptions = {}, verifyPublisher, verifiedOnDisk, stopRuntime, quit, log = () => {}, report = () => {}, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout }) {
  const file = path.join(dir, STATE_FILE);
  const read = () => {
    try { return { bad: [], pending: null, lastGood: null, ...JSON.parse(fs.readFileSync(file, "utf8")) }; }
    catch { return { bad: [], pending: null, lastGood: null }; }
  };
  const write = (s) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(s));
    } catch (err) { log(`could not write ${STATE_FILE}: ${err.message}`); }
  };

  async function settle(boot) {
    const s = read();
    const p = s.pending;
    const head = schemaHead();
    const migrated = !!(p && p.head != null && head != null && head > p.head);
    const d = decideBoot({ running, pending: p, boot, canRollback: platform === "win32" && !!(p && p.prev), migrated });
    if (d.action === "retry") {
      p.strikes = (p.strikes || 0) + 1;
      write(s);
      log(`${p.to} not healthy on launch ${p.strikes} (${boot.reason}); one more before rolling back`);
    }
    if (d.action === "confirm") {
      if (p.entry) s.lastGood = { version: base(p.to), ...p.entry };
      s.pending = null;
      write(s);
    } else if (d.action === "clear") {
      s.pending = null;
      write(s);
    } else if (d.action === "settle") {
      s.lastGood = p.prev || s.lastGood;
      s.pending = null;
      write(s);
    } else if (d.action === "rollback" || d.action === "report") {
      const bad = base(p.to);
      if (!s.bad.includes(bad)) s.bad.push(bad);
      report(new Error(`${bad} did not become healthy (${boot.reason}); ${d.action}`), { component: "auto-update", "update.step": d.action, "update.version": bad });
      if (d.action === "rollback") {
        const prevFile = path.join(dir, p.prev.file);
        if ((await verifiedOnDisk(prevFile, p.prev)) && (await verifyPublisher("win32", prevFile, undefined, log))) {
          p.rolledBack = true;
          write(s);
          await stopRuntime();
          const child = spawn(prevFile, installArgs(), { detached: true, stdio: "ignore", windowsHide: true, ...spawnOptions });
          if (child && typeof child.unref === "function") child.unref();
          log(`${bad} unhealthy: rolling back to ${p.prev.version}`);
          const beat = setTimeoutImpl(() => quit(), QUIT_AFTER_SPAWN_MS);
          if (beat && typeof beat.unref === "function") beat.unref();
          // An 'error' event with no listener is fatal in the main process (app-update.js _restart has the why).
          if (child && typeof child.on === "function") {
            child.on("error", (err) => {
              clearTimeoutImpl(beat);
              log(`could not run ${p.prev.file}: ${err && err.message}`);
            });
          }
          return "rolling-back";
        }
        log(`${bad} unhealthy but ${p.prev.file} is not usable; staying on it`);
      }
      s.pending = null;
      write(s);
      return "reported";
    }
    return d.action;
  }

  return {
    offerable: (candidate) => offerable(running, candidate, read().bad),
    /** Installers pruneUpdates must leave alone: the rollback target and the one that got us here. */
    keepFiles() {
      const s = read();
      return new Set([s.lastGood && s.lastGood.file, s.pending && s.pending.prev && s.pending.prev.file].filter(Boolean));
    },
    /** Called right before the installer runs. `entry` is { file, bytes, sha256 } of the installer. */
    beginInstall({ to, entry }) {
      const s = read();
      const prev = s.lastGood && base(s.lastGood.version) === base(running) ? s.lastGood : null;
      s.pending = { from: running, to, entry, prev, rolledBack: false, at: now(), head: schemaHead(), strikes: 0 };
      write(s);
    },
    /** After the first boot ({ ok, reason }). Never throws; returns what it did. */
    async afterBoot(boot) {
      try {
        return await settle(boot);
      } catch (err) {
        report(err, { component: "auto-update", "update.step": "rollback" });
        return "error";
      }
    },
    state: read,
  };
}

module.exports = { STATE_FILE, offerable, decideBoot, createRollback };
