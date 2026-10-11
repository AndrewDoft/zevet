// `zevet --background-update` / `--register-background-update`. bootstrap.js hands over before it takes the app's
// lock, starts the payload client or requires main.js, so this process creates no window, tray or runtime and can
// show nothing. The decisions live in background-update.js; this is only the Electron wiring (mirrors masora2's
// background-entry.js).
"use strict";

const { app } = require("electron");
const { spawn, execFile } = require("node:child_process");
const path = require("node:path");
const { singleInstance } = require("@masora/desktop-kit");

const cfg = require("./payload-config.js");
const { createClient } = require("./payload-client.js");
const { sweepOldVersions, describeSweep } = require("./payload-sweep.js");
const { AppUpdater, loopbackProofKeys, INSTALL_ARGS, winInstallArgs } = require("./app-update.js");
const { createRollback } = require("./update-rollback.js");

/** app-update.js quits 600 ms after spawning the installer; the job waits that long, plus a beat, for it to run. */
const QUIT_AFTER_SPAWN_MS = 600;
const bg = require("./background-update.js");

/** Hidden by construction: no console, no window. */
const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
});

function main({ log: bootLog }) {
  const log = (m) => bootLog(`[background-update] ${m}`);
  const exit = (code = 0) => app.exit(code);
  // The task's own time limit is the hard stop; this one is the soft stop.
  setTimeout(() => exit(0), 25 * 60 * 1000).unref();

  const dir = path.join(app.getPath("userData"), "updates");
  const running = app.getVersion();
  const testHooks = process.env.ZEVET_TEST_HOOKS === "1";

  if (!app.isPackaged && !testHooks) {   // a source checkout has no installer to replace
    log("start: unpackaged dev run");
    log("outcome: skipped (unpackaged dev run)");
    return Promise.resolve(exit(0));
  }

  if (bg.isRegisterLaunch(process.argv)) {
    return app.whenReady()
      .then(() => bg.ensureBackgroundJob({ dir, run, log }))
      .then((r) => log(`register: ${r}`))
      .catch((err) => log(`register failed: ${err && err.message}`))
      .finally(() => exit(0));
  }

  let launched = false;
  const gotLock = singleInstance(app, () => {
    // A person opened zevet while this was working: hand them the app, not an installer.
    launched = true;
    log("zevet was launched; abandoning the background update");
    app.releaseSingleInstanceLock();
    app.relaunch({ args: process.argv.slice(1).filter((a) => a !== bg.BACKGROUND_ARG) });
    exit(0);
  });
  if (!gotLock) {   // zevet is running: it updates itself. Still one start and one outcome line.
    return bg.runBackgroundUpdate({ lockHeld: false, running, dir, log }).then(() => exit(0));
  }

  const platform = cfg.platformKey();
  let updater;
  const rollback = createRollback({
    dir, running, spawn,
    installArgs: () => winInstallArgs(INSTALL_ARGS, process.execPath),
    spawnOptions: { windowsVerbatimArguments: true },   // winInstallArgs ends in an unquoted /D=
    verifyPublisher: async (_platform, file) => (await updater._publisherProblem(file)) === null,
    verifiedOnDisk: (file, entry) => updater._verified(file, entry),
    stopRuntime: async () => {}, quit: () => exit(0), log,
  });
  updater = new AppUpdater({
    rollback, currentVersion: running,
    feedUrl: process.env.ZEVET_APP_FEED || undefined,
    trustedKeys: loopbackProofKeys(process.env.ZEVET_APP_FEED),
    isPackaged: app.isPackaged, dir,
    bundlePath: process.platform === "darwin" ? path.dirname(path.dirname(path.dirname(app.getPath("exe")))) : undefined,
    quitImpl: () => exit(0), log,
  });

  return app.whenReady()
    .then(async () => {
      let payload = null, root = null, build = running;
      if (platform) {
        const made = createClient({ app, platform, log });
        payload = made.client;
        root = made.root;
        try { build = payload.resolve().build; } catch { /* the seed is absent in a source run */ }
      } else {
        payload = { check: async () => ({ status: "none" }), staged: () => null };
      }
      return bg.runBackgroundUpdate({
        lockHeld: true, payload, updater, rollback, running, build, dir,
        canInstall: () => (process.platform === "win32" ? bg.installDirWritable(path.dirname(process.execPath)) : process.platform === "darwin" && updater.canSelfReplaceMac()),
        sweep: async () => { if (root) { const line = describeSweep(await sweepOldVersions({ root })); if (line) log(line); } },
        aborted: () => launched, log,
      });
    })
    .catch((err) => { log(`crashed: ${err && err.stack || err}`); log(`outcome: error ${err && err.message}`); return { shell: "error" }; })
    .then((result) => {
      // The installer replaces our own files; leave a beat so it runs.
      if (result && String(result.shell).startsWith("installing")) setTimeout(() => exit(0), QUIT_AFTER_SPAWN_MS + 400);
      else exit(0);
    });
}

module.exports = { main };
