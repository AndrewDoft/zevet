// Proves `zevet --background-update` for real: the actual Electron main process, a throwaway profile, a local signed
// pulse, and nothing of the machine's real zevet touched (own user-data dir, payload root, lock, port).
//
//   node scripts/test-background-update.mjs [<packaged zevet binary>]
//
// With no argument it runs the source tree under desktop/node_modules/electron with ZEVET_TEST_HOOKS=1 (an
// unpackaged run otherwise exits at once: it has no installer to replace). With a packaged binary it runs that.
// The same commands are what to run against the real install:
//   & "C:\Program Files\zevet\zevet.exe" --background-update     (while zevet is CLOSED; read %APPDATA%\zevet-desktop\logs\zevet-boot.log)
// Asserts, in order:
//   1. a newer payload is published: the closed-app job stages it (staged.json + a complete tree), activates nothing
//      (current.json untouched, so the next launch applies it before the first window), and removes a stale old tree;
//   2. the log has exactly one `start:` and one `outcome:` line for the run, and the process exits 0 by itself;
//   3. a second run is a no-op that still logs both lines;
// (The lock-held leg, where zevet is open and the job must do nothing, is unit-tested: payload-bootstrap.test.mjs.)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = path.join(ROOT, "desktop");
const require = createRequire(import.meta.url);
const cfg = require(path.join(DESKTOP, "payload-config.js"));
const { PINNED_KEYS } = require(path.join(DESKTOP, "update-signing.js"));
const platform = cfg.platformKey();
assert.ok(platform, `no payload is published for ${process.platform}-${process.arch}`);

const bin = process.argv[2] ? path.resolve(process.argv[2]) : null;
const [cmd, ...pre] = bin ? [bin] : [require(path.join(DESKTOP, "node_modules", "electron")), DESKTOP];
const V = JSON.parse(fs.readFileSync(path.join(DESKTOP, "package.json"), "utf8")).version;
const [maj, min, pat] = V.split(".").map(Number);
const B1 = `${maj}.${min}.${pat + 1}`;

const base = fs.mkdtempSync(path.join(os.tmpdir(), "zevet-bg-proof-"));
const srv = path.join(base, "srv");
const payloadRoot = path.join(base, "payload");
const userData = path.join(base, "user-data");
const bootLog = path.join(userData, "logs", "zevet-boot.log");
const requests = [];

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keyId = Object.keys(PINNED_KEYS)[0];
const pubRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
const signEnv = { ZEVET_UPDATE_SIGNING_KEY: privateKey.export({ format: "pem", type: "pkcs8" }).replaceAll("\n", "|") };

const server = http.createServer((req, res) => {
  requests.push(req.url);
  const file = path.join(srv, decodeURIComponent(req.url.split("?")[0]));
  if (!file.startsWith(srv) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void res.writeHead(404).end();
  res.writeHead(200, { "cache-control": "no-store" }).end(fs.readFileSync(file));
});

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const logLines = () => (fs.existsSync(bootLog) ? fs.readFileSync(bootLog, "utf8").split("\n").filter((l) => l.includes("[background-update]")) : []);
const count = (re) => logLines().filter((l) => re.test(l)).length;

/** Run the job once; resolves with its exit code, or rejects after `ms` (the job must end by itself). */
function runJob(origin, extraEnv = {}, ms = 90_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...pre, "--background-update", `--user-data-dir=${userData}`], {
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        ZEVET_TEST_HOOKS: "1",
        ZEVET_SEED_DIR: bin ? "" : path.join(base, "seed"),
        ZEVET_PAYLOAD_ROOT: payloadRoot,
        ZEVET_PAYLOAD_CHANNEL: "canary",
        ZEVET_PAYLOAD_PULSE: `${origin}/p/zevet/canary/${platform}/pulse.json`,
        ZEVET_APP_FEED_TRUSTED_KEY: `${keyId}:${pubRaw}`,
        ZEVET_APP_FEED: `${origin}/zevet-latest.json`,
        ...extraEnv,
      },
    });
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("the job did not exit by itself")); }, ms);
    child.on("exit", (code) => { clearTimeout(t); resolve(code); });
  });
}

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const seed = require(path.join(DESKTOP, "payload-tree.cjs")).stage(path.join(base, "seed"));
  const tree = path.join(base, `tree-${B1}`);
  fs.cpSync(seed, tree, { recursive: true });
  fs.appendFileSync(path.join(tree, "console-log.js"), `\n// payload ${B1}\n`);
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "make-feed.mjs"), "payload", "--out", srv, "--tree", tree, "--build", B1, "--channel", "canary"], { encoding: "utf8", windowsHide: true, env: { ...process.env, ...signEnv } });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  console.log(`published ${B1} (seed ${V})`);

  // A stale old tree the job should sweep, and a current build it must leave alone.
  fs.mkdirSync(path.join(payloadRoot, "versions", "0.0.1"), { recursive: true });
  fs.writeFileSync(path.join(payloadRoot, "versions", "0.0.1", ".complete"), "");

  console.log("--- 1. closed app, newer payload published ---");
  assert.equal(await runJob(origin), 0, "the job must exit 0");
  const staged = readJson(path.join(payloadRoot, "staged.json"));
  assert.equal(staged?.build, B1, `staged.json = ${JSON.stringify(staged)}`);
  assert.ok(fs.existsSync(path.join(payloadRoot, "versions", B1, ".complete")), "the staged tree is not complete");
  assert.ok(fs.existsSync(path.join(payloadRoot, "versions", B1, "main.js")));
  assert.equal(readJson(path.join(payloadRoot, "current.json"))?.build ?? null, null, "the job must not activate: the next launch does that");
  assert.equal(fs.existsSync(path.join(payloadRoot, "versions", "0.0.1")), false, "the stale tree was not swept");
  assert.equal(count(/start:/), 1);
  assert.equal(count(/outcome:/), 1);
  assert.ok(logLines().some((l) => l.includes(`outcome: payload staged ${B1}`)), logLines().join("\n"));

  console.log("--- 2. second run: nothing to do, both lines still logged ---");
  assert.equal(await runJob(origin), 0);
  assert.equal(count(/start:/), 2);
  assert.equal(count(/outcome:/), 2);
  assert.ok(logLines().at(-1).includes(`outcome: payload staged ${B1}`), logLines().at(-1));
  assert.equal(requests.filter((u) => u.startsWith("/p/b/")).length, 1, "the second run must not download again");

  console.log(`PASS: closed-app job staged ${B1}, swept the stale tree, logged start+outcome twice, exited 0 each time`);
  console.log(logLines().join("\n"));
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.error(`FAIL: ${err && err.stack || err}\nrequests: ${requests.join(" ")}\n${logLines().join("\n")}`);
} finally {
  server.close();
  fs.rmSync(base, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
