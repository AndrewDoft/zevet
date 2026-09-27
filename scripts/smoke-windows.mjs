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
// `/currentuser`, not `/allusers`: GitHub Actions' windows-latest runner is
// not guaranteed to have an interactive session for NSIS's UAC self-elevation
// dance, and setInstallModePerUser in multiUser.nsh runs the exact same
// registry-reuse-and-sanitize code path as setInstallModePerAllUsers. This
// proves the fix without depending on CI elevation behaviour.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(process.platform, "win32", "the Windows artifact must be tested on Windows");

const setupPath = path.resolve(process.argv[2] || path.join(root, "desktop/out"));
const outDir = fs.statSync(setupPath).isDirectory() ? setupPath : path.dirname(setupPath);
function findSetup(dir) {
  const hit = fs.readdirSync(dir).find((f) => /^zevet-.*-windows-x64-setup\.exe$/.test(f));
  assert.ok(hit, `no setup.exe in ${dir}`);
  return path.join(dir, hit);
}

const guid = "3e51149f-9c15-5e34-ad48-d31d2859aef2"; // com.andrewdoft.zevet, UUID.v5 — stable across builds
const INSTALL_KEY = `HKCU\\Software\\${guid}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "zevet-win-smoke-"));
const installRoot = path.join(home, "install root with a space", "zevet"); // deliberately spaced, like "Program Files"
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
function launchAndCheckVersion(expected) {
  const exe = path.join(installRoot, "zevet.exe");
  assert.ok(fs.existsSync(exe), `zevet.exe missing at ${exe} after install`);
  const env = { ...process.env, ZEVET_ALLOW_MULTI: "1", ZEVET_HOME: path.join(home, `.zevet-${expected}`) };
  const p = spawnSync(exe, [`--user-data-dir=${path.join(home, `user-data-${expected}`)}`, "--version"], {
    encoding: "utf8", env, timeout: 20_000,
  });
  // Electron's --version prints the ELECTRON version, not the app's — the app
  // itself is the only reliable source, so read it from the packaged asar.
  const req_asar = path.join(installRoot, "resources", "app.asar", "package.json");
  const appVersion = JSON.parse(fs.readFileSync(req_asar, "utf8")).version;
  assert.equal(appVersion, expected, `packaged app.asar reports ${appVersion}, expected ${expected}`);
  void p;
}

try {
  // ── Step 1: fresh per-user install of the OLD build ──────────────────────
  const oldSetup = findSetup(outDir);
  const oldPkg = JSON.parse(fs.readFileSync(path.join(root, "desktop/package.json"), "utf8"));
  runInstaller(oldSetup, [`/D=${installRoot}`]);
  launchAndCheckVersion(oldPkg.version);
  const freshLocation = readInstallLocation();
  assert.equal(freshLocation, installRoot, `fresh install wrote InstallLocation=${freshLocation}, expected ${installRoot}`);
  console.log(`Fresh install: ${oldPkg.version} at ${freshLocation}`);

  // ── Step 2: build a NEW version and reinstall over it, --updated /S — the
  // exact args app-update.js's install()/installOnQuit() use for a real
  // silent update. No /D here: this is the part that used to corrupt
  // $INSTDIR by reusing whatever the registry said. ──────────────────────
  const bumped = oldPkg.version.replace(/(\d+)$/, (n) => String(Number(n) + 1));
  execFileSync(process.execPath, [
    path.join(root, "desktop/build.cjs"), "-c", "electron-builder.config.js", "--win", "--publish", "never",
    `--config.extraMetadata.version=${bumped}`,
  ], { cwd: path.join(root, "desktop"), stdio: "inherit" });
  const newSetup = findSetup(outDir);
  runInstaller(newSetup, ["--updated"]);
  launchAndCheckVersion(bumped);
  const updatedLocation = readInstallLocation();
  assert.equal(updatedLocation, installRoot, `update wrote InstallLocation=${updatedLocation}, expected unchanged ${installRoot}`);
  console.log(`Update in place: ${oldPkg.version} -> ${bumped}, still at ${updatedLocation}`);

  // ── Step 3: the actual incident — a CORRUPTED InstallLocation (truncated
  // at the space, exactly as found on the machine this was diagnosed from),
  // then another silent update over it. Before build/installer.nsh's
  // customInit sanitizer this landed the new build in the wrong place and
  // left the app folder empty; this asserts it no longer can. ────────────
  reg("add", INSTALL_KEY, "/v", "InstallLocation", "/t", "REG_SZ", "/d", installRoot.split(" ")[0], "/f");
  assert.equal(readInstallLocation(), installRoot.split(" ")[0], "test setup: corrupted value did not write");
  runInstaller(newSetup, ["--updated"]);
  launchAndCheckVersion(bumped);
  const filesAfterRecovery = fs.readdirSync(installRoot);
  assert.ok(filesAfterRecovery.includes("zevet.exe"), "install root must contain zevet.exe after recovering from a corrupted InstallLocation");
  console.log(`Recovered from a corrupted InstallLocation (${installRoot.split(" ")[0]}) and is still at an app-owned folder`);
  launched = true;
} finally {
  reg("delete", INSTALL_KEY, "/f");
  const uninstallExe = path.join(installRoot, "Uninstall zevet.exe");
  if (fs.existsSync(uninstallExe)) spawnSync(uninstallExe, ["/S", "/currentuser"], { timeout: 60_000 });
  fs.rmSync(home, { recursive: true, force: true });
  if (!launched) process.exitCode = 1;
}
