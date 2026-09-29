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
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
const { singleInstance, createLog } = require("@masora/desktop-kit");
const cfg = require("./payload-config.js");

const bootLog = createLog({ dir: app.getPath("logs"), name: "zevet-boot" });
const log = (m) => { console.log(`[zevet-payload] ${m}`); bootLog.info(m); };

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
  // One app per profile. ZEVET_ALLOW_MULTI=1 skips the lock — see the two-instance rig; it needs a separate ZEVET_HOME.
  if (process.env.ZEVET_ALLOW_MULTI !== "1" && !singleInstance(app, () => shell.onSecondInstance && shell.onSecondInstance())) return;

  let dir = __dirname;
  const platform = cfg.platformKey();
  if (app.isPackaged && platform) dir = await startPayload(platform);
  if (!dir) return; // the entry check failed and a relaunch is under way

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
  const root = cfg.payloadRoot();
  const channel = process.env.ZEVET_PAYLOAD_CHANNEL || readTrim(path.join(root, "channel")) || "stable";
  const pulse = cfg.pulseUrl(channel, platform);
  const { PINNED_KEYS } = require("./update-signing.js");
  const { loopbackProofKeys } = require("./app-update.js");
  const { createPayloadClient } = require("@masora/desktop-kit/lib/payload");
  const payload = createPayloadClient({
    app: "zevet", channel, platform, root,
    seedDir: path.join(process.resourcesPath, "app-core"),
    seedBuild: app.getVersion(), seedSeq: cfg.seqOf(app.getVersion()),
    pulseUrl: pulse,
    keys: loopbackProofKeys(pulse) || PINNED_KEYS,
    shellVersion: cfg.SHELL_VERSION,
    schemaHead: async () => null,
    installId: installId(root),
    log,
  });
  shell.payload = payload;
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
      confirm: () => { payload.confirm(); process.removeListener("uncaughtException", onCrash); },
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

function readTrim(file) {
  try { return fs.readFileSync(file, "utf8").trim(); } catch { return ""; }
}

/** Stable per install, for rollout bucketing. */
function installId(root) {
  const file = path.join(root, "install-id");
  let id = readTrim(file);
  if (!id) {
    id = crypto.randomUUID();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(file, id);
  }
  return id;
}

shell.booted = run().catch((err) => bootFailed(`bootstrap failed: ${err && err.stack || err}`));
