// Faithful reproduction of the masora2 CI report (sibling-install.yml, run
// 36375729128): download the REAL, currently-live, signed installer from
// https://usemasora.com/download/zevet-latest.json (not a freshly-built one --
// see repro-fresh-silent-install.mjs for that) and run it with bare `/S` on a
// clean machine, exactly as apps/desktop/shell/sibling-family.js's
// silentInstallCommand() and desktop/app-update.js's INSTALL_ARGS/
// QUIT_INSTALL_ARGS do. Isolates whether the defect is in the installer
// itself or introduced between "electron-builder signs it" and "a machine
// downloads it" (the manual gcloud scp upload in docs/RELEASING.md, or Caddy).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(process.platform, "win32", "only meaningful on Windows");
const { DEFAULT_FEED, platformKey, readManifest } = createRequire(import.meta.url)("../desktop/app-update.js");

const feedUrl = process.argv[2] || DEFAULT_FEED;
const guid = "3e51149f-9c15-5e34-ad48-d31d2859aef2";
const perUserDefault = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "zevet");
const debugLog = path.join(process.env.TEMP || os.tmpdir(), "zevet-install-debug.log");

function reg(...args) {
  return spawnSync("reg", args, { encoding: "utf8" });
}
function uninstallEverywhere() {
  for (const dir of [perUserDefault, path.join(process.env.PROGRAMFILES || "C:\\Program Files", "zevet")]) {
    const un = path.join(dir, "Uninstall zevet.exe");
    if (fs.existsSync(un)) spawnSync(un, ["/S"], { timeout: 60_000 });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  for (const r of ["HKCU", "HKLM"]) {
    reg("delete", `${r}\\SOFTWARE\\${guid}`, "/f");
    reg("delete", `${r}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`, "/f");
  }
  try { fs.rmSync(debugLog, { force: true }); } catch { /* best-effort */ }
}

let pass = true;
try {
  console.log(`Fetching feed: ${feedUrl}`);
  const feedRes = await fetch(feedUrl);
  assert.equal(feedRes.status, 200, `feed fetch: HTTP ${feedRes.status}`);
  const feed = await feedRes.json();
  const key = platformKey(process.platform, process.arch);
  const { entry, error } = readManifest(feed, key);
  assert.ok(!error, `feed manifest error: ${error}`);
  console.log(`Feed version ${feed.version}, ${key} -> ${entry.file} (${entry.bytes} bytes, sha256 ${entry.sha256.slice(0, 16)}…)`);

  const downloadUrl = new URL(entry.file, feedUrl).href;
  console.log(`Downloading: ${downloadUrl}`);
  const exeRes = await fetch(downloadUrl);
  assert.equal(exeRes.status, 200, `installer fetch: HTTP ${exeRes.status}`);
  const bytes = Buffer.from(await exeRes.arrayBuffer());
  assert.equal(bytes.length, entry.bytes, `downloaded ${bytes.length} bytes, feed says ${entry.bytes}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256, entry.sha256, `downloaded sha256 ${sha256} != feed's ${entry.sha256}`);
  console.log("Download verified (size + sha256 match the feed).");

  const setup = path.join(os.tmpdir(), entry.file);
  fs.writeFileSync(setup, bytes);

  console.log("=== Running the REAL live installer with bare /S on a clean machine ===");
  uninstallEverywhere();
  const r = spawnSync(setup, ["/S"], { encoding: "utf8", timeout: 120_000 });
  console.log(`exit=${r.status}`);
  console.log(`--- installer.nsh customInit log ---`);
  console.log(fs.existsSync(debugLog) ? fs.readFileSync(debugLog, "utf8") : "(no log file written -- this release predates the logging, or customInit never ran)");
  for (const dir of [perUserDefault, path.join(process.env.PROGRAMFILES || "C:\\Program Files", "zevet")]) {
    console.log(`  ${dir}: ${fs.existsSync(path.join(dir, "zevet.exe")) ? "FOUND" : "absent"}`);
  }
  const exe = fs.existsSync(path.join(perUserDefault, "zevet.exe"));
  if (r.status !== 0 || !exe) {
    console.error(`LIVE FEED REPRO: FAILED -- exit=${r.status}, zevet.exe at ${perUserDefault}: ${exe}`);
    pass = false;
  } else {
    console.log(`LIVE FEED REPRO: OK -- zevet.exe at ${perUserDefault}`);
  }
  fs.rmSync(setup, { force: true });
} finally {
  uninstallEverywhere();
  if (!pass) process.exitCode = 1;
}
