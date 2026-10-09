// An update must never install into, or relaunch from, somebody's working tree.
// 2026-10-08: a harness-launched dev Electron ran the real updater, which uses
// dirname(process.execPath) as /D=, so 0.2.13x was installed INTO
// ...\node_modules\electron\dist, the HKLM uninstall entry and both Start Menu
// shortcuts followed it, and every update since landed there.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { tempDir, ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { AppUpdater, winInstallLocation, winInstallArgs, misplacedReason, defaultInstallDir, registeredScope, INSTALL_ARGS } = require(path.join(ROOT, "desktop", "app-update.js"));
const win = (...p) => path.win32.join(...p);

describe("a copy running from a non-install location installs to the default dir", () => {
  const devExe = win("C:", "dev", "zevet-autoship", "zevet-ship", "desktop", "node_modules", "electron", "dist", "zevet.exe");

  test("node_modules is misplaced; Program Files is not", () => {
    assert.match(misplacedReason(devExe), /node_modules/);
    assert.equal(misplacedReason(win("C:", "Program Files", "zevet", "zevet.exe")), null);
  });

  test("defaultInstallDir is the literal C:-Program Files-zevet when ProgramFiles is unset", () => {
    assert.equal(defaultInstallDir({}), "C:\\Program Files\\zevet");
    assert.equal(defaultInstallDir({ ProgramFiles: "D:\\PF" }), "D:\\PF\\zevet");
  });

  test("registered per-machine (Andrew's HKLM install): /allusers, Program Files, /D= last", () => {
    const args = winInstallArgs(INSTALL_ARGS, devExe, { registeredScope: () => "/allusers" });
    assert.deepEqual(args, [...INSTALL_ARGS, "/allusers", `/D=${defaultInstallDir()}`]);
    assert.ok(!args.at(-1).includes("node_modules"));
  });

  test("registered per-user: a misplaced copy stays /currentuser in %LOCALAPPDATA%-Programs-zevet", (t) => {
    const lad = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = win("C:", "Users", "kai", "AppData", "Local");
    t.after(() => { process.env.LOCALAPPDATA = lad; });
    const args = winInstallArgs(INSTALL_ARGS, devExe, { registeredScope: () => "/currentuser" });
    assert.deepEqual(args, [...INSTALL_ARGS, "/currentuser", `/D=${win("C:", "Users", "kai", "AppData", "Local", "Programs", "zevet")}`]);
  });

  test("registeredScope reads HKLM first, then HKCU, else /allusers", () => {
    const only = (hive) => (cmd, args) => { if (!args[1].startsWith(hive)) throw new Error("not found"); };
    assert.equal(registeredScope(only("HKLM")), "/allusers");
    assert.equal(registeredScope(only("HKCU")), "/currentuser");
    assert.equal(registeredScope(only("none")), "/allusers");
  });

  test("a normal per-user install under a home dir with `git init` (dotfiles) is NOT misplaced", { skip: process.platform !== "win32" && "win32 paths" }, (t) => {
    const home = tempDir("zevet home ");
    t.after(home.cleanup);
    writeFileSync(path.join(home.dir, ".git"), "gitdir: elsewhere");
    const lad = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = path.join(home.dir, "AppData", "Local");
    t.after(() => { process.env.LOCALAPPDATA = lad; });
    const exe = path.join(process.env.LOCALAPPDATA, "Programs", "zevet", "zevet.exe");
    assert.equal(misplacedReason(exe), null);
    const loc = winInstallLocation(exe, { registeredScope: () => { throw new Error("must not be consulted"); } });
    assert.deepEqual([loc.scope, loc.dir, loc.misplaced], ["/currentuser", path.win32.dirname(exe), undefined]);
  });

  test("the updater logs why and spawns the installer at the default dir", async (t) => {
    const d = tempDir("zevet upd ");
    t.after(d.cleanup);
    const file = path.join(d.dir, "setup.exe");
    writeFileSync(file, "x");
    const calls = [];
    const logs = [];
    const u = new AppUpdater({
      currentVersion: "0.1.2", platform: "win32", dir: d.dir, execPath: devExe, registeredScope: () => "/allusers", log: (m) => logs.push(m),
      spawnImpl: (...a) => (calls.push(a), { unref() {} }), quitImpl() {},
    });
    u.state.phase = "ready";
    u.state.file = file;
    u._readyEntry = { bytes: statSync(file).size, sha256: require("node:crypto").createHash("sha256").update(readFileSync(file)).digest("hex") };
    const r = await u.install();
    assert.equal(r.ok, true);
    assert.equal(calls[0][1].at(-1), `/D=${defaultInstallDir()}`);
    assert.ok(logs.some((m) => /non-install location/.test(m) && /node_modules/.test(m)), logs.join("\n"));
  });
});

describe("an unpackaged dev run never installs", () => {
  test("install() refuses and spawns nothing", async (t) => {
    const d = tempDir("zevet upd ");
    t.after(d.cleanup);
    const file = path.join(d.dir, "setup.exe");
    writeFileSync(file, "x");
    const calls = [];
    const u = new AppUpdater({
      currentVersion: "0.1.2", platform: "win32", dir: d.dir, isPackaged: false,
      execPath: win("C:", "Program Files", "zevet", "zevet.exe"),
      spawnImpl: (...a) => (calls.push(a), { unref() {} }), quitImpl() {},
    });
    u.state.phase = "ready";
    u.state.file = file;
    assert.equal((await u.steps.restart()).ok, false);
    assert.equal(u.steps.onQuit().ok, false);
    assert.equal(calls.length, 0);
    assert.match(await u._publisherProblem(file), /dev run/);
  });
});

describe("whatever launches Electron for tests cannot self-update", () => {
  test("drive.mjs sets ZEVET_NO_AUTOUPDATE and isolates userData", () => {
    const drive = readFileSync(path.join(ROOT, "scripts", "drive", "drive.mjs"), "utf8");
    assert.match(drive, /ZEVET_NO_AUTOUPDATE: "1"/);
    assert.match(drive, /--user-data-dir=\$\{userData\}/);
    assert.match(drive, /LOCALAPPDATA: path\.join\(base/);
  });
  test("main.js starts the updater only when packaged, un-disabled, or given a proof feed; and passes isPackaged", () => {
    const main = readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8");
    assert.match(main, /process\.env\.ZEVET_APP_FEED \|\| \(app\.isPackaged && process\.env\.ZEVET_NO_AUTOUPDATE !== "1"\)\) appUpdater\.start\(\)/);
    assert.match(main, /isPackaged: app\.isPackaged,/);
  });
});
