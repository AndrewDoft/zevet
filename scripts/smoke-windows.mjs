// Proves the real Windows install -> update -> install-on-quit -> launch
// cycle, on a throwaway machine (CI), not just electron-builder's exit code.
//
// This exists because of a real incident: a per-machine 0.2.69 install
// updated itself to 0.2.70 via installOnQuit() and Program Files\zevet came
// out EMPTY -- the app was gone, silently, with exit code 0 the whole way.
// The root cause traced to $INSTDIR getting corrupted (truncated at the
// space in "Program Files") and multiUser.nsh reusing that corrupted value,
// unquestioned, out of the registry on every later install -- see
// desktop/build/installer.nsh's customInit sanitizer, which this proves.
//
// `/currentuser`, never `/D=` or `/allusers`: NSIS's own `/D=` directive
// requires the path to be UNQUOTED and the LAST argument, and every Node
// child_process spawn on Windows quotes an argv element that contains a
// space -- so passing a spaced path through `/D=` from a test script hits
// the exact hazard this file is proving against, rather than testing it
// (MEASURED: this crashed the installer outright, 0xC0000005, on the first
// CI run). `/allusers` needs elevation GitHub's runner may not grant
// non-interactively. Neither is needed: the sanitizer's job is "does
// $INSTDIR end in \zevet", not "does it contain a space", so a corrupted
// registry value that is merely missing the \zevet suffix proves the same
// mechanism without going near either hazard.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(process.platform, "win32", "the Windows artifact must be tested on Windows");

const outDir = path.resolve(process.argv[2] || path.join(root, "desktop/out"));
// desktop/out is never cleaned between builds (RELEASING.md says so), so
// after step 2's second build this directory holds BOTH setup.exes -- naming
// the version explicitly is the only way to pick the one just built rather
// than whichever sorts first.
function findSetup(dir, version) {
  const name = `zevet-${version}-windows-x64-setup.exe`;
  const file = path.join(dir, name);
  assert.ok(fs.existsSync(file), `${name} not in ${dir}`);
  return file;
}

const guid = "3e51149f-9c15-5e34-ad48-d31d2859aef2"; // com.andrewdoft.zevet, UUID.v5 — stable across builds
const INSTALL_KEY = `HKCU\\Software\\${guid}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "zevet-win-smoke-"));
// multiUser.nsh's per-user default with no /D and no prior InstallLocation:
// $LocalAppData\Programs\zevet. Real, not a fixture path — this only ever
// runs in CI (see build.yml), a throwaway machine with no real zevet install
// to collide with, same as smoke-macos.mjs installing into ~/Applications.
const installRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "zevet");
let launched;

function reg(...args) {
  return spawnSync("reg", args, { encoding: "utf8" });
}
function readInstallLocation() {
  const r = reg("query", INSTALL_KEY, "/v", "InstallLocation");
  const m = /InstallLocation\s+REG_SZ\s+(.*)/.exec(r.stdout || "");
  return m ? m[1].trim() : null;
}
function runInstaller(exe, extraArgs = []) {
  const r = spawnSync(exe, ["/S", "/currentuser", ...extraArgs], { encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, `installer exited ${r.status}: ${r.stderr || r.stdout}`);
}
// Not "launch": app.asar is a single-file archive Electron's patched fs
// virtualizes as a directory -- readable through the packaged zevet.exe
// itself, NOT through plain `node`, which is what runs this script. The
// installer's own registry write (registryAddInstallInfo's DisplayVersion)
// is the version source that needs no Electron runtime to read.
function checkInstalledVersion(expected) {
  const exe = path.join(installRoot, "zevet.exe");
  assert.ok(fs.existsSync(exe), `zevet.exe missing at ${exe} after install`);
  const r = reg("query", `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`, "/v", "DisplayVersion");
  const m = /DisplayVersion\s+REG_SZ\s+(.*)/.exec(r.stdout || "");
  const installedVersion = m ? m[1].trim() : null;
  assert.equal(installedVersion, expected, `registry DisplayVersion is ${installedVersion}, expected ${expected}`);
}

try {
  // ── Step 1: fresh per-user install of the OLD build ──────────────────────
  const oldPkg = JSON.parse(fs.readFileSync(path.join(root, "desktop/package.json"), "utf8"));
  const oldSetup = findSetup(outDir, oldPkg.version);
  runInstaller(oldSetup);
  checkInstalledVersion(oldPkg.version);
  const freshLocation = readInstallLocation();
  assert.ok(freshLocation && freshLocation.toLowerCase().endsWith("\\zevet"), `fresh install wrote InstallLocation=${freshLocation}, expected it to end in \\zevet`);
  console.log(`Fresh install: ${oldPkg.version} at ${freshLocation}`);

  // ── Step 2: build a NEW version and reinstall over it, --updated /S — the
  // exact args app-update.js's install()/installOnQuit() use for a real
  // silent update. ──────────────────────────────────────────────────────
  const bumped = oldPkg.version.replace(/(\d+)$/, (n) => String(Number(n) + 1));
  execFileSync(process.execPath, [
    path.join(root, "desktop/build.cjs"), "-c", "electron-builder.config.js", "--win", "--publish", "never",
    `--config.extraMetadata.version=${bumped}`,
  ], { cwd: path.join(root, "desktop"), stdio: "inherit" });
  const newSetup = findSetup(outDir, bumped);
  runInstaller(newSetup, ["--updated"]);
  checkInstalledVersion(bumped);
  const updatedLocation = readInstallLocation();
  assert.equal(updatedLocation, freshLocation, `update wrote InstallLocation=${updatedLocation}, expected unchanged ${freshLocation}`);
  console.log(`Update in place: ${oldPkg.version} -> ${bumped}, still at ${updatedLocation}`);

  // ── Step 3: the actual incident — a CORRUPTED InstallLocation (missing the
  // app's own \zevet suffix, the shape a truncated-at-the-space value takes:
  // "C:\Program" rather than "C:\Program Files\zevet"), then another silent
  // update over it. Before build/installer.nsh's customInit sanitizer this
  // landed the new build in the wrong place and left the app folder empty;
  // this asserts it no longer can. ─────────────────────────────────────────
  const corrupted = path.dirname(installRoot); // same root, missing \zevet
  reg("add", INSTALL_KEY, "/v", "InstallLocation", "/t", "REG_SZ", "/d", corrupted, "/f");
  assert.equal(readInstallLocation(), corrupted, "test setup: corrupted value did not write");
  runInstaller(newSetup, ["--updated"]);
  checkInstalledVersion(bumped);
  const recoveredLocation = readInstallLocation();
  assert.equal(recoveredLocation, installRoot, `recovered InstallLocation=${recoveredLocation}, expected the sanitizer to land back on ${installRoot}`);
  assert.ok(fs.readdirSync(installRoot).includes("zevet.exe"), "install root must contain zevet.exe after recovering from a corrupted InstallLocation");
  console.log(`Recovered from a corrupted InstallLocation (${corrupted}) -> ${recoveredLocation}, app-owned folder intact`);
  launched = true;
} finally {
  reg("delete", INSTALL_KEY, "/f");
  const uninstallExe = path.join(installRoot, "Uninstall zevet.exe");
  if (fs.existsSync(uninstallExe)) spawnSync(uninstallExe, ["/S", "/currentuser"], { timeout: 60_000 });
  fs.rmSync(home, { recursive: true, force: true });
  if (!launched) process.exitCode = 1;
}
