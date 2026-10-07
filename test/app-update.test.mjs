// The desktop updater, against a download host that is lying to it.
//
// THREAT MODEL, so the cases below have a point. This module downloads a file
// and then EXECUTES it, which makes it the most dangerous thing in the app by
// some distance. The host is trusted to publish new builds — that is the
// feature — and is NOT trusted to choose where the bytes come from, where they
// land, or whether they are run before they have been checked.
//
// The feed is signed (desktop/update-signing.js), so a host takeover alone no
// longer publishes a build: "a feed that is not signed by a pinned key" below
// is the test of that. Every other case serves a feed signed with a throwaway
// key the updater is told to trust (TEST_KEYS), so it exercises the rules it
// names rather than the signature.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { tempDir, ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const {
  AppUpdater: RealAppUpdater,
  INSTALL_ARGS,
  QUIT_INSTALL_ARGS,
  EVERY_MS,
  compareVersions,
  platformKey,
  safeArtifactName,
  artifactUrl,
  readManifest,
  winInstallLocation,
  winInstallArgs,
  readSignedFeed,
  loopbackProofKeys,
} = require(path.join(ROOT, "desktop", "app-update.js"));

const { signDocument, UPDATE_DOMAIN } = require(path.join(ROOT, "desktop", "update-signing.js"));

const TEST_PAIR = generateKeyPairSync("ed25519");
const TEST_PEM = TEST_PAIR.privateKey.export({ format: "pem", type: "pkcs8" });
const TEST_KEYS = { "zevet-test": TEST_PAIR.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") };

/** The feed as make-feed.mjs writes it: legacy top-level fields, plus a signed payload. */
function signedFeed(m, pem = TEST_PEM) {
  const payload = JSON.parse(JSON.stringify({ schema: 1, type: "zevet-update", ...m }));
  return { ...m, payload, signature: signDocument(UPDATE_DOMAIN, payload, pem, "zevet-test") };
}

/** Trusts the throwaway key; the publisher check reports "unsigned" (log-only) unless a test says otherwise. */
class AppUpdater extends RealAppUpdater {
  constructor(o) {
    super({ trustedKeys: TEST_KEYS, inspectImpl: async () => ({ valid: false, publisher: null }), ...o });
  }
}

const KEY = "win32-x64";
const FILE = "zevet-0.2.0-windows-x64-setup.exe";
const MAC_KEY = "darwin-arm64";
const MAC_FILE = "zevet-0.2.0-macos-arm64.dmg";
const sha = (b) => createHash("sha256").update(b).digest("hex");

/**
 * A download host that serves exactly what a test tells it to.
 *
 * `manifest` may be a function, so a test can change the answer between calls.
 * `files` maps a name to a Buffer; anything not in it is a 404, which is the
 * ordinary state of a host that has not published yet.
 */
async function fakeHost({ manifest, files = {}, onRequest = null } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (onRequest && onRequest(req, res)) return;
    if (req.url === "/download/zevet-latest.json") {
      const m = typeof manifest === "function" ? manifest() : manifest;
      if (m === null) {
        res.writeHead(404).end("no feed");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(typeof m === "string" ? m : JSON.stringify(m.raw ? m.raw : signedFeed(m)));
      return;
    }
    const name = decodeURIComponent(req.url.replace(/^\/download\//, ""));
    if (Object.prototype.hasOwnProperty.call(files, name)) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(files[name]);
      return;
    }
    res.writeHead(404).end("nope");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    feed: `http://127.0.0.1:${port}/download/zevet-latest.json`,
    origin: `http://127.0.0.1:${port}`,
    seen,
    /**
     * ⚠️ closeAllConnections() FIRST, OR THIS NEVER RESOLVES.
     *
     * `fetch` keeps its connection alive, and `server.close()` waits for every
     * open connection before it calls back — so a suite that finishes its
     * assertions still holds a socket, the close callback never fires, the
     * `finally` never returns, and `node --test` waits for an event loop that
     * will not drain. MEASURED: the whole suite hung for twelve minutes on
     * both CI runners while passing in six seconds locally, because the local
     * Node was new enough to hide it. A test rig that hangs on one Node and
     * not another is worse than one that fails.
     */
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}

/** An updater wired to a host and a temp directory, with the logs captured. */
function updaterFor(host, dir, opts = {}) {
  const logs = [];
  const seenStatus = [];
  const u = new AppUpdater({
    currentVersion: "0.1.2",
    feedUrl: host.feed,
    platformKey: KEY,
    dir,
    log: (m) => logs.push(m),
    onStatus: (s) => seenStatus.push(s.phase),
    ...opts,
  });
  u.logs = logs;
  u.phases = seenStatus;
  return u;
}

async function downloadedMac(context, opts = {}) {
  const t = tempDir("zevet Mac updates with spaces ");
  const body = randomBytes(4096);
  const host = await fakeHost({
    manifest: { version: "0.2.0", platforms: { [MAC_KEY]: { file: MAC_FILE, sha256: sha(body), bytes: body.length } } },
    files: { [MAC_FILE]: body },
  });
  context.after(async () => {
    await host.close();
    t.cleanup();
  });
  const u = updaterFor(host, t.dir, { platform: "darwin", platformKey: MAC_KEY, ...opts });
  assert.equal((await u.check()).phase, "ready");
  return { u, body, host, dir: t.dir };
}

describe("comparing versions", () => {
  test("0.10.0 is newer than 0.9.0", () => {
    // ⚠️ THE BUG THIS EXISTS FOR. As strings "0.10.0" < "0.9.0", so a naive
    // comparison strands every machine on 0.9 the moment a tenth minor ships,
    // and nothing looks wrong until the numbers happen to reach it.
    assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
    assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
  });

  test("equal versions compare equal, with or without the patch", () => {
    assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
    assert.equal(compareVersions("0.2", "0.2.0"), 0);
    assert.equal(compareVersions("1", "1.0.0"), 0);
  });

  test("nonsense sorts as zero rather than throwing", () => {
    assert.equal(compareVersions("", "0.0.0"), 0);
    assert.equal(compareVersions(null, undefined), 0);
    assert.equal(compareVersions("banana", "0.0.1"), -1);
  });

  test("a four-part version still orders", () => {
    assert.equal(compareVersions("0.2.0.1", "0.2.0"), 1);
  });
});

describe("what the updater is willing to download", () => {
  test("a plain installer name is accepted", () => {
    assert.ok(safeArtifactName("zevet-0.2.0-windows-x64-setup.exe"));
    assert.ok(safeArtifactName("zevet-0.2.0-macos-arm64.dmg"));
  });

  test("a traversal is not a file name", () => {
    for (const bad of [
      "../evil.exe",
      "..\\evil.exe",
      "/etc/passwd",
      "sub/dir/x.exe",
      "C:\\windows\\system32\\calc.exe",
      ".hidden.exe",
    ]) {
      assert.equal(safeArtifactName(bad), false, `${bad} should be refused`);
    }
  });

  test("only extensions this module knows how to hand to the OS", () => {
    // The file is EXECUTED. A .bat, .ps1 or .sh would each run something, and
    // none of them is a thing zevet publishes.
    for (const bad of ["zevet.bat", "zevet.ps1", "zevet.sh", "zevet", "zevet.zip", "zevet.msi"]) {
      assert.equal(safeArtifactName(bad), false, `${bad} should be refused`);
    }
  });

  test("a manifest cannot point the download at another host", () => {
    const feed = "https://usemasora.com/download/zevet-latest.json";
    assert.equal(artifactUrl(feed, "https://evil.example/x.exe"), null);
    assert.equal(artifactUrl(feed, "//evil.example/x.exe"), null);
    assert.equal(artifactUrl(feed, "../secret/x.exe"), null);
    const ok = artifactUrl(feed, "zevet-0.2.0-windows-x64-setup.exe");
    assert.equal(ok.href, "https://usemasora.com/download/zevet-0.2.0-windows-x64-setup.exe");
  });
});

describe("reading the feed", () => {
  const good = {
    version: "0.2.0",
    platforms: { [KEY]: { file: FILE, sha256: "a".repeat(64), bytes: 10 } },
  };

  test("a well-formed feed reads", () => {
    const m = readManifest(good, KEY);
    assert.equal(m.error, undefined);
    assert.equal(m.version, "0.2.0");
    assert.equal(m.entry.bytes, 10);
  });

  test("a feed with no build for this machine is a clear message, not a crash", () => {
    const m = readManifest(good, "darwin-arm64");
    assert.match(m.error, /no build for darwin-arm64/);
  });

  test("every field that drives a write is checked", () => {
    const cases = [
      [{ ...good, version: "latest" }, /no usable version/],
      [{ ...good, platforms: null }, /lists no platforms/],
      [{ version: "0.2.0", platforms: { [KEY]: { file: "../x.exe", sha256: "a".repeat(64), bytes: 1 } } }, /refusing the file name/],
      [{ version: "0.2.0", platforms: { [KEY]: { file: FILE, sha256: "short", bytes: 1 } } }, /no usable sha256/],
      [{ version: "0.2.0", platforms: { [KEY]: { file: FILE, sha256: "a".repeat(64), bytes: 0 } } }, /no usable size/],
      [{ version: "0.2.0", platforms: { [KEY]: { file: FILE, sha256: "a".repeat(64), bytes: 1e12 } } }, /no usable size/],
      [null, /not an object/],
    ];
    for (const [json, re] of cases) {
      const m = readManifest(json, KEY);
      assert.match(m.error || "", re);
    }
  });

  test("a Mac entry cannot name another architecture, platform, or version", () => {
    for (const file of [
      "zevet-0.2.0-macos-x64.dmg",
      FILE,
      "zevet-0.1.2-macos-arm64.dmg",
      "zevet-0.2.0-macos-arm64.exe",
    ]) {
      const m = readManifest({ version: "0.2.0", platforms: { [MAC_KEY]: { file, sha256: "a".repeat(64), bytes: 10 } } }, MAC_KEY);
      assert.match(m.error, /not the darwin-arm64 artifact/);
    }
  });
});

describe("the updater, end to end", () => {
  test("a newer build is downloaded and verified", async () => {
    const t = tempDir("zevet-upd-");
    const body = randomBytes(4096);
    const host = await fakeHost({
      manifest: { version: "0.2.0", notes: "the editor", platforms: { [KEY]: { file: "zevet-0.2.0-windows-x64-setup.exe", sha256: sha(body), bytes: body.length } } },
      files: { "zevet-0.2.0-windows-x64-setup.exe": body },
    });
    try {
      const u = updaterFor(host, t.dir);
      const s = await u.check();
      assert.equal(s.phase, "ready");
      assert.equal(s.version, "0.2.0");
      assert.equal(s.notes, "the editor");
      assert.equal(s.canInstall, true);
      assert.ok(existsSync(s.file));
      assert.equal(statSync(s.file).size, body.length);
      assert.equal(sha(readFileSync(s.file)), sha(body));
      // The person was told it was happening, not only that it had happened.
      assert.ok(u.phases.includes("downloading"));
    } finally {
      await host.close();
      t.cleanup();
    }
  });

  test("the same version is not re-downloaded", async () => {
    const t = tempDir("zevet-upd-");
    const body = randomBytes(2048);
    const host = await fakeHost({
      manifest: { version: "0.1.2", platforms: { [KEY]: { file: "zevet-0.1.2-windows-x64-setup.exe", sha256: sha(body), bytes: body.length } } },
      files: { [FILE]: body },
    });
    try {
      const u = updaterFor(host, t.dir);
      const s = await u.check();
      assert.equal(s.phase, "current");
      assert.equal(s.canInstall, false);
      assert.ok(!host.seen.some((u2) => u2.endsWith(".exe")), "it fetched an artifact it did not need");
    } finally {
      await host.close();
      t.cleanup();
    }
  });

  test("an OLDER published build is not installed over a newer one", async () => {
    // A host that rolls back is a host that downgrades a whole team by
    // accident. Only forward.
    const t = tempDir("zevet-upd-");
    const host = await fakeHost({
      manifest: { version: "0.1.0", platforms: { [KEY]: { file: "zevet-0.1.0-windows-x64-setup.exe", sha256: "b".repeat(64), bytes: 5 } } },
    });
    try {
      const s = await updaterFor(host, t.dir).check();
      assert.equal(s.phase, "current");
    } finally {
      await host.close();
      t.cleanup();
    }
  });

  test("a checksum that does not match leaves NOTHING behind", async () => {
    const t = tempDir("zevet-upd-");
    const body = randomBytes(3000);
    const host = await fakeHost({
      manifest: { version: "0.2.0", platforms: { [KEY]: { file: FILE, sha256: sha(Buffer.from("something else")), bytes: body.length } } },
      files: { [FILE]: body },
    });
    try {
      const u = updaterFor(host, t.dir);
      const s = await u.check();
      assert.equal(s.phase, "error");
      assert.match(s.error, /checksum/);
      assert.equal(s.canInstall, false);
      // ⚠️ The file must not exist under its REAL name, or a later run's
      // `_verified` is the only thing between it and being executed.
      assert.equal(existsSync(path.join(t.dir, FILE)), false);
      assert.equal(existsSync(path.join(t.dir, FILE + ".part")), false);
    } finally {
      await host.close();
      t.cleanup();
    }
  });

  test("a download longer than the manifest promised is cut off", async () => {
    const t = tempDir("zevet-upd-");
    const body = randomBytes(9000);
    const host = await fakeHost({
      manifest: { version: "0.2.0", platforms: { [KEY]: { file: FILE, sha256: sha(body), bytes: 100 } } },
      files: { [FILE]: body },
    });
    try {
      const s = await updaterFor(host, t.dir).check();
      assert.equal(s.phase, "error");
      assert.match(s.error, /longer than the manifest/);
      assert.equal(existsSync(path.join(t.dir, FILE)), false);
    } finally {
      await host.close();
      t.cleanup();
    }
  });

  test("a download SHORTER than promised is rejected too", async () => {
    const t = tempDir("zevet-upd-");
    const body = randomBytes(64);
    const host = await fakeHost({
      manifest: { version: "0.2.0", platforms: { [KEY]: { file: FILE, sha256: sha(body), bytes: 4096 } } },
      files: { [FILE]: body },
    });
    try {
      const s = await updaterFor(host, t.dir).check();
      assert.equal(s.phase, "error");
      assert.match(s.error, /bytes and the manifest says/);
      assert.equal(existsSync(path.join(t.dir, FILE)), false);
    } finally {
      await host.close();
      t.cleanup();
    }
  });

  test("no feed published yet is quiet, not an error", async () => {
    const t = tempDir("zevet-upd-");
    const host = await fakeHost({ manifest: null });
    try {
      const s = await updaterFor(host, t.dir).check();
      assert.equal(s.phase, "current");
      assert.equal(s.error, null);
    } finally {
      await host.close();
      t.cleanup();
    }
  });

  test("a feed that is not JSON does not take the app with it", async () => {
    const t = tempDir("zevet-upd-");
    const host = await fakeHost({ manifest: "<html>404</html>" });
    try {
      const s = await updaterFor(host, t.dir).check();
      assert.equal(s.phase, "error");
      assert.ok(s.error);
    } finally {
      await host.close();
      t.cleanup();
    }
  });

  test("a redirect is refused rather than followed", async () => {
    const t = tempDir("zevet-upd-");
    const host = await fakeHost({
      manifest: null,
      onRequest: (req, res) => {
        res.writeHead(302, { location: "https://evil.example/feed.json" }).end();
        return true;
      },
    });
    try {
      const s = await updaterFor(host, t.dir).check();
      assert.equal(s.phase, "error");
    } finally {
      await host.close();
      t.cleanup();
    }
  });

  test("an already-downloaded, already-verified build is not fetched twice", async () => {
    const t = tempDir("zevet-upd-");
    const body = randomBytes(1500);
    const host = await fakeHost({
      manifest: { version: "0.2.0", platforms: { [KEY]: { file: FILE, sha256: sha(body), bytes: body.length } } },
      files: { [FILE]: body },
    });
    try {
      const u = updaterFor(host, t.dir);
      assert.equal((await u.check()).phase, "ready");
      const before = host.seen.filter((p) => p.endsWith(".exe")).length;
      assert.equal((await u.check()).phase, "ready");
      const after = host.seen.filter((p) => p.endsWith(".exe")).length;
      assert.equal(after, before, "it downloaded the same installer twice");
    } finally {
      await host.close();
      t.cleanup();
    }
  });

  test("a stale .part from a killed run is not mistaken for the build", async () => {
    const t = tempDir("zevet-upd-");
    const body = randomBytes(2500);
    mkdirSync(t.dir, { recursive: true });
    writeFileSync(path.join(t.dir, FILE + ".part"), randomBytes(900));
    const host = await fakeHost({
      manifest: { version: "0.2.0", platforms: { [KEY]: { file: FILE, sha256: sha(body), bytes: body.length } } },
      files: { [FILE]: body },
    });
    try {
      const s = await updaterFor(host, t.dir).check();
      assert.equal(s.phase, "ready");
      assert.equal(sha(readFileSync(s.file)), sha(body));
      assert.equal(existsSync(path.join(t.dir, FILE + ".part")), false);
    } finally {
      await host.close();
      t.cleanup();
    }
  });
});

describe("Windows install scope and directory (the masora2 sibling-install fix)", () => {
  const originalLAD = process.env.LOCALAPPDATA;
  const win = (...parts) => path.win32.join(...parts);
  const restoreLocalAppData = () => { process.env.LOCALAPPDATA = originalLAD; };

  test("a per-user execPath resolves /currentuser", (t) => {
    process.env.LOCALAPPDATA = win("C:", "Users", "andre", "AppData", "Local");
    t.after(restoreLocalAppData);
    const execPath = win(process.env.LOCALAPPDATA, "Programs", "zevet", "zevet.exe");
    const { scope, dir } = winInstallLocation(execPath);
    assert.equal(scope, "/currentuser");
    assert.equal(dir, path.win32.dirname(execPath));
  });

  test("a per-machine execPath (Program Files, or anywhere else) resolves /allusers", (t) => {
    process.env.LOCALAPPDATA = win("C:", "Users", "andre", "AppData", "Local");
    t.after(restoreLocalAppData);
    // Exactly the masora2 incident's shape: a per-machine copy registered in
    // an arbitrary temp directory, nowhere near either standard default.
    const execPath = win("C:", "Users", "andre", "AppData", "Local", "Temp", "masora-real-install-JiPJgP", "zevet", "zevet.exe");
    assert.equal(winInstallLocation(execPath).scope, "/allusers");
  });

  test("an unset LOCALAPPDATA cannot be mistaken for a per-user match", (t) => {
    delete process.env.LOCALAPPDATA;
    t.after(restoreLocalAppData);
    assert.equal(winInstallLocation(win("C:", "Program Files", "zevet", "zevet.exe")).scope, "/allusers");
  });

  test("winInstallArgs appends scope then /D= LAST, after the base args, in that order", () => {
    // Mutation check: swap the push order below (or in winInstallArgs itself)
    // and this goes red -- NSIS reads everything after `/D=` to the end of
    // the line as the directory, so anything placed after it is silently
    // swallowed into the path instead of being its own switch.
    const execPath = win("C:", "Program Files", "zevet", "zevet.exe");
    const args = winInstallArgs(["--updated", "/S"], execPath);
    assert.deepEqual(args, ["--updated", "/S", "/allusers", `/D=${path.win32.dirname(execPath)}`]);
    assert.equal(args[args.length - 1].startsWith("/D="), true, "/D= must be the last argument");
  });

  test("winInstallArgs never quotes the /D= value itself — that's spawn's job via windowsVerbatimArguments, not string content", () => {
    const execPath = win("C:", "Program Files (x86)", "zevet team", "zevet.exe");
    const args = winInstallArgs(["--updated", "/S"], execPath);
    const dArg = args[args.length - 1];
    assert.ok(!dArg.includes('"'), `winInstallArgs must never embed quotes itself: ${dArg}`);
    assert.equal(dArg, `/D=${path.win32.dirname(execPath)}`);
  });
});

describe("installing", () => {
  test("nothing downloaded means nothing to install", async () => {
    const t = tempDir("zevet-upd-");
    try {
      const u = new AppUpdater({ currentVersion: "0.1.2", dir: t.dir, platformKey: KEY });
      const r = await u.install();
      assert.equal(r.ok, false);
      assert.match(r.error, /nothing downloaded/);
    } finally {
      t.cleanup();
    }
  });

  test("a downloaded build that has since been deleted is re-fetched, not run", async () => {
    const t = tempDir("zevet-upd-");
    try {
      const u = new AppUpdater({ currentVersion: "0.1.2", dir: t.dir, platformKey: KEY });
      // The state a successful check leaves behind, pointing at a file that a
      // disk cleaner has since removed -- which on Windows is a REAL case,
      // because this lives under the temp directory.
      u.state.phase = "ready";
      u.state.file = path.join(t.dir, "gone.exe");
      const r = await u.install();
      assert.equal(r.ok, false);
      assert.match(r.error, /gone|fetched again/);
      assert.equal(u.status().canInstall, false);
    } finally {
      t.cleanup();
    }
  });

  test("on Windows the installer is run silently, targeting THIS running install by path, and the app then quits", async () => {
    // A space in the prefix, not incidental: /D=<dir> is the one argument
    // Node must never quote (see windowsVerbatimArguments below), and a path
    // without a space in it can't prove that.
    const t = tempDir("zevet upd ");
    const originalLAD = process.env.LOCALAPPDATA;
    try {
      const file = path.join(t.dir, "setup.exe");
      writeFileSync(file, "not really an installer");
      const calls = [];
      let quit = 0;
      // A per-user install: execPath under %LOCALAPPDATA%\Programs, exactly
      // the shape multiUser.nsh's own per-user default and installer.nsh's
      // customInit both already assume.
      const localAppData = path.win32.join(t.dir, "AppData", "Local");
      const runningExe = path.win32.join(localAppData, "Programs", "zevet", "zevet.exe");
      process.env.LOCALAPPDATA = localAppData;
      const u = new AppUpdater({
        currentVersion: "0.1.2",
        platform: "win32",
        dir: t.dir,
        platformKey: KEY,
        execPath: runningExe,
        spawnImpl: (...a) => {
          calls.push(a);
          return { unref() {} };
        },
        quitImpl: () => { quit++; },
      });
      u.state.phase = "ready";
      u.state.file = file;
      u._readyEntry = { bytes: statSync(file).size, sha256: sha(readFileSync(file)) };
      const r = await u.install();
      assert.equal(r.ok, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], file);
      // /S is NSIS's silent switch. Without it the person watches a wizard
      // they did not ask for, after clicking a button that said "restart".
      //
      // --force-run is what brings the app BACK, and it is the whole reason
      // this assertion lists the args rather than just checking for /S. zevet
      // ships the assisted installer (nsis.oneClick: false), and
      // electron-builder's installSection.nsh relaunches an assisted silent
      // install only when isForceRun is set. Without it the app quits to
      // install and never returns, after a button that said "restart".
      //
      // /currentuser and /D=<runningExe's own dir> are the fix for the
      // masora2 sibling-install incident: without them, NSIS's multiUser.nsh
      // decides scope and directory from the registry, which a stray
      // per-machine entry anywhere else can hijack away from the copy that
      // is actually running.
      assert.deepEqual(calls[0][1], ["--updated", "/S", "--force-run", "/currentuser", `/D=${path.win32.dirname(runningExe)}`]);
      assert.equal(calls[0][2].detached, true);
      // /D= must reach NSIS unquoted even when the path has a space (which
      // t.dir, under the "zevet upd " tempDir prefix, already does) --
      // windowsVerbatimArguments is what stops Node quoting it for us.
      assert.equal(calls[0][2].windowsVerbatimArguments, true);
      // The quit is on a short timer so the child is running before we go.
      await new Promise((r2) => setTimeout(r2, 900));
      assert.equal(quit, 1);
    } finally {
      process.env.LOCALAPPDATA = originalLAD;
      t.cleanup();
    }
  });

  test("on Mac the verified disk image opens with its space-containing path intact, without quitting", async (t) => {
    const opened = [];
    let quit = false;
    const { u, dir } = await downloadedMac(t, {
      openImpl: async (file) => { opened.push(file); return ""; },
      quitImpl: () => { quit = true; },
      spawnImpl: () => { throw new Error("Mac installation must not execute an installer"); },
    });
    assert.equal(u.status().manual, true);
    assert.deepEqual(await u.install(), { ok: true, manual: true });
    assert.deepEqual(opened, [path.join(dir, MAC_FILE)]);
    assert.equal(quit, false);
  });

  test("Mac reports Electron's resolved openPath error instead of claiming success", async (t) => {
    const { u } = await downloadedMac(t, { openImpl: async () => "The disk image could not be opened" });
    const result = await u.install();
    assert.equal(result.ok, false);
    assert.match(result.error, /disk image could not be opened/);
  });

  test("Mac reports a rejected disk image open", async (t) => {
    const { u } = await downloadedMac(t, { openImpl: async () => { throw new Error("permission denied"); } });
    assert.match((await u.install()).error, /permission denied/);
  });

  test("Mac cannot report success without an opener", async (t) => {
    const { u } = await downloadedMac(t);
    assert.equal((await u.install()).ok, false);
  });

  test("a Mac download changed after verification is not opened and can be fetched again", async (t) => {
    let opened = false;
    const { u, body } = await downloadedMac(t, { openImpl: async () => { opened = true; return ""; } });
    // Same length, different bytes: a size check alone would accept this.
    writeFileSync(u.status().file, Buffer.alloc(body.length));
    const result = await u.install();
    assert.equal(result.ok, false);
    assert.match(result.error, /changed/);
    assert.equal(opened, false);
    assert.equal(u.status().canInstall, false);
    assert.equal((await u.check()).phase, "ready");
    assert.deepEqual(readFileSync(u.status().file), body);
  });

  test("a later rejected feed clears a previously ready Mac install", async (t) => {
    const { u } = await downloadedMac(t, { openImpl: async () => "" });
    u.fetchImpl = async () => new Response(JSON.stringify({ version: "0.3.0", platforms: {} }));
    assert.equal((await u.check()).phase, "error");
    assert.equal(u.status().canInstall, false);
    assert.equal(u.status().file, null);
    assert.equal((await u.install()).ok, false);
  });
});

describe("Mac downloads that must never be opened", () => {
  for (const scenario of ["checksum", "truncated", "wrong architecture", "redirect", "stalled", "writer failure"]) {
    test(scenario, async (t) => {
      const temp = tempDir("zevet Mac failure ");
      const body = Buffer.from("a small disk image fixture");
      let opens = 0;
      const host = await fakeHost({
        manifest: { version: "0.2.0", platforms: { [MAC_KEY]: {
          file: scenario === "wrong architecture" ? "zevet-0.2.0-macos-x64.dmg" : MAC_FILE,
          bytes: scenario === "truncated" ? body.length + 20 : body.length,
          sha256: scenario === "checksum" ? "0".repeat(64) : sha(body),
        } } },
        files: { [MAC_FILE]: body },
        onRequest(req, res) {
          if (!req.url.endsWith(".dmg")) return false;
          if (scenario === "redirect") {
            res.writeHead(302, { location: "https://example.invalid/untrusted.dmg" }).end();
            return true;
          }
          if (scenario === "stalled") {
            res.writeHead(200);
            res.flushHeaders();
            return true;
          }
          if (scenario === "writer failure") {
            // The destination becomes unwritable after staging cleanup but
            // before createWriteStream opens it. Previously an unhandled
            // error here could take down the desktop process.
            mkdirSync(path.join(temp.dir, MAC_FILE + ".part"));
          }
          return false;
        },
      });
      t.after(async () => { await host.close(); temp.cleanup(); });
      const u = updaterFor(host, temp.dir, {
        platform: "darwin", platformKey: MAC_KEY, downloadTimeoutMs: scenario === "stalled" ? 100 : 5000,
        openImpl: async () => { opens++; return ""; },
      });
      const s = await u.check();
      assert.equal(s.phase, "error");
      assert.equal(s.canInstall, false);
      assert.equal(existsSync(path.join(temp.dir, MAC_FILE)), false);
      if (scenario !== "writer failure") assert.equal(existsSync(path.join(temp.dir, MAC_FILE + ".part")), false);
      if (scenario === "wrong architecture") assert.equal(host.seen.length, 1, "wrong-architecture artifact must not be requested");
      assert.equal((await u.install()).ok, false);
      assert.equal(opens, 0);
      assert.equal(u._busy, false, "failure must not wedge subsequent checks");
    });
  }
});

describe("the platform key", () => {
  test("is what the manifest is written with", () => {
    assert.equal(platformKey("win32", "x64"), "win32-x64");
    assert.equal(platformKey("darwin", "arm64"), "darwin-arm64");
  });
});

describe("checking on a schedule", () => {
  test("the periodic check is an hour, not six", () => {
    // Andrew: "i dont want to have to check for new versions." Mutation check:
    // flip this back to 6 * 60 * 60 * 1000 in app-update.js and this goes red.
    assert.equal(EVERY_MS, 60 * 60 * 1000);
  });

  test("maybeCheck skips a repeat inside the gap and runs one after it", async () => {
    const t = tempDir("zevet-gap-");
    const host = await fakeHost({ manifest: null });
    try {
      const u = updaterFor(host, t.dir);
      await u.maybeCheck(10_000);
      const afterFirst = host.seen.length;
      assert.ok(afterFirst > 0, "the very first call, with nothing checked yet, must run");
      await u.maybeCheck(10_000);
      assert.equal(host.seen.length, afterFirst, "a call inside the gap must not hit the host again");
      await new Promise((r) => setTimeout(r, 20));
      await u.maybeCheck(10);
      assert.ok(host.seen.length > afterFirst, "a call after the gap has passed must run");
    } finally {
      await host.close();
      t.cleanup();
    }
  });
});

describe("installing on quit", () => {
  test("nothing ready means nothing to do", () => {
    const t = tempDir("zevet-quit-");
    try {
      const u = new AppUpdater({ currentVersion: "0.1.2", dir: t.dir, platformKey: KEY });
      assert.equal(u.installOnQuit().ok, false);
    } finally {
      t.cleanup();
    }
  });

  test("on Windows it installs silently, with no relaunch flag and no quit call of its own", () => {
    const t = tempDir("zevet-quit-");
    try {
      const file = path.join(t.dir, "setup.exe");
      writeFileSync(file, "not really an installer");
      const calls = [];
      let quit = 0;
      // A per-machine install this time: execPath NOT under %LOCALAPPDATA%\
      // Programs, so winInstallLocation must resolve /allusers -- covering
      // the branch the install() test above doesn't.
      const runningExe = path.win32.join(t.dir, "Program Files", "zevet", "zevet.exe");
      const u = new AppUpdater({
        currentVersion: "0.1.2",
        platform: "win32",
        dir: t.dir,
        platformKey: KEY,
        execPath: runningExe,
        spawnImpl: (...a) => {
          calls.push(a);
          return { unref() {} };
        },
        quitImpl: () => {
          quit++;
        },
      });
      u.state.phase = "ready";
      u.state.version = "0.2.0";
      u.state.file = file;
      u._readyEntry = { bytes: statSync(file).size, sha256: sha(readFileSync(file)) };

      const r = u.installOnQuit();
      assert.equal(r.ok, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], file);
      // Mutation check: put --force-run back into QUIT_INSTALL_ARGS (or this
      // assertion) and this goes red — the whole point of the quit path is
      // that it must NOT ask the installer to bring the app back.
      assert.deepEqual(calls[0][1], [...QUIT_INSTALL_ARGS, "/allusers", `/D=${path.win32.dirname(runningExe)}`]);
      assert.ok(!QUIT_INSTALL_ARGS.includes("--force-run"), "the quit path must never force a relaunch");
      assert.equal(calls[0][2].detached, true);
      assert.equal(calls[0][2].windowsVerbatimArguments, true);
      assert.equal(quit, 0, "installOnQuit must not itself quit — the app called it because it was already leaving");
    } finally {
      t.cleanup();
    }
  });

  test("a failed install-on-quit is attempted once per version, then left for the in-app bar", () => {
    const t = tempDir("zevet-quit-");
    try {
      const file = path.join(t.dir, "setup.exe");
      writeFileSync(file, "not really an installer");
      const calls = [];
      const u = new AppUpdater({
        currentVersion: "0.1.2",
        platform: "win32",
        dir: t.dir,
        platformKey: KEY,
        spawnImpl: () => {
          calls.push(1);
          throw new Error("blocked by antivirus");
        },
      });
      u.state.phase = "ready";
      u.state.version = "0.2.0";
      u.state.file = file;
      u._readyEntry = { bytes: statSync(file).size, sha256: sha(readFileSync(file)) };

      const first = u.installOnQuit();
      assert.equal(first.ok, false);
      assert.match(first.error, /blocked by antivirus/);
      assert.equal(calls.length, 1);

      const second = u.installOnQuit();
      assert.equal(second.ok, false);
      assert.match(second.error, /already attempted/);
      assert.equal(calls.length, 1, "a second quit for the same version must not spawn the installer again");
    } finally {
      t.cleanup();
    }
  });

  test("a newer version still gets its own attempt after the last one failed", () => {
    const t = tempDir("zevet-quit-");
    try {
      const file = path.join(t.dir, "setup.exe");
      writeFileSync(file, "not really an installer");
      let fail = true;
      const calls = [];
      const u = new AppUpdater({
        currentVersion: "0.1.2",
        platform: "win32",
        dir: t.dir,
        platformKey: KEY,
        spawnImpl: (...a) => {
          calls.push(a);
          if (fail) throw new Error("blocked");
          return { unref() {} };
        },
      });
      u.state.phase = "ready";
      u.state.version = "0.2.0";
      u.state.file = file;
      u._readyEntry = { bytes: statSync(file).size, sha256: sha(readFileSync(file)) };
      assert.equal(u.installOnQuit().ok, false);

      fail = false;
      u.state.version = "0.3.0";
      assert.equal(u.installOnQuit().ok, true);
      assert.equal(calls.length, 2);
    } finally {
      t.cleanup();
    }
  });
});

describe("self-replacing a Mac bundle", () => {
  test("without a bundlePath it cannot self-replace", () => {
    const u = new AppUpdater({ currentVersion: "0.1.2", platform: "darwin", dir: "unused", platformKey: MAC_KEY });
    assert.equal(u.canSelfReplaceMac(), false);
  });

  test("with a bundlePath whose parent is writable, it can", () => {
    const t = tempDir("zevet-mac-bundle-");
    try {
      const bundle = path.join(t.dir, "zevet.app");
      const u = new AppUpdater({
        currentVersion: "0.1.2",
        platform: "darwin",
        dir: t.dir,
        platformKey: MAC_KEY,
        bundlePath: bundle,
      });
      assert.equal(u.canSelfReplaceMac(), true);
    } finally {
      t.cleanup();
    }
  });

  test("the replace steps mount, ditto, and unmount, over a path with spaces", () => {
    const t = tempDir("zevet Mac bundle with spaces ");
    try {
      const bundle = path.join(t.dir, "zevet.app");
      const u = new AppUpdater({
        currentVersion: "0.1.2",
        platform: "darwin",
        dir: t.dir,
        platformKey: MAC_KEY,
        bundlePath: bundle,
      });
      const steps = u._macReplaceSteps(path.join(t.dir, MAC_FILE), bundle, 4242);
      const staged = `${bundle}.update`;
      assert.equal(steps.length, 8);
      assert.match(steps[0], /kill -0 4242/, "waits for the running app to exit first");
      assert.deepEqual([steps[2][0], steps[2][1][0]], ["hdiutil", "attach"]);
      assert.deepEqual([steps[3][0], steps[3][1][1]], ["ditto", staged], "copies to a staging bundle, never over the live one");
      assert.deepEqual([steps[4][0], steps[4][1][0]], ["hdiutil", "detach"]);
      assert.match(steps[5], /^rm -rf '.*zevet\.app'$/);
      assert.deepEqual(steps[6], ["mv", [staged, bundle]]);
      // Leave exactly one app bundle (P1 — "on mac when you download a new
      // version it keeps the old"): the final step sweeps sibling
      // zevet*.app / zevet*.app.update in the bundle's own folder plus both
      // Applications directories, but never the bundle just installed.
      assert.match(steps[7], /for d in .*Applications.* \/Applications; do/);
      assert.match(steps[7], /zevet\*\.app.*zevet\*\.app\.update/);
      assert.match(steps[7], new RegExp(`!= '${bundle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`), "must never delete the bundle it just installed");
    } finally {
      t.cleanup();
    }
  });

  test("the cleanup step exits 0 even when there is nothing to sweep, so the relaunch after it still runs", { skip: process.platform === "win32" }, () => {
    const t = tempDir("zevet-mac-cleanup-");
    try {
      const bundle = path.join(t.dir, "zevet.app");
      const u = new AppUpdater({
        currentVersion: "0.1.2",
        platform: "darwin",
        dir: t.dir,
        platformKey: MAC_KEY,
        bundlePath: bundle,
      });
      const cleanup = u._macReplaceSteps(path.join(t.dir, MAC_FILE), bundle, process.pid)[7];
      // The bundle's own dir, ~/Applications, and /Applications have nothing
      // named zevet* to sweep here, so the loop's last `[ -e "$f" ]` is false.
      // Every step is joined with `&&` (_spawnMacReplace), so a step that
      // exits non-zero on the harmless "nothing to clean up" case would
      // silently cancel the `open` (relaunch) chained after it.
      execFileSync("/bin/sh", ["-c", cleanup]);
    } finally {
      t.cleanup();
    }
  });

  test("Restart now on a self-replacing build runs the shell steps, opens the bundle, then quits", async (t) => {
    const calls = [];
    let quit = 0;
    const { u, dir } = await downloadedMac(t, {
      spawnImpl: (...a) => {
        calls.push(a);
        return { unref() {} };
      },
      quitImpl: () => {
        quit++;
      },
    });
    const bundle = path.join(dir, "zevet.app");
    u.bundlePath = bundle;

    const r = await u.install();
    assert.equal(r.ok, true);
    assert.equal(r.restarting, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "/bin/sh");
    assert.equal(calls[0][1][0], "-c");
    const script = calls[0][1][1];
    assert.match(script, /hdiutil.*attach/);
    assert.match(script, /ditto/);
    assert.match(script, /hdiutil.*detach/);
    assert.match(script, /open /, "Restart now must relaunch the app");

    await new Promise((r2) => setTimeout(r2, 900));
    assert.equal(quit, 1);
  });

  test("install-on-quit on a self-replacing build does not relaunch", async (t) => {
    const calls = [];
    const { u, dir } = await downloadedMac(t, {
      spawnImpl: (...a) => {
        calls.push(a);
        return { unref() {} };
      },
    });
    u.bundlePath = path.join(dir, "zevet.app");

    const r = u.installOnQuit();
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    const script = calls[0][1][1];
    assert.ok(!/open /.test(script), "the quit path must not relaunch");
  });
});

// %APPDATA%/zevet-desktop/updates was found holding one installer per
// version since 0.2.1, plus a hand-dropped "zevet-9.9.9-windows-x64-setup.exe"
// test fixture — this.dir only ever grew. These are the pruning behaviour
// added to stop that: keep the file a check still needs, and nothing else.
describe("old installers are pruned", () => {
  test("a fresh download keeps only the file just downloaded", async () => {
    const t = tempDir("zevet-prune-");
    const junk = ["zevet-0.2.1-windows-x64-setup.exe", "zevet-9.9.9-windows-x64-setup.exe", "stray.part"];
    for (const name of junk) writeFileSync(path.join(t.dir, name), "junk");
    const body = randomBytes(4096);
    const host = await fakeHost({
      manifest: { version: "0.2.2", platforms: { [KEY]: { file: "zevet-0.2.2-windows-x64-setup.exe", sha256: sha(body), bytes: body.length } } },
      files: { "zevet-0.2.2-windows-x64-setup.exe": body },
    });
    try {
      const u = updaterFor(host, t.dir);
      const s = await u.check();
      assert.equal(s.phase, "ready");
      const left = readdirSync(t.dir).sort();
      assert.deepEqual(left, ["zevet-0.2.2-windows-x64-setup.exe"]);
    } finally {
      await host.close();
      t.cleanup();
    }
  });

  test("once current again, the directory is left holding nothing", async () => {
    const t = tempDir("zevet-prune-");
    const junk = ["zevet-0.1.0-windows-x64-setup.exe", "zevet-0.1.2-windows-x64-setup.exe"];
    for (const name of junk) writeFileSync(path.join(t.dir, name), "junk");
    const host = await fakeHost({
      manifest: { version: "0.1.2", platforms: { [KEY]: { file: "zevet-0.1.2-windows-x64-setup.exe", sha256: sha(Buffer.from("x")), bytes: 1 } } },
      files: {},
    });
    try {
      // currentVersion (0.1.2) already matches the feed, so check() takes the
      // "phase: current" branch — no download happens at all.
      const u = updaterFor(host, t.dir, { currentVersion: "0.1.2" });
      const s = await u.check();
      assert.equal(s.phase, "current");
      assert.deepEqual(readdirSync(t.dir), []);
    } finally {
      await host.close();
      t.cleanup();
    }
  });

  test("the install-on-quit marker survives a prune that runs before the app quits", async () => {
    const t = tempDir("zevet-prune-");
    const body = randomBytes(2048);
    const host = await fakeHost({
      manifest: { version: "0.2.0", platforms: { [KEY]: { file: "zevet-0.2.0-windows-x64-setup.exe", sha256: sha(body), bytes: body.length } } },
      files: { "zevet-0.2.0-windows-x64-setup.exe": body },
    });
    try {
      // Forced to win32: this is exactly the "on Windows" install-on-quit
      // path (line ~477's test), and must behave the same whichever OS runs
      // the suite — `updaterFor` otherwise defaults to `process.platform`,
      // which made this pass locally on Windows and fail on the macOS runner.
      const u = updaterFor(host, t.dir, { platform: "win32", spawnImpl: () => ({ unref() {} }) });
      assert.equal((await u.check()).phase, "ready");
      const r = u.installOnQuit();
      assert.equal(r.ok, true);
      assert.ok(existsSync(path.join(t.dir, "install-on-quit.json")));
      // A background check landing between the marker being written and the
      // process actually quitting must not sweep the marker away — that would
      // let the very next launch silently re-attempt the same install.
      await u.check();
      assert.ok(existsSync(path.join(t.dir, "install-on-quit.json")));
    } finally {
      await host.close();
      t.cleanup();
    }
  });
});

describe("a signed feed and a signed installer", () => {
  const body = randomBytes(2048);
  const good = { version: "0.2.0", notes: "n", platforms: { [KEY]: { file: FILE, sha256: sha(body), bytes: body.length } } };
  const andrew = { valid: true, publisher: "CN=Andrew Doft, O=Andrew Doft, L=New York, S=ny, C=US" };

  async function checked(context, manifest, opts = {}) {
    const t = tempDir("zevet signed ");
    const host = await fakeHost({ manifest, files: { [FILE]: body } });
    context.after(async () => {
      await host.close();
      t.cleanup();
    });
    const u = updaterFor(host, t.dir, { platform: "win32", ...opts });
    return { u, host, t, status: await u.check() };
  }
  const fetchedInstaller = (host) => host.seen.some((p) => p.endsWith(FILE));

  test("an unsigned feed is rejected and nothing is downloaded", async (t) => {
    const r = await checked(t, { raw: good });
    assert.equal(r.status.phase, "error");
    assert.match(r.status.error, /not validly signed/);
    assert.equal(fetchedInstaller(r.host), false);
  });

  test("a feed signed by a key that is not pinned is rejected (real pinned keys, throwaway signer)", async (t) => {
    const r = await checked(t, good, { trustedKeys: undefined });
    assert.equal(r.status.phase, "error");
    assert.match(r.status.error, /untrusted key/);
    assert.equal(fetchedInstaller(r.host), false);
  });

  test("editing the signed payload after signing is rejected", async (t) => {
    const feed = signedFeed(good);
    feed.payload.platforms[KEY].sha256 = "0".repeat(64);
    const r = await checked(t, { raw: feed });
    assert.equal(r.status.phase, "error");
    assert.match(r.status.error, /does not match the document/);
    assert.equal(fetchedInstaller(r.host), false);
  });

  test("the legacy top-level fields are ignored: the signed payload decides", async (t) => {
    const evil = "zevet-9.9.9-windows-x64-setup.exe";
    const feed = {
      ...signedFeed(good),
      version: "9.9.9",
      platforms: { [KEY]: { file: evil, sha256: "f".repeat(64), bytes: 1 } },
    };
    const r = await checked(t, { raw: feed });
    assert.equal(r.status.phase, "ready");
    assert.equal(r.status.version, "0.2.0");
    assert.equal(fetchedInstaller(r.host), true);
    assert.equal(r.host.seen.some((p) => p.includes("9.9.9")), false);
  });

  test("readSignedFeed hands back only the payload", () => {
    const ok = readSignedFeed(signedFeed(good), TEST_KEYS);
    assert.deepEqual(ok.payload.platforms, good.platforms);
    assert.match(readSignedFeed({ version: "0.2.0" }, TEST_KEYS).error, /not signed|not validly signed/);
    assert.match(readSignedFeed(null).error, /not an object/);
  });

  test("a running app signed by Andrew refuses an installer that is unsigned", async (t) => {
    const r = await checked(t, good, {
      inspectImpl: async (_p, file) => (file === FILE || file.endsWith(FILE) ? { valid: false, publisher: null } : andrew),
    });
    assert.equal(r.status.phase, "error");
    assert.match(r.status.error, /not signed as Authenticode CN=Andrew Doft/);
    assert.equal(existsSync(path.join(r.t.dir, FILE)), false, "the rejected installer was left on disk");
    assert.equal(r.status.canInstall, false);
  });

  test("a running app signed by Andrew refuses an installer signed by somebody else", async (t) => {
    const r = await checked(t, good, {
      inspectImpl: async (_p, file) => (file.endsWith(FILE) ? { valid: true, publisher: "CN=Mallory" } : andrew),
    });
    assert.equal(r.status.phase, "error");
    assert.equal(existsSync(path.join(r.t.dir, FILE)), false);
  });

  test("a properly signed installer is offered", async (t) => {
    const r = await checked(t, good, { inspectImpl: async () => andrew });
    assert.equal(r.status.phase, "ready");
    assert.equal(r.status.canInstall, true);
  });

  test("an unsigned running app (dev build) only logs the publisher check", async (t) => {
    const r = await checked(t, good);
    assert.equal(r.status.phase, "ready");
    assert.ok(r.u.logs.some((l) => /publisher check is log-only/.test(l)), r.u.logs.join(" | "));
  });

  test("a cached installer is publisher-checked too, not trusted for having been verified once", async (t) => {
    const r = await checked(t, good, { inspectImpl: async () => andrew });
    assert.equal(r.status.phase, "ready");
    const again = updaterFor(r.host, r.t.dir, {
      platform: "win32",
      inspectImpl: async (_p, file) => (file.endsWith(FILE) ? { valid: false, publisher: null } : andrew),
    });
    assert.equal((await again.check()).phase, "error");
    assert.equal(existsSync(path.join(r.t.dir, FILE)), false);
  });

  test("the loopback proof key applies to a loopback feed only", () => {
    const env = { ZEVET_APP_FEED_TRUSTED_KEY: "zevet-test:AAAA" };
    assert.deepEqual(loopbackProofKeys("http://127.0.0.1:9/zevet-latest.json", env), { "zevet-test": "AAAA" });
    assert.equal(loopbackProofKeys("https://usemasora.com/download/zevet-latest.json", env), undefined);
    assert.equal(loopbackProofKeys("http://evil.example/zevet-latest.json", env), undefined);
    assert.equal(loopbackProofKeys("http://127.0.0.1.evil.example/x.json", env), undefined);
    assert.equal(loopbackProofKeys("http://127.0.0.1:9/x.json", {}), undefined);
    assert.equal(loopbackProofKeys(undefined, env), undefined);
  });
});

describe("rollback wiring (update-rollback.js)", () => {
  const { createRollback, STATE_FILE } = require(path.join(ROOT, "desktop", "update-rollback.js"));
  const mkRollback = (dir, spawned = []) => createRollback({
    dir, running: "0.1.2", spawn: (f) => { spawned.push(f); return { unref() {} }; },
    verifyPublisher: async () => true, verifiedOnDisk: async () => true, stopRuntime: async () => {}, quit: () => {},
  });

  test("the Windows installer run records what the next launch must prove, BEFORE it spawns", async () => {
    const t = tempDir("zevet-rb-");
    try {
      const file = path.join(t.dir, "setup.exe");
      writeFileSync(file, "not really an installer");
      const rollback = mkRollback(t.dir);
      let atSpawn = null;
      const u = new AppUpdater({
        currentVersion: "0.1.2", platform: "win32", dir: t.dir, platformKey: KEY, rollback,
        execPath: path.win32.join(t.dir, "zevet", "zevet.exe"),
        spawnImpl: () => { atSpawn = rollback.state().pending; return { unref() {} }; },
        quitImpl() {},
      });
      u.state.phase = "ready";
      u.state.version = "0.2.0";
      u.state.file = file;
      u._readyEntry = { file: "setup.exe", bytes: statSync(file).size, sha256: sha(readFileSync(file)) };
      assert.equal((await u.install()).ok, true);
      assert.equal(atSpawn.to, "0.2.0");
      assert.equal(atSpawn.entry.file, "setup.exe");
    } finally {
      t.cleanup();
    }
  });

  test("the silent install on quit is covered too, with QUIT_INSTALL_ARGS and no --force-run", () => {
    const t = tempDir("zevet-rb-");
    try {
      const file = path.join(t.dir, "setup.exe");
      writeFileSync(file, "not really an installer");
      const rollback = mkRollback(t.dir);
      const calls = [];
      const u = new AppUpdater({
        currentVersion: "0.1.2", platform: "win32", dir: t.dir, platformKey: KEY, rollback,
        execPath: path.win32.join(t.dir, "zevet", "zevet.exe"),
        spawnImpl: (...a) => { calls.push(a); return { unref() {} }; },
      });
      u.state.phase = "ready";
      u.state.version = "0.2.0";
      u.state.file = file;
      u._readyEntry = { file: "setup.exe", bytes: statSync(file).size, sha256: sha(readFileSync(file)) };
      assert.equal(u.installOnQuit().ok, true);
      assert.equal(rollback.state().pending.to, "0.2.0");
      assert.deepEqual(calls[0][1].slice(0, QUIT_INSTALL_ARGS.length), QUIT_INSTALL_ARGS);
      assert.equal(calls[0][1].includes("--force-run"), false);
    } finally {
      t.cleanup();
    }
  });

  test("the rollback target and its state file survive every prune; other installers do not", async () => {
    const t = tempDir("zevet-rb-");
    const body = randomBytes(2048);
    const host = await fakeHost({
      manifest: { version: "0.2.2", platforms: { [KEY]: { file: "zevet-0.2.2-windows-x64-setup.exe", sha256: sha(body), bytes: body.length } } },
      files: { "zevet-0.2.2-windows-x64-setup.exe": body },
    });
    try {
      writeFileSync(path.join(t.dir, STATE_FILE), JSON.stringify({ bad: [], pending: null, lastGood: { version: "0.1.2", file: "zevet-0.1.2-windows-x64-setup.exe", bytes: 1, sha256: "x" } }));
      writeFileSync(path.join(t.dir, "zevet-0.1.2-windows-x64-setup.exe"), "the installer that produced the running version");
      writeFileSync(path.join(t.dir, "zevet-0.0.9-windows-x64-setup.exe"), "stale");
      const u = updaterFor(host, t.dir, { rollback: mkRollback(t.dir) });
      assert.equal((await u.check()).phase, "ready");
      assert.deepEqual(readdirSync(t.dir).sort(), [STATE_FILE, "zevet-0.1.2-windows-x64-setup.exe", "zevet-0.2.2-windows-x64-setup.exe"]);
    } finally {
      await host.close();
      t.cleanup();
    }
  });

  test("a withdrawn version is not an update: not downloaded, not an error", async () => {
    const t = tempDir("zevet-rb-");
    const body = randomBytes(2048);
    const host = await fakeHost({
      manifest: { version: "0.2.2", platforms: { [KEY]: { file: "zevet-0.2.2-windows-x64-setup.exe", sha256: sha(body), bytes: body.length } } },
      files: { "zevet-0.2.2-windows-x64-setup.exe": body },
    });
    try {
      writeFileSync(path.join(t.dir, STATE_FILE), JSON.stringify({ bad: ["0.2.2"], pending: null, lastGood: null }));
      const u = updaterFor(host, t.dir, { rollback: mkRollback(t.dir) });
      const s = await u.check();
      assert.equal(s.phase, "current");
      assert.equal(s.error, null);
      assert.equal(s.canInstall, false);
      assert.equal(host.seen.some((r) => r.endsWith("setup.exe")), false, "a withdrawn installer was downloaded");
    } finally {
      await host.close();
      t.cleanup();
    }
  });

  test("an already-downloaded withdrawn installer is deleted, and a NEWER version is still offered", async () => {
    const t = tempDir("zevet-rb-");
    const body = randomBytes(2048);
    const file = "zevet-0.2.2-windows-x64-setup.exe";
    const host = await fakeHost({
      manifest: { version: "0.2.2", platforms: { [KEY]: { file, sha256: sha(body), bytes: body.length } } },
      files: { [file]: body },
    });
    try {
      writeFileSync(path.join(t.dir, file), body);
      writeFileSync(path.join(t.dir, STATE_FILE), JSON.stringify({ bad: ["0.2.2"], pending: null, lastGood: null }));
      const u = updaterFor(host, t.dir, { rollback: mkRollback(t.dir) });
      assert.equal((await u.check()).phase, "current");
      assert.equal(existsSync(path.join(t.dir, file)), false);
    } finally {
      await host.close();
      t.cleanup();
    }
    const host2 = await fakeHost({
      manifest: { version: "0.2.3", platforms: { [KEY]: { file: "zevet-0.2.3-windows-x64-setup.exe", sha256: sha(body), bytes: body.length } } },
      files: { "zevet-0.2.3-windows-x64-setup.exe": body },
    });
    const t2 = tempDir("zevet-rb-");
    try {
      writeFileSync(path.join(t2.dir, STATE_FILE), JSON.stringify({ bad: ["0.2.2"], pending: null, lastGood: null }));
      assert.equal((await updaterFor(host2, t2.dir, { rollback: mkRollback(t2.dir) }).check()).phase, "ready");
    } finally {
      await host2.close();
      t2.cleanup();
    }
  });
});

describe("per-platform feed keys: linux-x64 and win32-arm64", () => {
  const feed = (key, file) => ({ version: "0.2.0", platforms: { [key]: { file, sha256: "a".repeat(64), bytes: 10 } } });

  test("platformKey is platform-arch, so linux/x64 and win32/arm64 select their own entries", () => {
    assert.equal(platformKey("linux", "x64"), "linux-x64");
    assert.equal(platformKey("win32", "arm64"), "win32-arm64");
  });

  test("each new key accepts only its own artifact name", () => {
    assert.equal(readManifest(feed("linux-x64", "zevet-0.2.0-linux-x64.AppImage"), "linux-x64").error, undefined);
    assert.equal(readManifest(feed("win32-arm64", "zevet-0.2.0-windows-arm64-setup.exe"), "win32-arm64").error, undefined);
    assert.match(readManifest(feed("win32-arm64", "zevet-0.2.0-windows-x64-setup.exe"), "win32-arm64").error, /not the win32-arm64 artifact/);
    assert.match(readManifest(feed("win32-x64", "zevet-0.2.0-windows-arm64-setup.exe"), "win32-x64").error, /not the win32-x64 artifact/);
    assert.match(readManifest(feed("linux-x64", "zevet-0.2.0-macos-arm64.dmg"), "linux-x64").error, /not the linux-x64 artifact/);
  });

  test("a feed with no entry for this machine says so", () => {
    assert.match(readManifest(feed("win32-x64", "zevet-0.2.0-windows-x64-setup.exe"), "linux-x64").error, /no build for linux-x64/);
  });
});

describe("self-replacing a Linux AppImage", () => {
  const LKEY = "linux-x64";
  const LFILE = "zevet-0.2.0-linux-x64.AppImage";

  async function ready(context, appImageName = "zevet.AppImage") {
    const t = tempDir("zevet linux with spaces ");
    const body = randomBytes(4096);
    const host = await fakeHost({
      manifest: { version: "0.2.0", platforms: { [LKEY]: { file: LFILE, sha256: sha(body), bytes: body.length } } },
      files: { [LFILE]: body },
    });
    context.after(async () => {
      await host.close();
      t.cleanup();
    });
    const appImage = path.join(t.dir, appImageName);
    writeFileSync(appImage, "old build");
    const spawned = [];
    let quit = 0;
    const u = updaterFor(host, path.join(t.dir, "dl"), {
      platform: "linux",
      platformKey: LKEY,
      appImagePath: appImage,
      spawnImpl: (cmd, args, o) => { spawned.push({ cmd, args, o }); return { unref() {} }; },
      quitImpl: () => { quit++; },
    });
    assert.equal((await u.check()).phase, "ready");
    return { u, body, appImage, spawned, quit: () => quit };
  }

  test("check offers the AppImage (the .AppImage name passes the kit's extension filter)", async (t) => {
    const { u } = await ready(t);
    assert.equal(u.state.version, "0.2.0");
  });

  test("no $APPIMAGE means no self-replace and no guess", async (t) => {
    const { u } = await ready(t);
    u.appImagePath = null;
    assert.equal(u.canSelfReplaceAppImage(), false);
    assert.equal((await u.install()).ok, false);
    assert.equal(u.installOnQuit().ok, false);
  });

  test("install swaps the file in place and relaunches after this process exits", async (t) => {
    const { u, body, appImage, spawned, quit } = await ready(t);
    assert.equal(u.canSelfReplaceAppImage(), true);
    const r = await u.install();
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(readFileSync(appImage), body);
    assert.equal(existsSync(`${appImage}.update`), false, "no staging file left behind");
    if (process.platform !== "win32") assert.ok(statSync(appImage).mode & 0o100, "executable");
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].cmd, "/bin/sh");
    assert.match(spawned[0].args[1], /kill -0 \d+.*exec '.*zevet\.AppImage'$/);
    assert.equal(spawned[0].o.detached, true);
    await new Promise((r2) => setTimeout(r2, 800));
    assert.equal(quit(), 1);
  });

  test("installOnQuit swaps the file but neither relaunches nor quits", async (t) => {
    const { u, body, appImage, spawned, quit } = await ready(t);
    const r = u.installOnQuit();
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(readFileSync(appImage), body);
    assert.equal(spawned.length, 0);
    assert.equal(quit(), 0);
  });
});
