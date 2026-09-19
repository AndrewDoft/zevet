// The desktop updater, against a download host that is lying to it.
//
// THREAT MODEL, so the cases below have a point. This module downloads a file
// and then EXECUTES it, which makes it the most dangerous thing in the app by
// some distance. The host is trusted to publish new builds — that is the
// feature — and is NOT trusted to choose where the bytes come from, where they
// land, or whether they are run before they have been checked.
//
// ⚠️ AND ONE THING THESE TESTS DO NOT SHOW. The sha256 is published by the
// same host as the file, so none of this survives that host being taken over.
// See the header of desktop/app-update.js: what the checksum buys is integrity
// against corruption, not authenticity. The tests below are about the updater
// obeying its own rules, not about the rules being sufficient.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { tempDir, ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const {
  AppUpdater,
  compareVersions,
  platformKey,
  safeArtifactName,
  artifactUrl,
  readManifest,
} = require(path.join(ROOT, "desktop", "app-update.js"));

const KEY = "win32-x64";
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
      res.end(typeof m === "string" ? m : JSON.stringify(m));
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
    platforms: { [KEY]: { file: "a.exe", sha256: "a".repeat(64), bytes: 10 } },
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
      [{ version: "0.2.0", platforms: { [KEY]: { file: "a.exe", sha256: "short", bytes: 1 } } }, /no usable sha256/],
      [{ version: "0.2.0", platforms: { [KEY]: { file: "a.exe", sha256: "a".repeat(64), bytes: 0 } } }, /no usable size/],
      [{ version: "0.2.0", platforms: { [KEY]: { file: "a.exe", sha256: "a".repeat(64), bytes: 1e12 } } }, /no usable size/],
      [null, /not an object/],
    ];
    for (const [json, re] of cases) {
      const m = readManifest(json, KEY);
      assert.match(m.error || "", re);
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
      manifest: { version: "0.1.2", platforms: { [KEY]: { file: "x.exe", sha256: sha(body), bytes: body.length } } },
      files: { "x.exe": body },
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
      manifest: { version: "0.1.0", platforms: { [KEY]: { file: "x.exe", sha256: "b".repeat(64), bytes: 5 } } },
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
      manifest: { version: "0.2.0", platforms: { [KEY]: { file: "x.exe", sha256: sha(Buffer.from("something else")), bytes: body.length } } },
      files: { "x.exe": body },
    });
    try {
      const u = updaterFor(host, t.dir);
      const s = await u.check();
      assert.equal(s.phase, "error");
      assert.match(s.error, /checksum/);
      assert.equal(s.canInstall, false);
      // ⚠️ The file must not exist under its REAL name, or a later run's
      // `_verified` is the only thing between it and being executed.
      assert.equal(existsSync(path.join(t.dir, "x.exe")), false);
      assert.equal(existsSync(path.join(t.dir, "x.exe.part")), false);
    } finally {
      await host.close();
      t.cleanup();
    }
  });

  test("a download longer than the manifest promised is cut off", async () => {
    const t = tempDir("zevet-upd-");
    const body = randomBytes(9000);
    const host = await fakeHost({
      manifest: { version: "0.2.0", platforms: { [KEY]: { file: "x.exe", sha256: sha(body), bytes: 100 } } },
      files: { "x.exe": body },
    });
    try {
      const s = await updaterFor(host, t.dir).check();
      assert.equal(s.phase, "error");
      assert.match(s.error, /longer than the manifest/);
      assert.equal(existsSync(path.join(t.dir, "x.exe")), false);
    } finally {
      await host.close();
      t.cleanup();
    }
  });

  test("a download SHORTER than promised is rejected too", async () => {
    const t = tempDir("zevet-upd-");
    const body = randomBytes(64);
    const host = await fakeHost({
      manifest: { version: "0.2.0", platforms: { [KEY]: { file: "x.exe", sha256: sha(body), bytes: 4096 } } },
      files: { "x.exe": body },
    });
    try {
      const s = await updaterFor(host, t.dir).check();
      assert.equal(s.phase, "error");
      assert.match(s.error, /bytes and the manifest says/);
      assert.equal(existsSync(path.join(t.dir, "x.exe")), false);
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
      manifest: { version: "0.2.0", platforms: { [KEY]: { file: "x.exe", sha256: sha(body), bytes: body.length } } },
      files: { "x.exe": body },
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
    writeFileSync(path.join(t.dir, "x.exe.part"), randomBytes(900));
    const host = await fakeHost({
      manifest: { version: "0.2.0", platforms: { [KEY]: { file: "x.exe", sha256: sha(body), bytes: body.length } } },
      files: { "x.exe": body },
    });
    try {
      const s = await updaterFor(host, t.dir).check();
      assert.equal(s.phase, "ready");
      assert.equal(sha(readFileSync(s.file)), sha(body));
      assert.equal(existsSync(path.join(t.dir, "x.exe.part")), false);
    } finally {
      await host.close();
      t.cleanup();
    }
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

  test("on Windows the installer is run silently and the app then quits", async (t2) => {
    if (process.platform !== "win32") return t2.skip("the spawn path is Windows-only");
    const t = tempDir("zevet-upd-");
    try {
      const file = path.join(t.dir, "setup.exe");
      writeFileSync(file, "not really an installer");
      const calls = [];
      let quit = 0;
      const u = new AppUpdater({
        currentVersion: "0.1.2",
        dir: t.dir,
        platformKey: KEY,
        spawnImpl: (...a) => {
          calls.push(a);
          return { unref() {} };
        },
        quitImpl: () => { quit++; },
      });
      u.state.phase = "ready";
      u.state.file = file;
      const r = await u.install();
      assert.equal(r.ok, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], file);
      // /S is NSIS's silent switch. Without it the person watches a wizard
      // they did not ask for, after clicking a button that said "restart".
      assert.deepEqual(calls[0][1], ["/S"]);
      assert.equal(calls[0][2].detached, true);
      // The quit is on a short timer so the child is running before we go.
      await new Promise((r2) => setTimeout(r2, 900));
      assert.equal(quit, 1);
    } finally {
      t.cleanup();
    }
  });
});

describe("the platform key", () => {
  test("is what the manifest is written with", () => {
    assert.equal(platformKey("win32", "x64"), "win32-x64");
    assert.equal(platformKey("darwin", "arm64"), "darwin-arm64");
  });
});
