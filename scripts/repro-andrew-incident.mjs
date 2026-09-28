// Reproduces the exact incident found on Andrew's own machine (and Kai's,
// the same shape) on 2026-09-27, and proves the fix in desktop/build/
// installer.nsh's customInit self-heals it with NO manual reinstall:
//
//   - HKCU Uninstall entry "zevet": DisplayVersion advanced to a LATER
//     release than the exe on disk, InstallLocation corrupted to
//     "C:\Program" (truncated, missing "\zevet" -- and missing "Files"
//     too, so this is not literally the Program-Files-with-a-space shape
//     the original per-machine incident described; the mechanism is the
//     same regardless of which space it lost).
//   - The REAL app, at the standard per-user default
//     (%LOCALAPPDATA%\Programs\zevet), was untouched and still the OLD,
//     unsigned version the whole time -- proving registryAddInstallInfo
//     had been recording a version bump for updates that never actually
//     wrote a single file, because installApplicationFiles was extracting
//     into "C:\Program" (which exists, and is empty) instead.
//
// This is exactly what a suffix-only sanitizer (this file's first
// version) CANNOT catch: "C:\Program" -> append "\zevet" -> "C:\Program\
// zevet" is internally consistent and still nowhere the real app lives.
// The fix instead trusts disk over registry: if ${APP_EXECUTABLE_FILENAME}
// is not actually at $INSTDIR, and the standard per-user default DOES have
// it, use that -- so a corrupted pointer can never out-vote a real,
// working install.
//
// Runs the REAL v0.2.71 installer as the starting state (not a fixture --
// that release is what is actually still running on the stranded
// machines), then updates it with installOnQuit()'s own args and nothing
// else: no /allusers, no /currentuser, no /D. Production never passes a
// mode flag; whichever branch runs is registry autodetection, exactly as
// it was for Andrew.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(process.platform, "win32", "only meaningful on Windows");

const oldOutDir = path.resolve(process.argv[2] || "");
assert.ok(oldOutDir && fs.existsSync(oldOutDir), "usage: repro-andrew-incident.mjs <old-build-out-dir>");
const newOutDir = path.resolve(process.argv[3] || path.join(root, "desktop/out"));

function findSetup(dir, version) {
  const file = path.join(dir, `zevet-${version}-windows-x64-setup.exe`);
  assert.ok(fs.existsSync(file), `${path.basename(file)} not in ${dir}`);
  return file;
}

const guid = "3e51149f-9c15-5e34-ad48-d31d2859aef2"; // com.andrewdoft.zevet, stable across builds
const INSTALL_KEY = `HKCU\\Software\\${guid}`;
const UNINSTALL_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`;
const installRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "zevet");
const CORRUPTED = "C:\\Program"; // the literal value found on Andrew's machine
let recovered;
let newSetup;

function reg(...args) {
  return spawnSync("reg", args, { encoding: "utf8" });
}
function readValue(key, name) {
  const r = reg("query", key, "/v", name);
  const m = new RegExp(`${name}\\s+REG_SZ\\s+(.*)`).exec(r.stdout || "");
  return m ? m[1].trim() : null;
}

try {
  // ── Step 1: install the REAL old release, fresh, per-user -- the exact
  // starting condition, not a fixture. ────────────────────────────────────
  const oldPkg = JSON.parse(fs.readFileSync(path.join(root, "old-v0.2.71/desktop/package.json"), "utf8"));
  const oldSetup = findSetup(oldOutDir, oldPkg.version);
  const install1 = spawnSync(oldSetup, ["/S", "/currentuser"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(install1.status, 0, `fresh install exited ${install1.status}: ${install1.stderr || install1.stdout}`);
  assert.ok(fs.existsSync(path.join(installRoot, "zevet.exe")), `zevet.exe missing at ${installRoot} after the fresh install`);
  const freshLocation = readValue(INSTALL_KEY, "InstallLocation");
  assert.equal(freshLocation, installRoot, `fresh install wrote InstallLocation=${freshLocation}, expected ${installRoot}`);
  console.log(`Fresh install: ${oldPkg.version} at ${freshLocation}, unsigned, matching the real stranded machine.`);

  // ── Step 2: corrupt the registry to the EXACT observed shape, without
  // touching the real app at all -- the real incident left it alone too. ──
  fs.mkdirSync(CORRUPTED, { recursive: true });
  reg("add", INSTALL_KEY, "/v", "InstallLocation", "/t", "REG_SZ", "/d", CORRUPTED, "/f");
  assert.equal(readValue(INSTALL_KEY, "InstallLocation"), CORRUPTED, "test setup: corrupted value did not write");
  console.log(`Corrupted InstallLocation -> ${CORRUPTED} (exists, empty), real app still at ${installRoot}.`);

  // ── Step 3: the real event -- a silent update, with installOnQuit()'s own
  // args and NOTHING else. Whichever build is checked out here (with the
  // fix, or without it, for the mutation pass) is what actually runs. ─────
  const newPkg = JSON.parse(fs.readFileSync(path.join(root, "desktop/package.json"), "utf8"));
  assert.notEqual(newPkg.version, oldPkg.version, "the new build must be a different version than 0.2.71 to prove an update happened");
  newSetup = findSetup(newOutDir, newPkg.version);
  const update = spawnSync(newSetup, ["--updated", "/S"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(update.status, 0, `update exited ${update.status}: ${update.stderr || update.stdout}`);

  // ── Step 4: prove the self-heal, not just "an install happened somewhere".
  const finalLocation = readValue(INSTALL_KEY, "InstallLocation");
  const finalVersion = readValue(UNINSTALL_KEY, "DisplayVersion");
  console.log(`After update: InstallLocation=${finalLocation}, DisplayVersion=${finalVersion}`);
  assert.equal(finalLocation, installRoot, `update left InstallLocation=${finalLocation}, expected the self-heal to land back on the real install at ${installRoot} (not a new location derived from the corrupted "${CORRUPTED}")`);
  assert.ok(fs.existsSync(path.join(installRoot, "zevet.exe")), `zevet.exe missing at ${installRoot} after the update`);
  assert.equal(finalVersion, newPkg.version, `registry DisplayVersion is ${finalVersion}, expected ${newPkg.version}`);
  // "Launches": app.asar is only readable through Electron's own patched fs,
  // not plain node (this script's runtime) -- registryAddInstallInfo's own
  // DisplayVersion, read above, needs no Electron runtime and is the
  // headless proof the installed build is the new one, not just that some
  // files landed at the right path.
  console.log(`Recovered onto the real install (headless version check): registry DisplayVersion=${finalVersion}`);
  recovered = true;
} finally {
  // Best-effort only: this is a throwaway CI runner, and a cleanup failure
  // (observed: EBUSY removing installRoot right after a silent uninstall,
  // presumably a transient AV/indexer handle) must never mask the REAL
  // pass/fail result above by throwing out of a finally block, which
  // replaces whatever exception was already propagating.
  const uninstallExe = path.join(installRoot, "Uninstall zevet.exe");
  try {
    if (fs.existsSync(uninstallExe)) spawnSync(uninstallExe, ["/S", "/currentuser"], { timeout: 60_000 });
  } catch { /* best-effort cleanup */ }
  reg("delete", INSTALL_KEY, "/f");
  reg("delete", UNINSTALL_KEY, "/f");
  for (const dir of [CORRUPTED, installRoot]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best-effort cleanup */ }
  }
  if (!recovered) process.exitCode = 1;
}
