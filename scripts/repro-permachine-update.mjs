// Reproduces the real incident on Andrew's own machine, exactly: a
// per-machine install with InstallLocation corrupted to "C:\Program" (no
// \zevet), then a silent update run with installOnQuit()'s own args
// (--updated /S, no /allusers, no /currentuser -- registry autodetection
// alone decides per-machine, exactly like production). Only ever run in CI
// (see build.yml) -- it installs into the REAL C:\Program on a throwaway
// runner, on purpose, because the bug is specifically about that literal
// path.
//
// scripts/smoke-windows.mjs already proved the sanitizer works for a
// PER-USER corrupted value. This is the per-machine path production actually
// hit, which that test never exercised -- /currentuser and /allusers are
// both used there, and production's own installOnQuit() passes NEITHER,
// letting multiUser.nsh's registry autodetection alone pick the branch.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(process.platform, "win32", "only meaningful on Windows");

const outDir = path.resolve(process.argv[2] || path.join(root, "desktop/out"));
function findSetup(dir, version) {
  const file = path.join(dir, `zevet-${version}-windows-x64-setup.exe`);
  assert.ok(fs.existsSync(file), `${path.basename(file)} not in ${dir}`);
  return file;
}

const guid = "3e51149f-9c15-5e34-ad48-d31d2859aef2"; // com.andrewdoft.zevet, stable across builds
const INSTALL_KEY = `HKLM\\Software\\${guid}`;
const UNINSTALL_KEY = `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`;
const CORRUPTED = "C:\\Program"; // the literal value found on Andrew's machine
let launched;
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
  // ── Set up the exact starting state: a real per-machine install AT the
  // corrupted path, so its uninstaller, UninstallString and InstallLocation
  // are all genuine (not hand-faked), and reachable with no /D quoting
  // hazard because "C:\Program" has no space. ─────────────────────────────
  const oldPkg = JSON.parse(fs.readFileSync(path.join(root, "desktop/package.json"), "utf8"));
  const oldSetup = findSetup(outDir, oldPkg.version);
  const setup1 = spawnSync(oldSetup, ["/S", "/allusers", `/D=${CORRUPTED}`], { encoding: "utf8", timeout: 120_000 });
  assert.equal(setup1.status, 0, `initial per-machine install exited ${setup1.status}: ${setup1.stderr || setup1.stdout}`);
  assert.ok(fs.existsSync(path.join(CORRUPTED, "zevet.exe")), `zevet.exe missing at ${CORRUPTED} after the initial install`);
  const seededLocation = readValue(INSTALL_KEY, "InstallLocation");
  assert.equal(seededLocation, CORRUPTED, `initial install wrote InstallLocation=${seededLocation}, expected the exact corrupted value ${CORRUPTED}`);
  console.log(`Starting state reproduced: ${oldPkg.version} at ${CORRUPTED}, InstallLocation=${seededLocation}`);

  // ── The real event: a silent update, with installOnQuit()'s own args and
  // NOTHING else -- no /allusers, no /currentuser, no /D. Production never
  // passes a mode flag; whichever branch runs is registry autodetection,
  // exactly as it was for Andrew. ──────────────────────────────────────────
  const bumped = oldPkg.version.replace(/(\d+)$/, (n) => String(Number(n) + 1));
  execFileSync(process.execPath, [
    path.join(root, "desktop/build.cjs"), "-c", "electron-builder.config.js", "--win", "--publish", "never",
    `--config.extraMetadata.version=${bumped}`,
  ], { cwd: path.join(root, "desktop"), stdio: "inherit" });
  newSetup = findSetup(outDir, bumped);
  const setup2 = spawnSync(newSetup, ["--updated", "/S"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(setup2.status, 0, `update exited ${setup2.status}: ${setup2.stderr || setup2.stdout}`);

  const finalLocation = readValue(INSTALL_KEY, "InstallLocation");
  const expected = `${CORRUPTED}\\zevet`;
  console.log(`After update: InstallLocation=${finalLocation}`);
  console.log(`  ${CORRUPTED}\\zevet.exe exists: ${fs.existsSync(path.join(expected, "zevet.exe"))}`);
  console.log(`  ${CORRUPTED}\\zevet.exe exists (unsanitized, the bug's shape): ${fs.existsSync(path.join(CORRUPTED, "zevet.exe"))}`);
  assert.equal(finalLocation, expected, `update left InstallLocation=${finalLocation}, expected the sanitizer to land on ${expected}`);
  assert.ok(fs.existsSync(path.join(expected, "zevet.exe")), `zevet.exe missing at ${expected} after the update`);
  const uninstallVersion = readValue(UNINSTALL_KEY, "DisplayVersion");
  assert.equal(uninstallVersion, bumped, `registry DisplayVersion is ${uninstallVersion}, expected ${bumped}`);
  console.log(`Update landed correctly at ${expected}, DisplayVersion=${uninstallVersion}`);
  launched = true;
} finally {
  const uninstallExe = path.join(CORRUPTED, "zevet", "Uninstall zevet.exe");
  const uninstallExeUnsanitized = path.join(CORRUPTED, "Uninstall zevet.exe");
  for (const exe of [uninstallExe, uninstallExeUnsanitized]) {
    if (fs.existsSync(exe)) spawnSync(exe, ["/S", "/allusers"], { timeout: 60_000 });
  }
  reg("delete", INSTALL_KEY, "/f");
  reg("delete", UNINSTALL_KEY, "/f");
  fs.rmSync(CORRUPTED, { recursive: true, force: true });
  if (newSetup) {
    fs.rmSync(newSetup, { force: true });
    fs.rmSync(`${newSetup}.blockmap`, { force: true });
  }
  if (!launched) process.exitCode = 1;
}
