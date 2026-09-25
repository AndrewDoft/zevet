// Proves the macOS self-replace update path on real Apple Silicon: installs
// build X, serves build X+1 through the real feed/check/download/verify code
// (desktop/app-update.js), then exercises both ways an update actually lands
// -- silent install-on-quit, and the "Restart now" button (via its IPC
// channel, since there is no way to click a real button headlessly).
//
//   node scripts/test-macos-autoupdate.mjs <x.dmg> <feed-dir>
//
// <feed-dir> must already contain the X+1 .dmg and a zevet-latest.json next
// to it (scripts/make-feed.mjs writes exactly that). Run only on darwin/arm64,
// and only against a throwaway machine: it installs into ~/Applications and
// launches it for real.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

assert.equal(process.platform, "darwin", "this only proves anything on macOS");
assert.equal(process.arch, "arm64", "zevet only ships an arm64 mac build");

const [xDmg, feedDir] = process.argv.slice(2).map((p) => path.resolve(p));
assert.ok(xDmg && fs.existsSync(xDmg), `missing X dmg: ${xDmg}`);
assert.ok(feedDir && fs.existsSync(path.join(feedDir, "zevet-latest.json")), `missing feed in ${feedDir}`);

const feed = JSON.parse(fs.readFileSync(path.join(feedDir, "zevet-latest.json"), "utf8"));
const entry = feed.platforms["darwin-arm64"];
assert.ok(entry, "feed has no darwin-arm64 build");
assert.ok(fs.existsSync(path.join(feedDir, entry.file)), `feed names ${entry.file} but it is not in ${feedDir}`);

const X = path.basename(xDmg).match(/^zevet-([\d.]+)-macos-arm64\.dmg$/)?.[1];
assert.ok(X, `cannot read a version out of ${xDmg}`);
const X1 = feed.version;
assert.notEqual(X, X1, "the feed must advertise a version newer than X");
console.log(`X = ${X}, X+1 = ${X1}`);

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", timeout: 60_000, ...opts });
const BUNDLE = path.join(os.homedir(), "Applications", "zevet.app");
const BIN = path.join(BUNDLE, "Contents/MacOS/zevet");
// Null while the updater has the bundle moved aside mid-swap.
const plistVersion = () => {
  try {
    return run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(BUNDLE, "Contents/Info.plist")]).trim();
  } catch {
    return null;
  }
};
// A file only the OLD install has: the swap must not carry it into the new one.
const SENTINEL = path.join(BUNDLE, "Contents", "Resources", "stale-from-old-version");
function assertCleanSwap(label) {
  assert.ok(!fs.existsSync(SENTINEL), `${label}: a file from the old bundle survived the update`);
  run("codesign", ["--verify", "--deep", BUNDLE]);
  assert.ok(!fs.existsSync(`${BUNDLE}.update`), `${label}: the staging bundle was left behind`);
}

/** Mount `dmg`, ditto the .app it contains over `dest`, unmount. Same shape
 *  as _macReplaceSteps in app-update.js, run here to set up/reset the test
 *  install rather than to prove anything itself. */
function installDmg(dmg, dest) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "zevet-mount-"));
  const mount = path.join(temp, "v");
  fs.mkdirSync(mount);
  try {
    run("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-mountpoint", mount]);
    try {
      const app = fs.readdirSync(mount).find((n) => n.endsWith(".app"));
      assert.ok(app, `no .app in ${dmg}`);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      run("ditto", [path.join(mount, app), dest]);
    } finally {
      run("hdiutil", ["detach", mount, "-force"]);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function serveFeed(dir) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    fs.readFile(path.join(dir, rel), (err, data) => {
      if (err) return void (res.writeHead(404), res.end());
      res.writeHead(200);
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function pgrepBin() {
  try {
    return run("pgrep", ["-f", BIN]).trim().split("\n").filter(Boolean).map(Number);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForCDP(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
    } catch { /* not up yet */ }
    await delay(300);
  }
  throw new Error(`CDP never came up on ${port}`);
}

/** One CDP round trip: connect, eval in the first real page, disconnect. */
async function evalInApp(port, code) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        if (page.url().startsWith("devtools://")) continue;
        return await page.evaluate((src) => eval(src), code);
      }
    }
    throw new Error("no window to evaluate in");
  } finally {
    await browser.close();
  }
}

/** Drive a real update check through window.zevetLocal (preload.js's bridge
 *  for the board window) until it lands on a terminal phase. Each call is the
 *  real IPC channel app:updateCheck -> appUpdater.check() -- the same feed
 *  fetch, download and sha256 verification a live machine does on its timer. */
async function waitForReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let status;
  while (Date.now() < deadline) {
    status = JSON.parse(await evalInApp(port, "window.zevetLocal.updateCheck().then(s => JSON.stringify(s))"));
    if (status.phase === "ready") return status;
    if (status.phase === "error") throw new Error(`update check failed: ${status.error}`);
    await delay(1000);
  }
  throw new Error(`update never became ready: ${JSON.stringify(status)}`);
}

function launch(port, extraEnv) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "zevet-autoupdate-"));
  const outLog = fs.openSync(path.join(base, "stdout.log"), "w");
  const errLog = fs.openSync(path.join(base, "stderr.log"), "w");
  const child = spawn(BIN, [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(base, "user-data")}`], {
    env: {
      ...process.env,
      HOME: base,
      ZEVET_HOME: path.join(base, "zevet-home"),
      ZEVET_ALLOW_MULTI: "1",
      // Never let a test run pair against a real hub or a real Masora.
      ZEVET_MASORA_URL: "http://127.0.0.1:1",
      ...extraEnv,
    },
    detached: true,
    stdio: ["ignore", outLog, errLog],
  });
  child.unref();
  return { pid: child.pid, base, userData: path.join(base, "user-data") };
}

let server;
const started = []; // pids we launched, for best-effort cleanup

async function main() {
  server = await serveFeed(feedDir);
  const feedUrl = `http://127.0.0.1:${server.address().port}/zevet-latest.json`;
  console.log(`serving ${feedDir} at ${feedUrl}`);

  assert.equal(pgrepBin().length, 0, "a zevet process is already running before the test starts");

  // ---- (a) silent install-on-quit: X -> quit -> X+1, no relaunch --------
  console.log("--- (a) install X, download X+1, quit, expect a silent self-replace ---");
  installDmg(xDmg, BUNDLE);
  assert.equal(plistVersion(), X, "freshly installed bundle is not X");
  fs.writeFileSync(SENTINEL, "x");

  let port = 9500 + Math.floor(Math.random() * 500);
  let app = launch(port, { ZEVET_APP_FEED: feedUrl });
  started.push(app.pid);
  await waitForCDP(port);
  const readyA = await waitForReady(port, 120_000);
  console.log(`update ready: ${readyA.version}, file ${path.basename(readyA.file)}`);

  const downloaded = path.join(app.userData, "updates", entry.file);
  assert.ok(fs.existsSync(downloaded), `expected the verified download at ${downloaded}`);
  console.log(`xattr -l ${downloaded}:`);
  console.log(run("xattr", ["-l", downloaded]) || "(no attributes -- not quarantined)");

  // A graceful quit is what actually fires Electron's `before-quit` (main.js
  // calls appUpdater.installOnQuit() from that event) -- the same lifecycle
  // event a real Quit from the Dock or menu bar produces. osascript is the
  // primary trigger; SIGTERM is Electron's own documented fallback for the
  // same lifecycle and is tried if the app ignores the Apple Event.
  try {
    run("osascript", ["-e", 'tell application id "com.andrewdoft.zevet" to quit']);
  } catch (err) {
    console.log(`osascript quit failed (${err.message}), falling back to SIGTERM`);
  }
  const quitDeadline = Date.now() + 15_000;
  while (alive(app.pid) && Date.now() < quitDeadline) {
    if (Date.now() > quitDeadline - 10_000) process.kill(app.pid, "SIGTERM");
    await delay(300);
  }
  assert.ok(!alive(app.pid), "app did not quit after osascript quit / SIGTERM");

  // installOnQuit's self-replace shell command is detached and keeps running
  // after our process exits; give it time to hdiutil attach/ditto/detach.
  const replaceDeadline = Date.now() + 30_000;
  while (plistVersion() !== X1 && Date.now() < replaceDeadline) await delay(1000);
  assert.equal(plistVersion(), X1, "installOnQuit did not replace the bundle with X+1");
  assertCleanSwap("(a)");
  await delay(3000); // a relaunch, if it wrongly happened, would show up by now
  assert.equal(pgrepBin().length, 0, "the app relaunched after a silent install-on-quit -- it must not");
  started.splice(started.indexOf(app.pid), 1);
  console.log(`(a) OK: bundle is ${plistVersion()}, no relaunch`);

  // ---- (b) "Restart now": X -> ready -> updateInstall() -> X+1 running --
  console.log("--- (b) reinstall X, drive Restart now via IPC, expect it to relaunch as X+1 ---");
  installDmg(xDmg, BUNDLE);
  assert.equal(plistVersion(), X, "reinstalled bundle is not X");
  fs.writeFileSync(SENTINEL, "x");

  port = 9500 + Math.floor(Math.random() * 500) + 1000;
  app = launch(port, { ZEVET_APP_FEED: feedUrl, ZEVET_HOME: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zevet-home-")), "h") });
  started.push(app.pid);
  await waitForCDP(port);
  await waitForReady(port, 120_000);

  // The "Restart now" button in board/src/components/updatebanner.tsx calls
  // exactly this: useBoard.getState().updateInstall() -> window.zevetLocal.updateInstall().
  // No headless click target exists (Playwright is not attached to a visible
  // window here), so the IPC channel it invokes is the equivalent test hook.
  const installResult = await evalInApp(port, "window.zevetLocal.updateInstall().then(s => JSON.stringify(s))");
  console.log(`updateInstall() -> ${installResult}`);
  assert.match(installResult, /"restarting":true/, `install() did not take the self-replace+relaunch path: ${installResult}`);

  const relaunchDeadline = Date.now() + 45_000;
  let relaunched;
  while (Date.now() < relaunchDeadline) {
    relaunched = pgrepBin().filter((pid) => pid !== app.pid);
    if (relaunched.length) break;
    await delay(1000);
  }
  assert.ok(relaunched && relaunched.length, "no new zevet process appeared after Restart now");
  assert.equal(plistVersion(), X1, "the relaunched bundle is not X+1");
  assertCleanSwap("(b)");
  started.push(...relaunched);
  console.log(`(b) OK: relaunched as pid(s) ${relaunched.join(",")}, bundle is ${plistVersion()}`);
}

main()
  .then(() => {
    console.log("PASS");
  })
  .catch((err) => {
    console.error(`FAIL: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const pid of started) {
      if (alive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch { /* already gone */ }
      }
    }
    if (server) await new Promise((resolve) => server.close(resolve));
  });
