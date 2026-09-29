// The real desktop-kit payload client against Zevet's real payload tree, over loopback: stage the tree as the
// installer's seed, publish a second build with `make-feed.mjs payload`, and check the client takes it
// fetching only what changed, refuses a tampered one, and reverts a crashing one on the third strike.
// (The packaged app's own version of this is scripts/test-payload-swap.mjs, run in CI.)
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = path.join(ROOT, "desktop");
const require = createRequire(import.meta.url);
const kitPayload = path.join(DESKTOP, "node_modules", "@masora", "desktop-kit", "lib", "payload.js");
const haveKit = fs.existsSync(kitPayload);
const cfg = require(path.join(DESKTOP, "payload-config.js"));
const version = JSON.parse(fs.readFileSync(path.join(DESKTOP, "package.json"), "utf8")).version;

describe("payload client + publisher + Zevet's tree", { skip: haveKit ? false : "desktop-kit has no lib/payload.js installed (npm ci in desktop/ after the pin)" }, () => {
  let tmp, seedDir, server, base, requests, keys, seedSeq, nextBuild, signEnv;
  const platform = "win-x64";

  const publish = (tree, build, extra = []) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "make-feed.mjs"), "payload", "--out", path.join(tmp, "srv"), "--tree", tree, "--build", build, ...extra], { encoding: "utf8", env: { ...process.env, ...signEnv } });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  };
  const client = (name) => {
    const { createPayloadClient } = require(kitPayload);
    return createPayloadClient({
      app: "zevet", channel: "canary", platform, root: path.join(tmp, name), seedDir, seedBuild: version, seedSeq,
      pulseUrl: `${base}/p/zevet/canary/${platform}/pulse.json`, keys, shellVersion: cfg.SHELL_VERSION,
      schemaHead: async () => null, installId: "test-install", log: () => {},
    });
  };
  /** A copy of the seed with one file changed (and an optional extra file). */
  const variant = (name, edit) => {
    const dir = path.join(tmp, name);
    fs.cpSync(seedDir, dir, { recursive: true });
    edit(dir);
    return dir;
  };

  before(async () => {
    if (!fs.existsSync(path.join(DESKTOP, "build", "icon.png"))) spawnSync(process.execPath, ["make-icon.mjs"], { cwd: DESKTOP });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zevet-e2e-"));
    seedDir = require(path.join(DESKTOP, "payload-tree.cjs")).stage(path.join(tmp, "seed"));
    seedSeq = cfg.seqOf(version);
    const [maj, min, pat] = version.split(".").map(Number);
    nextBuild = `${maj}.${min}.${pat + 1}`;
    requests = [];
    server = http.createServer((req, res) => {
      requests.push(req.url);
      const file = path.join(tmp, "srv", decodeURIComponent(req.url.split("?")[0]));
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "cache-control": "no-store" }).end(fs.readFileSync(file));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
    // One throwaway keypair signs every publish here, under the id the real key has; the client pins its public half.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    signEnv = { ZEVET_UPDATE_SIGNING_KEY: privateKey.export({ format: "pem", type: "pkcs8" }).replaceAll("\n", "|") };
    keys = { [Object.keys(require(path.join(DESKTOP, "update-signing.js")).PINNED_KEYS)[0]]: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") };
    publish(variant("v1", (d) => fs.appendFileSync(path.join(d, "console-log.js"), "\n// v1\n")), nextBuild);
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("the seed is the running build, and a fresh client with nothing published newer stages nothing", async () => {
    const c = client("root-a");
    const cur = c.resolve();
    assert.equal(cur.source, "seed");
    assert.equal(cur.build, version);
    assert.equal(path.resolve(cur.dir), path.resolve(seedDir));
  });

  test("a published build is staged fetching ONLY the changed file, then swaps without any installer", async () => {
    const c = client("root-b");
    c.resolve();
    requests.length = 0;
    const r = await c.check();
    assert.equal(r.status, "staged", JSON.stringify(r));
    const blobs = requests.filter((u) => u.startsWith("/p/b/"));
    assert.equal(blobs.length, 1, `fetched ${blobs.length} blobs: only console-log.js changed`);
    assert.ok(requests.some((u) => u.endsWith("/pulse.json")) && requests.some((u) => u.startsWith("/p/m/")));
    assert.equal(c.staged().build, nextBuild);
    assert.match(fs.readFileSync(path.join(c.staged().dir, "console-log.js"), "utf8"), /\/\/ v1/);
    assert.ok(fs.existsSync(path.join(c.staged().dir, "main.js")), "the staged tree has no main.js for bootstrap to require");
    const next = c.activate();
    assert.equal(next.build, nextBuild);
    const again = client("root-b").resolve();
    assert.equal(again.source, "current");
    assert.equal(again.trial, true);
    assert.equal(again.build, nextBuild);
  });

  test("the pulse is checked against the pinned key: a client that pins another key refuses it", async () => {
    const c = createRequire(import.meta.url)(kitPayload).createPayloadClient({
      app: "zevet", channel: "canary", platform, root: path.join(tmp, "root-c"), seedDir, seedBuild: version, seedSeq,
      pulseUrl: `${base}/p/zevet/canary/${platform}/pulse.json`, keys: { "someone-else": Buffer.alloc(32, 7).toString("base64") },
      shellVersion: cfg.SHELL_VERSION, schemaHead: async () => null, installId: "x", log: () => {},
    });
    c.resolve();
    const r = await c.check().catch((e) => ({ status: "error", reason: e.message }));
    assert.notEqual(r.status, "staged");
    assert.equal(c.staged(), null);
  });

  test("a build that crashes on boot is reverted to the previous one on the third strike", async () => {
    const bad = variant("v2", (d) => fs.writeFileSync(path.join(d, "main.js"), 'throw new Error("crash on boot");\n'));
    const badBuild = `${nextBuild.split(".").slice(0, 2).join(".")}.${Number(nextBuild.split(".")[2]) + 1}`;
    publish(bad, badBuild);
    const c = client("root-d");
    c.resolve();
    await c.check();
    c.activate();
    let r;
    for (let i = 1; i <= 3; i++) {
      const cur = client("root-d").resolve();
      assert.equal(cur.build, badBuild, `strike ${i}: still on the bad build`);
      r = client("root-d").bootFailed(`crash ${i}`);
      assert.equal(r.reverted, i === 3, `strike ${i}`);
    }
    const after = client("root-d").resolve();
    assert.notEqual(after.build, badBuild);
    // and it is never re-applied
    const again = client("root-d");
    again.resolve();
    assert.notEqual((await again.check()).status, "staged");
  });
});
