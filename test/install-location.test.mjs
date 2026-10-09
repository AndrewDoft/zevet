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
const { AppUpdater, winInstallLocation, winInstallArgs, misplacedReason, defaultInstallDir, INSTALL_ARGS } = require(path.join(ROOT, "desktop", "app-update.js"));
const win = (...p) => path.win32.join(...p);

describe("a copy running from a non-install location installs to the default dir", () => {
  const devExe = win("C:", "dev", "zevet-autoship", "zevet-ship", "desktop", "node_modules", "electron", "dist", "zevet.exe");

  test("node_modules is misplaced; Program Files is not", () => {
    assert.match(misplacedReason(devExe), /node_modules/);
    assert.equal(misplacedReason(win("C:", "Program Files", "zevet", "zevet.exe")), null);
  });

  test("winInstallArgs sends it to <ProgramFiles>\zevet, /allusers, /D= last", () => {
    const args = winInstallArgs(INSTALL_ARGS, devExe);
    assert.deepEqual(args, [...INSTALL_ARGS, "/allusers", `/D=${defaultInstallDir()}`]);
    assert.ok(!args.at(-1).includes("node_modules"));
    assert.equal(winInstallLocation(devExe).dir, defaultInstallDir());
  });

  test("a git checkout or worktree is misplaced", { skip: process.platform !== "win32" && "win32 paths" }, (t) => {
    const d = tempDir("zevet checkout ");
    t.after(d.cleanup);
    mkdirSync(path.join(d.dir, "dist"), { recursive: true });
    writeFileSync(path.join(d.dir, ".git"), "gitdir: elsewhere\n"); // a worktree's .git is a file
    assert.match(misplacedReason(path.join(d.dir, "dist", "zevet.exe")), /git checkout/);
  });

  test("the updater logs why and spawns the installer at the default dir", async (t) => {
    const d = tempDir("zevet upd ");
    t.after(d.cleanup);
    const file = path.join(d.dir, "setup.exe");
    writeFileSync(file, "x");
    const calls = [];
    const logs = [];
    const u = new AppUpdater({
      currentVersion: "0.1.2", platform: "win32", dir: d.dir, execPath: devExe, log: (m) => logs.push(m),
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
