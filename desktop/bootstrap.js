"use strict";

/**
 * The asar entry, and the only main-process code that needs an installer to change.
 *
 * It takes the single-instance lock, starts the payload client, and requires
 * `<payload dir>/main.js` — the rest of desktop/ (payload-tree.cjs lists it), which the client
 * hot-swaps (see payload-swap.js for when). Electron, native modules and node_modules stay here.
 * app-update.js (the installer updater) and update-signing.js (the pinned keys) stay here too:
 * a payload must not be able to change what it trusts.
 *
 * Unpackaged (`electron .`), the payload is this directory and there is no client.
 */
const { app } = require("electron");
const path = require("node:path");
const Module = require("node:module");
const { singleInstance, createLog } = require("@masora/desktop-kit");
const cfg = require("./payload-config.js");
const { installCrashGuard } = require("./crash-guard.js");
const { createClient } = require("./payload-client.js");
const { sweepUntilClean } = require("./payload-sweep.js");
const bg = require("./background-update.js");

const bootLog = createLog({ dir: app.getPath("logs"), name: "zevet-boot" });
const log = (m) => { try { console.log(`[zevet-payload] ${m}`); } catch { /* a closed stdout */ } bootLog.info(m); };
// First thing: no uncaught error or closed pipe may ever reach Electron's "A JavaScript error occurred" dialog.
installCrashGuard({ log: (m) => bootLog.error(m) });

/** What main.js (in the payload) may reach: the client, and things only the shell owns. */
const shell = {
  version: cfg.SHELL_VERSION,
  build: app.getVersion(),
  source: "shell",
  payload: null,
  trial: null,
  dir: __dirname,
  /** main.js sets this: what a second launch does. */
  onSecondInstance: null,
  require: (id) => require(id),
  log,
};
globalThis.__zevetShell = shell;

async function run() {
  // `zevet --background-update` (the hourly OS job): no window, no payload, no main.js. It takes the lock itself.
  if (bg.isBackgroundLaunch(process.argv) || bg.isRegisterLaunch(process.argv)) return require("./background-entry.js").main({ log });

  // One app per profile. ZEVET_ALLOW_MULTI=1 skips the lock — see the two-instance rig; it needs a separate ZEVET_HOME.
  // The OS job's own launch lands here as a second instance and must not raise or focus the window.
  const onSecond = (_event, argv) => { if (!bg.isBackgroundLaunch(argv) && !bg.isRegisterLaunch(argv) && shell.onSecondInstance) shell.onSecondInstance(); };
  if (process.env.ZEVET_ALLOW_MULTI !== "1" && !singleInstance(app, onSecond)) return;

  let dir = __dirname;
  const platform = cfg.platformKey();
  if (app.isPackaged && platform) dir = await startPayload(platform);
  if (!dir) return; // the entry check failed and a relaunch is under way
  registerBackgroundJob();

  // The payload lives outside the asar, so it cannot see this node_modules by walking up. Point the
  // resolver at it once and put the env back: NODE_PATH must not leak into the agents main spawns.
  const prev = process.env.NODE_PATH;
  process.env.NODE_PATH = [path.join(shell.dir, "node_modules"), prev].filter(Boolean).join(path.delimiter);
  Module._initPaths();
  if (prev === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = prev;

  try {
    require(path.join(dir, "main.js"));
  } catch (err) {
    bootFailed(`main.js threw at load: ${err && err.stack || err}`);
  }
}

/** Resolve the build to run, check its entry points, arm the trial crash guard. Returns its dir. */
async function startPayload(platform) {
  const { client: payload, root } = createClient({ app, platform, log });
  shell.payload = payload;
  // A cold launch is the safest moment to apply a staged build: nothing is running yet. The idle swapper and
  // will-quit never fire after a kill, crash, reboot or logoff. activate() writes current.json as a trial, so
  // resolve() returns it with trial:true and the confirm / 3-strike revert covers a bad build.
  try {
    const staged = payload.staged();
    if (staged) {
      await payload.activate();
      log(`payload ${staged.build} staged; applied at launch`);
    }
  } catch (err) {
    log(`applying the staged payload at launch failed, booting current: ${err && err.message || err}`);
  }
  const cur = payload.resolve();
  shell.build = cur.build;
  shell.source = cur.source;
  log(`running payload ${cur.build} (${cur.source}${cur.trial ? ", trial" : ""}) from ${cur.dir}`);

  if (cur.source !== "seed") {
    try {
      await payload.verifyEntry(["main.js", "preload.js", "zevet-mcp.js"]);
    } catch (err) {
      payload.revert(`entry point failed verification: ${err.message}`);
      relaunch(1);
      return null;
    }
  }
  if (cur.trial) {
    const onCrash = (err) => bootFailed(`uncaught exception during trial: ${err && err.stack || err}`);
    process.on("uncaughtException", onCrash);
    shell.trial = {
      // confirm() writes the verdict and then gc()s old versions; gc can throw EPERM on Windows. The build is
      // confirmed either way, so the crash guard always comes off, and the sweep retries once, later.
      confirm: () => {
        try {
          payload.confirm();
        } catch (err) {
          log(`payload confirmed; old-version cleanup failed (${err && err.message}); retrying in 10 minutes`);
          // Per tree, with retries, naming whatever holds one; gc() stops at the first tree Windows refuses.
          sweepUntilClean({ root, log }).catch((e) => log(`old-version cleanup crashed: ${e && e.message}`));
        } finally {
          process.removeListener("uncaughtException", onCrash);
        }
      },
      bootFailed: (why) => payload.bootFailed(why),
    };
  }
  // After ready, so a check never delays the first window.
  app.whenReady().then(() => payload.start({ everyMs: Number(process.env.ZEVET_PAYLOAD_CHECK_MS) || 120000 }));
  return cur.dir;
}

/** A failed trial boot is a strike; the third reverts. The seed itself has no fallback, so it just fails. */
function bootFailed(reason) {
  console.error(`zevet: ${reason}`);
  if (!shell.payload || shell.source === "seed") throw new Error(reason);
  try { shell.payload.bootFailed(reason); } catch (e) { log(`bootFailed threw: ${e.message}`); }
  relaunch(1);
}

function relaunch(code) {
  app.relaunch();
  app.exit(code);
}

/** The hourly OS job that updates zevet while it is closed (background-update.js). Every launch re-asserts it. */
function registerBackgroundJob() {
  const { misplacedReason } = require("./app-update.js");
  if (!bg.mayRegister({ isPackaged: app.isPackaged, execPath: process.execPath, misplaced: process.platform === "win32" ? misplacedReason : () => null })) return;
  const { execFile } = require("node:child_process");
  const run = (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
  });
  const dir = path.join(app.getPath("userData"), "updates");
  app.whenReady()
    .then(() => bg.ensureBackgroundJob({ dir, run, log: (m) => log(`[background-update] ${m}`) }))
    .then((r) => { if (r !== "unchanged") log(`[background-update] job: ${r}`); })
    .catch((err) => log(`[background-update] registration failed: ${err && err.message}`));
}

shell.booted = run().catch((err) => bootFailed(`bootstrap failed: ${err && err.stack || err}`));
