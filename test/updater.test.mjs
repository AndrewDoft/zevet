// The updater, against a hub that is lying to it.
//
// THREAT MODEL, stated so the tests below have a point. The hub is trusted to
// ship new client code — that is the feature. It is NOT trusted to write
// anywhere it likes on a teammate's machine. Over plain HTTP the "hub" may
// also be whoever is on the network, so every one of these cases is reachable
// by an attacker, not only by a compromised host.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { tempDir, ROOT } from "./helpers.mjs";

const TOKEN = "updater-test-token";

/** A hub that serves exactly what a test tells it to, including nonsense. */
async function fakeHub(files, { manifestOverride = null, version = "9.9.9", omit = [] } = {}) {
  const entries = Object.entries(files).map(([name, content]) => ({
    name,
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  }));
  const manifest = manifestOverride ?? { version, files: entries };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/dist/manifest.json") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(manifest));
    }
    if (url.pathname.startsWith("/dist/")) {
      const name = decodeURIComponent(url.pathname.slice("/dist/".length));
      if (omit.includes(name) || !(name in files)) {
        res.writeHead(404);
        return res.end("nope");
      }
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(files[name]);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((r) => server.close(r)),
  };
}

function runUpdater(home, hub) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "client", "updater.mjs")], {
      env: { ...process.env, ZEVET_HOME: home, ZEVET_HUB: hub, ZEVET_TOKEN: TOKEN },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

describe("the updater", () => {
  test("installs what the hub is serving", async () => {
    const home = tempDir("zevet-up-");
    const hub = await fakeHub({ "hook.mjs": "// v2 hook\n", "updater.mjs": "// v2 updater\n" });
    try {
      const r = await runUpdater(home.dir, hub.base);
      assert.equal(r.code, 0);
      assert.equal(readFileSync(path.join(home.dir, "client", "hook.mjs"), "utf8"), "// v2 hook\n");
      assert.equal(JSON.parse(readFileSync(path.join(home.dir, "manifest.json"), "utf8")).version, "9.9.9");
    } finally {
      await hub.stop();
      home.cleanup();
    }
  });

  test("a second run with nothing new is silent and writes nothing", async () => {
    const home = tempDir("zevet-up2-");
    const hub = await fakeHub({ "hook.mjs": "// v2\n" });
    try {
      await runUpdater(home.dir, hub.base);
      const r = await runUpdater(home.dir, hub.base);
      assert.equal(r.code, 0);
      assert.equal(r.stderr.trim(), "", `should say nothing, said: ${r.stderr}`);
    } finally {
      await hub.stop();
      home.cleanup();
    }
  });

  test("refuses a file whose checksum does not match the manifest", async () => {
    const home = tempDir("zevet-up3-");
    // The manifest promises one thing; the route serves another.
    const honest = { "hook.mjs": "// honest\n" };
    const entries = [
      {
        name: "hook.mjs",
        bytes: 10,
        sha256: createHash("sha256").update("// something else entirely\n").digest("hex"),
      },
    ];
    const hub = await fakeHub(honest, { manifestOverride: { version: "9.9.9", files: entries } });
    try {
      const r = await runUpdater(home.dir, hub.base);
      assert.equal(r.code, 0, "still exits cleanly");
      assert.match(r.stderr, /checksum/i);
      assert.ok(!existsSync(path.join(home.dir, "client", "hook.mjs")), "nothing was installed");
    } finally {
      await hub.stop();
      home.cleanup();
    }
  });

  test("a file that 404s mid-update leaves the previous build intact", async () => {
    const home = tempDir("zevet-up4-");
    const first = await fakeHub({ "hook.mjs": "// v1\n", "install.mjs": "// v1 install\n" }, { version: "1.0.0" });
    try {
      await runUpdater(home.dir, first.base);
      assert.equal(readFileSync(path.join(home.dir, "client", "hook.mjs"), "utf8"), "// v1\n");
    } finally {
      await first.stop();
    }

    const second = await fakeHub(
      { "hook.mjs": "// v2\n", "install.mjs": "// v2 install\n" },
      { version: "2.0.0", omit: ["install.mjs"] },
    );
    try {
      const r = await runUpdater(home.dir, second.base);
      assert.equal(r.code, 0);
      assert.equal(
        readFileSync(path.join(home.dir, "client", "hook.mjs"), "utf8"),
        "// v1\n",
        "a partial update must not land — hook.mjs downloaded fine but install.mjs did not",
      );
      assert.equal(JSON.parse(readFileSync(path.join(home.dir, "manifest.json"), "utf8")).version, "1.0.0");
    } finally {
      await second.stop();
      home.cleanup();
    }
  });

  test("exits cleanly when the hub is unreachable", async () => {
    const home = tempDir("zevet-up5-");
    try {
      const r = await runUpdater(home.dir, "http://127.0.0.1:1");
      assert.equal(r.code, 0);
      assert.match(r.stderr, /check failed|hub/i);
    } finally {
      home.cleanup();
    }
  });

  describe("a hostile manifest", () => {
    const escapes = {
      "parent traversal": "../escaped.mjs",
      "deep traversal": "../../../escaped-deep.mjs",
      "windows traversal": "..\\escaped-win.mjs",
      "absolute posix": "/tmp/zevet-escaped.mjs",
      "nested path": "sub/dir/escaped-nested.mjs",
    };

    for (const [label, name] of Object.entries(escapes)) {
      test(`refuses to write outside its own directory: ${label}`, async () => {
        const home = tempDir("zevet-evil-");
        const clientDir = path.join(home.dir, "client");
        mkdirSync(clientDir, { recursive: true });
        // A canary the update must not be able to reach.
        const canary = path.join(home.dir, "escaped.mjs");

        const hub = await fakeHub({ [name]: "// pwned\n" });
        try {
          const r = await runUpdater(home.dir, hub.base);
          assert.equal(r.code, 0, "exits cleanly rather than crashing");

          assert.ok(!existsSync(canary), `wrote outside client/: ${canary}`);
          const stray = readdirSync(home.dir).filter((f) => f.includes("escaped"));
          assert.deepEqual(stray, [], `stray files in ZEVET_HOME: ${stray.join(", ")}`);
          const inClient = existsSync(clientDir) ? readdirSync(clientDir) : [];
          assert.ok(
            !inClient.some((f) => f.includes("escaped")),
            `unexpected file in client/: ${inClient.join(", ")}`,
          );
        } finally {
          await hub.stop();
          home.cleanup();
        }
      });
    }

    test("refuses a manifest that is not shaped like a manifest", async () => {
      const home = tempDir("zevet-shape-");
      const hub = await fakeHub({}, { manifestOverride: { version: "9.9.9", files: "not-an-array" } });
      try {
        const r = await runUpdater(home.dir, hub.base);
        assert.equal(r.code, 0, "must not crash on a malformed manifest");
      } finally {
        await hub.stop();
        home.cleanup();
      }
    });
  });

  test("a held lock stops a second updater from running concurrently", async () => {
    const home = tempDir("zevet-lock-");
    mkdirSync(home.dir, { recursive: true });
    writeFileSync(path.join(home.dir, "update.lock"), String(Date.now()), "utf8");
    const hub = await fakeHub({ "hook.mjs": "// v2\n" });
    try {
      const r = await runUpdater(home.dir, hub.base);
      assert.equal(r.code, 0);
      assert.ok(!existsSync(path.join(home.dir, "client", "hook.mjs")), "the lock held it off");
    } finally {
      await hub.stop();
      home.cleanup();
    }
  });

  test("a stale lock is cleared rather than wedging updates forever", async () => {
    const home = tempDir("zevet-stale-");
    mkdirSync(home.dir, { recursive: true });
    writeFileSync(path.join(home.dir, "update.lock"), String(Date.now() - 60 * 60 * 1000), "utf8");
    const hub = await fakeHub({ "hook.mjs": "// v2\n" });
    try {
      const r = await runUpdater(home.dir, hub.base);
      assert.equal(r.code, 0);
      assert.ok(existsSync(path.join(home.dir, "client", "hook.mjs")), "a stale lock must not block forever");
    } finally {
      await hub.stop();
      home.cleanup();
    }
  });
});
