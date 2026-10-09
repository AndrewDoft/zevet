// bootstrap.js startPayload applies a staged build at launch. The shell is loaded for real with electron,
// desktop-kit and payload-config stubbed, so this exercises the actual boot order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const Module = require("node:module");
const BOOT = path.join(ROOT, "desktop", "bootstrap.js");

async function boot({ staged, activate }) {
  const calls = [];
  let current = { build: "0.2.89", dir: "cur", source: "store", trial: false };
  const payload = {
    staged: () => staged,
    activate: async () => {
      calls.push("activate");
      await activate();
      current = { build: staged.build, dir: "new", source: "store", trial: true };
    },
    resolve: () => { calls.push("resolve"); return current; },
    verifyEntry: async () => {}, revert: () => {}, confirm: () => {}, bootFailed: () => {}, start: () => {}, check: async () => ({ status: "none" }),
  };
  const stubs = {
    electron: { app: { isPackaged: true, getVersion: () => "0.2.89", getPath: () => ROOT, whenReady: () => Promise.resolve(), relaunch() {}, exit() {} } },
    "@masora/desktop-kit": { singleInstance: () => true, createLog: () => ({ info() {} }) },
    "@masora/desktop-kit/lib/payload": { createPayloadClient: () => payload },
    "./payload-config.js": { SHELL_VERSION: 1, platformKey: () => "win-x64", payloadRoot: () => path.join(ROOT, "test", "_none"), pulseUrl: () => "https://x/p", seqOf: () => 2089 },
    "./update-signing.js": { PINNED_KEYS: {} },
    "./app-update.js": { loopbackProofKeys: () => null },
  };
  const load = Module._load;
  Module._load = function (req, parent, ...rest) {
    if (req in stubs && (parent?.filename === BOOT || req.startsWith("@masora") || req === "electron")) return stubs[req];
    if (parent?.filename === BOOT && req.endsWith("main.js")) return {};
    return load.call(this, req, parent, ...rest);
  };
  const fsMod = require("node:fs");
  const wf = fsMod.writeFileSync, mk = fsMod.mkdirSync;
  fsMod.writeFileSync = () => {}; fsMod.mkdirSync = () => {};
  const logs = [];
  const cl = console.log; console.log = (m) => logs.push(String(m));
  try {
    delete require.cache[BOOT];
    process.resourcesPath ??= ROOT;
    require(BOOT);
    await globalThis.__zevetShell.booted;
    return { calls, logs, shell: globalThis.__zevetShell };
  } finally {
    Module._load = load; fsMod.writeFileSync = wf; fsMod.mkdirSync = mk; console.log = cl;
    delete require.cache[BOOT];
  }
}

test("a staged build is applied at launch and runs as a trial", async () => {
  const r = await boot({ staged: { build: "0.2.91" }, activate: async () => {} });
  assert.deepEqual(r.calls, ["activate", "resolve"]);
  assert.equal(r.shell.build, "0.2.91");
  assert.ok(r.logs.some((l) => l.includes("payload 0.2.91 staged; applied at launch")));
});

test("nothing staged: no activate, current runs", async () => {
  const r = await boot({ staged: null, activate: async () => {} });
  assert.deepEqual(r.calls, ["resolve"]);
  assert.equal(r.shell.build, "0.2.89");
});

test("activate throwing never blocks startup: boots current", async () => {
  const r = await boot({ staged: { build: "0.2.91" }, activate: async () => { throw new Error("bad-list"); } });
  assert.deepEqual(r.calls, ["activate", "resolve"]);
  assert.equal(r.shell.build, "0.2.89");
  assert.ok(r.logs.some((l) => l.includes("booting current")));
});
