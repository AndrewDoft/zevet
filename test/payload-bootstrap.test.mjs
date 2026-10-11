// bootstrap.js (the asar entry), the shell/payload split it depends on, and the shared config.
// bootstrap.js needs Electron and the kit's payload client, so it is loaded here with both faked.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = path.join(ROOT, "desktop");
const require = createRequire(import.meta.url);
const cfg = require(path.join(DESKTOP, "payload-config.js"));
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, "package.json"), "utf8"));

describe("payload-config", () => {
  test("seqOf is monotonic across patch, minor and major", async () => {
    const v = ["0.2.88", "0.2.89", "0.2.100", "0.3.0", "0.10.0", "1.0.0"].map(cfg.seqOf);
    assert.deepEqual(v, [...v].sort((a, b) => a - b));
    assert.equal(new Set(v).size, v.length);
    assert.equal(cfg.seqOf("0.2.89"), 2089);
  });
  test("seqOf refuses what it cannot order", async () => {
    assert.throws(() => cfg.seqOf("0.2.89-canary.1"));
    assert.throws(() => cfg.seqOf("0.2.1000"));
  });
  test("only the two shipped platforms have a payload", async () => {
    assert.equal(cfg.platformKey("win32", "x64"), "win-x64");
    assert.equal(cfg.platformKey("darwin", "arm64"), "mac-arm64");
    assert.equal(cfg.platformKey("linux", "x64"), null);
    assert.equal(cfg.platformKey("win32", "arm64"), null);
  });
  test("the payload root is LOCALAPPDATA on Windows (never Roaming) and Application Support on macOS", async () => {
    assert.equal(cfg.payloadRoot({ LOCALAPPDATA: "C:\\L" }, "win32", "C:\\H"), path.join("C:\\L", "Zevet", "payload"));
    assert.equal(cfg.payloadRoot({}, "win32", "C:\\H"), path.join("C:\\H", "AppData", "Local", "Zevet", "payload"));
    assert.equal(cfg.payloadRoot({}, "darwin", "/Users/a"), path.join("/Users/a", "Library", "Application Support", "Zevet", "payload"));
    assert.equal(cfg.payloadRoot({ ZEVET_PAYLOAD_ROOT: "/x" }, "darwin", "/Users/a"), "/x");
  });
  test("the pulse lives where the plan's wire format puts it, and only an env var moves it", async () => {
    assert.equal(cfg.pulseUrl("canary", "win-x64", {}), "https://usemasora.com/download/p/zevet/canary/win-x64/pulse.json");
    assert.equal(cfg.pulseUrl("canary", "win-x64", { ZEVET_PAYLOAD_PULSE: "http://127.0.0.1:1/pulse.json" }), "http://127.0.0.1:1/pulse.json");
  });
});

describe("the shell/payload split", () => {
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const shellFiles = new Set(pkg.build.files.filter((f) => !f.startsWith("!")));

  test("the asar entry is bootstrap.js and ships with what it needs and nothing more", async () => {
    assert.equal(pkg.main, "bootstrap.js");
    assert.ok(shellFiles.has("bootstrap.js"));
    assert.equal(pkg.payload.files.some((f) => shellFiles.has(f)), false, "a file is in both the shell and the payload");
    assert.equal(pkg.payload.files.includes("main.js"), true);
  });
  test("every local module the shell requires is in the shell", async () => {
    for (const f of shellFiles) {
      for (const [, dep] of stripComments(fs.readFileSync(path.join(DESKTOP, f), "utf8")).matchAll(/(?<![.\w])require\("\.\/([^"]+)"\)/g)) {
        assert.ok(shellFiles.has(dep), `${f} requires ./${dep}, which the installer does not carry`);
      }
    }
  });
  test("every relative require in a payload file resolves inside the payload; bootShell.require only reaches the shell", async () => {
    const payloadFiles = new Set(pkg.payload.files.filter((f) => !f.endsWith("/**")));
    for (const f of payloadFiles.has("main.js") ? [...payloadFiles].filter((f) => /\.[cm]?js$/.test(f)) : []) {
      const src = stripComments(fs.readFileSync(path.join(DESKTOP, f), "utf8"));
      for (const [, dep] of src.matchAll(/(?<![.\w])require\("\.\/([^"]+)"\)/g)) {
        const ok = payloadFiles.has(dep) || pkg.payload.files.some((p) => p.endsWith("/**") && dep.startsWith(p.slice(0, -2)));
        assert.ok(ok, `${f} requires ./${dep}, which is not in the payload (a shell module goes through bootShell.require)`);
      }
      for (const [, dep] of src.matchAll(/bootShell\.require\("\.\/([^"]+)"\)/g)) assert.ok(shellFiles.has(dep), `${f} bootShell.requires ./${dep}, which the shell does not carry`);
    }
  });
  test("the pinned keys and the installer updater stay in the shell: a payload cannot change what it trusts", async () => {
    for (const f of ["update-signing.js", "app-update.js", "update-rollback.js"]) {
      assert.ok(shellFiles.has(f), `${f} left the shell`);
      assert.equal(pkg.payload.files.includes(f), false);
    }
  });
  test("the family index and idle install are payload; they reach keys only through main.js", async () => {
    for (const f of ["family-index.js", "idle-install.js"]) {
      assert.ok(pkg.payload.files.includes(f));
      assert.doesNotMatch(stripComments(fs.readFileSync(path.join(DESKTOP, f), "utf8")), /require\("\.\/update-signing\.js"\)/);
    }
  });
  test("the installer carries the payload tree as resources/app-core", async () => {
    assert.ok(pkg.build.extraResources.some((r) => r.from === "app-core" && r.to === "app-core"));
  });
  test("the staged tree is the listed files, the client modules and a package.json, and nothing of the shell", async () => {
    const icon = path.join(DESKTOP, "build", "icon.png");
    if (!fs.existsSync(icon)) require("node:child_process").execFileSync(process.execPath, ["make-icon.mjs"], { cwd: DESKTOP });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zevet-tree-"));
    try {
      const staged = require(path.join(DESKTOP, "payload-tree.cjs")).stage(dir);
      for (const f of pkg.payload.files.filter((f) => !f.endsWith("/**"))) assert.ok(fs.existsSync(path.join(staged, f)), `${f} was not staged`);
      assert.ok(fs.existsSync(path.join(staged, "fonts")));
      assert.ok(fs.existsSync(path.join(staged, "client", "secret.mjs")), "the client modules are not in the payload");
      for (const f of shellFiles) assert.equal(fs.existsSync(path.join(staged, f)), false, `${f} leaked into the payload`);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(staged, "package.json"), "utf8")), { name: "zevet-payload", private: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Load bootstrap.js fresh with a fake Electron app and a fake payload client. */
async function boot({ packaged = true, lock = true, resolved = {}, verifyThrows = false, mainSrc, multi = false, argv } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zevet-boot-"));
  const payloadDir = path.join(dir, "versions", "0.2.90");
  fs.mkdirSync(payloadDir, { recursive: true });
  const log = [];
  const handlers = {};
  globalThis.__bootTest = { loaded: 0, nodePathDuringLoad: "unset" };
  fs.writeFileSync(payloadDir + "/main.js", mainSrc ?? "globalThis.__bootTest.loaded++; globalThis.__bootTest.nodePathDuringLoad = process.env.NODE_PATH;");
  const client = {
    resolve: () => ({ dir: payloadDir, build: "0.2.90", source: "current", trial: false, ...resolved }),
    verifyEntry: async () => {
      if (verifyThrows) throw new Error("hash mismatch");
      log.push("verifyEntry");
    },
    revert: (why) => log.push(`revert ${why}`),
    bootFailed: (why) => {
      log.push(`bootFailed ${why.split(":")[0]}`);
      return { reverted: false };
    },
    confirm: () => log.push("confirm"),
    start: () => log.push("start"),
    on: () => {},
  };
  const app = {
    isPackaged: packaged,
    getVersion: () => "0.2.89",
    getPath: () => dir,
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => { log.push("lock requested"); return lock; },
    on: (ev, fn) => { handlers[ev] = fn; },
    quit: () => log.push("quit"),
    relaunch: () => log.push("relaunch"),
    exit: (c) => log.push(`exit ${c}`),
  };
  process.resourcesPath = path.join(dir, "resources");
  const load = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "electron") return { app };
    if (!packaged && request === path.join(DESKTOP, "main.js")) return log.push("dev main.js") && {};
    if (request === "@masora/desktop-kit/lib/payload") return { createPayloadClient: () => client };
    return load.call(this, request, ...rest);
  };
  const env = { ...process.env };
  process.env.ZEVET_PAYLOAD_ROOT = path.join(dir, "payload-root");
  if (multi) process.env.ZEVET_ALLOW_MULTI = "1";
  else delete process.env.ZEVET_ALLOW_MULTI;
  const file = path.join(DESKTOP, "bootstrap.js");
  delete require.cache[file];
  const listenersBefore = process.listeners("uncaughtException");
  // A payload exists only for win-x64 and mac-arm64: pretend to be one whatever host runs this (Linux CI).
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const realArch = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "platform", { value: "win32" });
  Object.defineProperty(process, "arch", { value: "x64" });
  const realArgv = process.argv;
  if (argv) process.argv = [realArgv[0], ...argv];
  let threw = null;
  try {
    require(file);
    await globalThis.__zevetShell.booted;
  } catch (e) {
    threw = e;
  } finally {
    process.argv = realArgv;
    Object.defineProperty(process, "platform", realPlatform);
    Object.defineProperty(process, "arch", realArch);
    Module._load = load;
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
  }
  // crash-guard.js's permanent listeners (zevetGuard*) are not the trial guard; they must not outlive the rig either.
  const added = process.listeners("uncaughtException").filter((l) => !listenersBefore.includes(l));
  const guards = added.filter((l) => !l.name.startsWith("zevetGuard"));
  const cleanup = () => {
    for (const g of added) process.removeListener("uncaughtException", g);
    for (const ev of ["unhandledRejection"]) for (const l of process.listeners(ev)) if (l.name.startsWith("zevetGuard")) process.removeListener(ev, l);
    for (const st of [process.stdout, process.stderr]) for (const l of st.listeners("error")) if (l.name.startsWith("zevetGuard")) st.removeListener("error", l);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { log, threw, guards, handlers, dir, shell: globalThis.__zevetShell, state: globalThis.__bootTest, cleanup };
}

describe("bootstrap.js", () => {
  let r;
  afterEach(() => {
    if (r) r.cleanup();
    r = null;
    delete process.resourcesPath;
  });

  test("a healthy current build: entry points are verified, main.js from the payload dir is loaded, the client starts", async () => {
    r = await boot();
    assert.equal(r.threw, null);
    assert.equal(r.state.loaded, 1);
    assert.ok(r.log.includes("verifyEntry"));
    assert.equal(r.shell.build, "0.2.90", "the build main.js sees is the payload's, not the installer's");
    await new Promise((res) => setImmediate(res));
    assert.ok(r.log.includes("start"), "the client never started checking");
  });
  test("NODE_PATH is used to reach the shell's node_modules, and is gone again while main.js runs", async () => {
    delete process.env.NODE_PATH;
    r = await boot();
    assert.equal(r.state.nodePathDuringLoad, undefined, "NODE_PATH must not be set while the payload runs: spawned agents inherit it");
    assert.equal(process.env.NODE_PATH, undefined);
  });
  test("a second instance loads nothing", async () => {
    r = await boot({ lock: false });
    assert.equal(r.state.loaded, 0);
    assert.ok(r.log.includes("quit"));
  });
  test("an entry point that fails its hash is reverted, main.js is never loaded, and the app relaunches", async () => {
    r = await boot({ verifyThrows: true });
    assert.equal(r.state.loaded, 0);
    assert.ok(r.log.some((l) => l.startsWith("revert entry point failed verification")));
    assert.deepEqual(r.log.slice(-2), ["relaunch", "exit 1"]);
    assert.equal(r.log.filter((l) => l === "relaunch").length, 1, "one relaunch, not one per failure path");
    assert.equal(r.log.some((l) => l.startsWith("bootFailed")), false, "a failed hash is a revert, not a boot strike on top of it");
  });
  test("ZEVET_ALLOW_MULTI=1 skips the lock entirely (the two-instance rig)", async () => {
    r = await boot({ multi: true, lock: false });
    assert.equal(r.log.includes("lock requested"), false);
    assert.equal(r.state.loaded, 1);
  });
  test("the seed is not hash-checked against a manifest (it has none)", async () => {
    r = await boot({ resolved: { source: "seed" } });
    assert.equal(r.log.includes("verifyEntry"), false);
    assert.equal(r.state.loaded, 1);
  });
  test("a trial build whose main.js throws at load is a strike and a relaunch", async () => {
    r = await boot({ resolved: { trial: true }, mainSrc: 'throw new Error("boom")' });
    assert.equal(r.threw, null);
    assert.ok(r.log.includes("bootFailed main.js threw at load"));
    assert.deepEqual(r.log.slice(-2), ["relaunch", "exit 1"]);
  });
  test("the seed that throws at load is a real failure: no strike, no relaunch loop", async () => {
    r = await boot({ resolved: { source: "seed" }, mainSrc: 'throw new Error("boom")' });
    assert.match(String(r.threw), /main\.js threw at load/);
    assert.equal(r.log.includes("relaunch"), false);
  });
  test("a trial build arms a crash guard that a confirmed one removes", async () => {
    r = await boot({ resolved: { trial: true } });
    assert.equal(r.guards.length, 1);
    r.shell.trial.confirm();
    assert.equal(process.listeners("uncaughtException").includes(r.guards[0]), false);
    assert.ok(r.log.includes("confirm"));
  });
  test("the hourly OS job's launch is a second instance that must not focus or open the window", async () => {
    r = await boot({});
    let focused = 0;
    r.shell.onSecondInstance = () => { focused++; };
    r.handlers["second-instance"]({}, ["zevet.exe", "--background-update"]);
    r.handlers["second-instance"]({}, ["zevet.exe", "--register-background-update"]);
    assert.equal(focused, 0);
    r.handlers["second-instance"]({}, ["zevet.exe"]);
    assert.equal(focused, 1, "a person's own second launch still focuses the window");
  });
  test("--background-update never reaches main.js, the payload or the app's lock: while zevet runs it logs a start and an outcome and exits", async () => {
    r = await boot({ lock: false, argv: ["--background-update"] });
    assert.equal(r.state.loaded, 0);
    assert.equal(r.log.includes("start"), false, "the payload client must not start");
    const text = fs.readFileSync(path.join(r.dir, "zevet-boot.log"), "utf8");
    assert.match(text, /\[background-update\] start: shell 0\.2\.89, payload 0\.2\.89, zevet is running/);
    assert.match(text, /\[background-update\] outcome: payload zevet is running; it updates itself; shell zevet is running; it updates itself/);
    assert.ok(r.log.includes("exit 0"));
  });
  test("unpackaged, there is no client: the shell's own directory is the payload", async () => {
    r = await boot({ packaged: false });
    assert.equal(r.shell.payload, null);
    assert.deepEqual(r.log, ["lock requested", "dev main.js"]);
    assert.equal(r.guards.length, 0);
  });
});
