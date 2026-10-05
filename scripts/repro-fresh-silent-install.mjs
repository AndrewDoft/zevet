// Reproduces the masora2 sibling-install defect (workflow sibling-install.yml,
// run 36375729128): downloading the real signed zevet installer and running
// it with `/S` on a CLEAN machine exited 0 but extracted nothing.
//
// Neither smoke-windows.mjs nor repro-andrew-incident.mjs cover this shape --
// both always pass an explicit `/currentuser`. Production's own real callers
// never do: app-update.js's INSTALL_ARGS/QUIT_INSTALL_ARGS are
// `["--updated","/S","--force-run"]` / `["--updated","/S"]`, and masora2's
// sibling-family.js (D-623) runs a sibling app's installer the same bare way.
// This tests that exact shape, plus the explicit-/D= interactive-equivalent
// (a user who picked a custom folder), on a machine with NO prior install --
// the one starting condition none of this repo's existing installer tests use.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnInstallerWithRetry } from "./lib/spawn-installer-retry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(process.platform, "win32", "only meaningful on Windows");

const outDir = path.resolve(process.argv[2] || path.join(root, "desktop/out"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "desktop/package.json"), "utf8"));
const setupName = `zevet-${pkg.version}-windows-x64-setup.exe`;
const setup = path.join(outDir, setupName);
assert.ok(fs.existsSync(setup), `${setupName} not in ${outDir}`);

const guid = "3e51149f-9c15-5e34-ad48-d31d2859aef2"; // com.andrewdoft.zevet, stable across builds
const perUserDefault = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "zevet");
const debugLog = path.join(process.env.TEMP || os.tmpdir(), "zevet-install-debug.log");

function reg(...args) {
  return spawnSync("reg", args, { encoding: "utf8", windowsHide: true });
}
function dumpDebugLog(label) {
  console.log(`--- installer.nsh customInit log after ${label} ---`);
  console.log(fs.existsSync(debugLog) ? fs.readFileSync(debugLog, "utf8") : "(no log file written)");
}
function scanForExe(label) {
  const candidates = [
    perUserDefault,
    path.join(process.env.PROGRAMFILES || "C:\\Program Files", "zevet"),
    path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "zevet"),
  ];
  console.log(`--- exe scan after ${label} ---`);
  for (const dir of candidates) console.log(`  ${dir}: ${fs.existsSync(path.join(dir, "zevet.exe")) ? "FOUND" : "absent"}`);
}
function uninstallEverywhere() {
  for (const dir of [perUserDefault, path.join(process.env.PROGRAMFILES || "C:\\Program Files", "zevet")]) {
    const un = path.join(dir, "Uninstall zevet.exe");
    if (fs.existsSync(un)) spawnSync(un, ["/S"], { timeout: 60_000, windowsHide: true });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  for (const root of ["HKCU", "HKLM"]) {
    reg("delete", `${root}\\SOFTWARE\\${guid}`, "/f");
    reg("delete", `${root}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`, "/f");
  }
  try { fs.rmSync(debugLog, { force: true }); } catch { /* best-effort */ }
}

let pass = true;

console.log("=== Scenario: fresh machine, bare /S (production's own args shape) ===");
uninstallEverywhere();
const a = spawnInstallerWithRetry(setup, ["/S"], { encoding: "utf8", timeout: 120_000 });
console.log(`exit=${a.status}`);
dumpDebugLog("bare /S");
scanForExe("bare /S");
const aExe = fs.existsSync(path.join(perUserDefault, "zevet.exe"));
if (a.status !== 0 || !aExe) {
  console.error(`FAILED (bare /S): exit=${a.status}, zevet.exe at ${perUserDefault}: ${aExe}`);
  pass = false;
} else {
  console.log(`OK: zevet.exe at ${perUserDefault}`);
}

console.log("=== Scenario: fresh machine, explicit /S /D=... ===");
uninstallEverywhere();
const explicitDir = path.join(os.tmpdir(), "zevet-explicit-d");
try { fs.rmSync(explicitDir, { recursive: true, force: true }); } catch { /* best-effort */ }
// NSIS's /D= must be unquoted and the LAST argument, and every Node
// child_process spawn on Windows quotes an argv element containing a space --
// smoke-windows.mjs's own header documents this crashing the installer
// outright (0xC0000005). %TEMP% has no space on GitHub Actions runners, but
// assert it rather than assume it.
assert.ok(!explicitDir.includes(" "), `explicit /D target must not contain a space: ${explicitDir}`);
const b = spawnInstallerWithRetry(setup, ["/S", `/D=${explicitDir}`], { encoding: "utf8", timeout: 120_000 });
console.log(`exit=${b.status}`);
dumpDebugLog("explicit /D=");
console.log(`  ${explicitDir}: ${fs.existsSync(path.join(explicitDir, "zevet.exe")) ? "FOUND" : "absent"}`);
scanForExe("explicit /D=");
const bExe = fs.existsSync(path.join(explicitDir, "zevet.exe"));
if (b.status !== 0 || !bExe) {
  console.error(`FAILED (explicit /D=): exit=${b.status}, zevet.exe at ${explicitDir}: ${bExe}`);
  pass = false;
} else {
  console.log(`OK: zevet.exe at ${explicitDir}`);
}
try {
  const un = path.join(explicitDir, "Uninstall zevet.exe");
  if (fs.existsSync(un)) spawnSync(un, ["/S"], { timeout: 60_000, windowsHide: true });
  fs.rmSync(explicitDir, { recursive: true, force: true });
} catch { /* best-effort */ }

uninstallEverywhere();
process.exitCode = pass ? 0 : 1;
