// Reproduces the SECOND, real incident found on Andrew's own machine after
// installer.nsh's customInit /D= fix (see repro-fresh-silent-install.mjs and
// installer.nsh's own header): every silent auto-update DID land somewhere
// and DID exit 0 -- just never in the copy that is actually running.
//
// Measured on Andrew's machine (read-only, 2026-09-28):
//   HKLM\...\Uninstall\<guid>: DisplayVersion 0.2.78, UninstallString in
//     C:\...\Temp\masora-real-install-JiPJgP\zevet -- that exe IS 0.2.78.
//   NO HKCU\...\Uninstall\<guid> entry at all.
//   %LOCALAPPDATA%\Programs\zevet\zevet.exe (what he actually launches) = 0.2.71.
//
// The temp directory's name matches masora2's own `test/live/
// sibling-install-real.mjs` harness (`fs.mkdtempSync(...,
// "masora-real-install-"))`, run with `/allusers /D=<that dir>` -- so that
// harness registered a PER-MACHINE install pointing at a temp folder, on a
// real dev box, and every update since has been silently landing there
// instead of the per-user copy Andrew actually runs, because
// desktop/app-update.js's install()/installOnQuit() used to pass NSIS only
// `--updated /S [--force-run]` -- no scope, no /D= -- so NSIS's own
// multiUser.nsh decided both from the registry. The fix
// (app-update.js's winInstallArgs) tells it explicitly instead: the scope
// and directory of `execPath`, the copy that is ACTUALLY RUNNING.
//
// This drives the REAL AppUpdater.installOnQuit() -- not a re-implementation
// of its args -- with a real spawn of the real signed installers, on a real
// (disposable CI) Windows filesystem and registry, so a regression that
// stops installOnQuit() from calling winInstallArgs at all is exactly as
// caught as one inside winInstallArgs itself.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnInstallerWithRetry, ACCESS_VIOLATION_EXIT_CODE } from "./lib/spawn-installer-retry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(process.platform, "win32", "only meaningful on Windows");

const oldOutDir = path.resolve(process.argv[2] || "");
assert.ok(oldOutDir && fs.existsSync(oldOutDir), "usage: repro-registry-hijack.mjs <old-build-out-dir> [new-build-out-dir]");
const newOutDir = path.resolve(process.argv[3] || path.join(root, "desktop/out"));

const { AppUpdater } = createRequire(import.meta.url)(path.join(root, "desktop", "app-update.js"));

function findSetup(dir, version) {
  const file = path.join(dir, `zevet-${version}-windows-x64-setup.exe`);
  assert.ok(fs.existsSync(file), `${path.basename(file)} not in ${dir}`);
  return file;
}

const guid = "3e51149f-9c15-5e34-ad48-d31d2859aef2"; // com.andrewdoft.zevet, stable across builds
const perUserInstallRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "zevet");
// Same naming shape as the real incident and the same masora2 test harness.
const phantomRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "masora-real-install-")), "zevet");
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "zevet-registry-hijack-"));

function reg(...args) {
  return spawnSync("reg", args, { encoding: "utf8" });
}
function displayVersion(hive) {
  const r = reg("query", `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`, "/v", "DisplayVersion");
  const m = /DisplayVersion\s+REG_SZ\s+(.*)/.exec(r.stdout || "");
  return m ? m[1].trim() : null;
}

let pass;
let newSetup;
try {
  // ── Step 1: a REAL per-user install of the OLD build, bare /S -- exactly
  // production's own shape (app-update.js's INSTALL_ARGS/QUIT_INSTALL_ARGS
  // never pass a mode flag, and a real fresh install never gets one either).
  const oldPkg = JSON.parse(fs.readFileSync(path.join(oldOutDir, "../package.json"), "utf8"));
  const oldSetup = findSetup(oldOutDir, oldPkg.version);
  const perUserInstall = spawnInstallerWithRetry(oldSetup, ["/S"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(perUserInstall.status, 0, `per-user install exited ${perUserInstall.status}: ${perUserInstall.stderr || perUserInstall.stdout}`);
  const perUserExe = path.join(perUserInstallRoot, "zevet.exe");
  assert.ok(fs.existsSync(perUserExe), `zevet.exe missing at ${perUserInstallRoot} after the per-user install`);
  console.log(`1. Per-user install: ${oldPkg.version} at ${perUserExe} -- this is "the copy Andrew actually runs".`);

  // ── Step 2: register a SECOND, per-machine copy elsewhere -- the exact
  // shape masora2's own sibling-install-real.mjs registers on a dev box, and
  // the shape still present on Andrew's real machine.
  const phantomInstall = spawnInstallerWithRetry(oldSetup, ["/S", "/allusers", `/D=${phantomRoot}`], {
    encoding: "utf8",
    timeout: 120_000,
    windowsVerbatimArguments: true,
  });
  assert.equal(phantomInstall.status, 0, `phantom per-machine install exited ${phantomInstall.status}: ${phantomInstall.stderr || phantomInstall.stdout}`);
  const phantomExe = path.join(phantomRoot, "zevet.exe");
  assert.ok(fs.existsSync(phantomExe), `zevet.exe missing at phantom root ${phantomRoot}`);
  const phantomVersionBefore = displayVersion("HKLM");
  assert.equal(phantomVersionBefore, oldPkg.version, `phantom install did not register HKLM DisplayVersion=${oldPkg.version}`);
  console.log(`2. Phantom per-machine install registered at ${phantomRoot} (HKLM DisplayVersion=${phantomVersionBefore}) -- masora2's test harness's own shape.`);

  // ── Step 3: the real event, through the REAL AppUpdater -- not a
  // reimplementation of its args. spawnImpl really spawns the real new
  // installer; this script only listens for its own exit so it can assert
  // on the result, same as a detached child normally would in production
  // (installOnQuit() itself never waits for it).
  const newPkg = JSON.parse(fs.readFileSync(path.join(root, "desktop/package.json"), "utf8"));
  assert.notEqual(newPkg.version, oldPkg.version, `the new build (${newPkg.version}) must differ from the old one (${oldPkg.version}) to prove an update happened`);
  newSetup = findSetup(newOutDir, newPkg.version);

  const capturedArgs = [];
  let resolveExit;
  const exited = new Promise((res) => { resolveExit = res; });
  // installOnQuit() calls spawnImpl exactly once, fire-and-forget (that IS
  // production's real shape -- see its own header) -- so the retry for the
  // known transient crash (spawn-installer-retry.mjs) happens here, inside
  // the 'exit' handler, by respawning with the SAME file/args/opts rather
  // than resolving, up to the same attempt budget.
  const RETRY_ATTEMPTS = 3;
  const u = new AppUpdater({
    platform: "win32",
    dir: scratchDir,
    execPath: perUserExe, // the copy actually running -- ground truth, not the registry
    spawnImpl: (file, args, opts) => {
      capturedArgs.push(args);
      const attempt = (n) => {
        const child = spawn(file, args, opts);
        child.on("exit", (code) => {
          if (code === ACCESS_VIOLATION_EXIT_CODE && n > 1) {
            console.log(`installer exited ${ACCESS_VIOLATION_EXIT_CODE} (${RETRY_ATTEMPTS - n + 1}/${RETRY_ATTEMPTS}) -- known transient runner crash, retrying`);
            attempt(n - 1);
          } else {
            resolveExit(code);
          }
        });
        child.on("error", (err) => resolveExit(err));
        return child;
      };
      return attempt(RETRY_ATTEMPTS);
    },
    quitImpl: () => {},
  });
  u.state.phase = "ready";
  u.state.file = newSetup;
  u._readyEntry = { bytes: fs.statSync(newSetup).size, sha256: createHash("sha256").update(fs.readFileSync(newSetup)).digest("hex") };

  const r = u.installOnQuit();
  assert.equal(r.ok, true, `installOnQuit() refused to run: ${r.error}`);
  console.log(`3. installOnQuit() ran: ${newSetup} ${capturedArgs[0].join(" ")}`);

  const exitResult = await Promise.race([
    exited,
    new Promise((_, rej) => setTimeout(() => rej(new Error("installer did not exit within 120s")), 120_000)),
  ]);
  assert.equal(exitResult, 0, `installer exited ${exitResult}`);

  // ── Step 4: prove the fix, not just "an install happened somewhere". The
  // copy that is ACTUALLY RUNNING must be the one that advanced; the
  // phantom per-machine copy that nothing launches must be untouched.
  const perUserVersionAfter = displayVersion("HKCU");
  const phantomVersionAfter = displayVersion("HKLM");
  console.log(`4. After update: HKCU DisplayVersion=${perUserVersionAfter}, HKLM (phantom) DisplayVersion=${phantomVersionAfter}`);
  assert.equal(perUserVersionAfter, newPkg.version, `the RUNNING per-user install's registry still says ${perUserVersionAfter}, expected the update to land there (${newPkg.version})`);
  assert.equal(phantomVersionAfter, oldPkg.version, `the phantom per-machine copy changed to ${phantomVersionAfter} -- the update hijacked it again instead of updating the running install`);
  console.log("REAL CHECK PASSED: installOnQuit() updated the copy that is actually running, and left the phantom per-machine copy alone.");
  pass = true;
} finally {
  // Best-effort only: this is a throwaway CI runner.
  try {
    const perUserUninstall = path.join(perUserInstallRoot, "Uninstall zevet.exe");
    if (fs.existsSync(perUserUninstall)) spawnSync(perUserUninstall, ["/S"], { timeout: 60_000 });
  } catch { /* best-effort cleanup */ }
  try {
    const phantomUninstall = path.join(phantomRoot, "Uninstall zevet.exe");
    if (fs.existsSync(phantomUninstall)) spawnSync(phantomUninstall, ["/S", "/allusers"], { timeout: 60_000 });
  } catch { /* best-effort cleanup */ }
  reg("delete", `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`, "/f");
  reg("delete", `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`, "/f");
  reg("delete", `HKCU\\Software\\${guid}`, "/f");
  reg("delete", `HKLM\\Software\\${guid}`, "/f");
  for (const dir of [perUserInstallRoot, path.dirname(phantomRoot), scratchDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  if (!pass) process.exitCode = 1;
}
