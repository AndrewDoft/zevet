// Proves the payload swap on a PACKAGED app, with no installer involved:
//
//   node scripts/test-payload-swap.mjs <packaged app binary>
//     win:  desktop/out/win-unpacked/zevet.exe
//     mac:  desktop/out/mac-arm64/zevet.app/Contents/MacOS/zevet
//
// Publishes payloads to a local pulse server (make-feed.mjs payload, the release path itself), launches
// the app with everything in throwaway directories, and asserts, in order:
//   1. build B1 differs from the seed in ONE file: the app fetches exactly one blob, swaps to B1 by itself
//      (relaunch, idle gate open: no agent, no input), and confirms it once its window and the agent API are up.
//   2. resources/app.asar is byte-identical afterwards and no installer was fetched: the shell was not touched.
//   3. build B2, whose main.js throws, is taken the same way, crashes three times, and the app reverts to B1,
//      marks B2 bad, and never re-applies it.
// Never run this against a machine with a Zevet you care about, only because it launches the app for real; it
// touches nothing outside its temp directory (own userData, ZEVET_HOME, payload root, port).
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const cfg = require(path.join(ROOT, "desktop", "payload-config.js"));
const { PINNED_KEYS } = require(path.join(ROOT, "desktop", "update-signing.js"));

const bin = path.resolve(process.argv[2] || "");
assert.ok(fs.existsSync(bin), `usage: test-payload-swap.mjs <packaged app binary> (missing: ${bin})`);
const platform = cfg.platformKey();
assert.ok(platform, `no payload is published for ${process.platform}-${process.arch}`);
const resources = process.platform === "darwin" ? path.resolve(path.dirname(bin), "..", "Resources") : path.join(path.dirname(bin), "resources");
const seedTree = path.join(resources, "app-core");
assert.ok(fs.existsSync(path.join(seedTree, "main.js")), `the packaged app carries no payload seed at ${seedTree}`);
const asar = path.join(resources, "app.asar");
const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");

const V = JSON.parse(fs.readFileSync(path.join(ROOT, "desktop", "package.json"), "utf8")).version;
const [maj, min, pat] = V.split(".").map(Number);
const B1 = `${maj}.${min}.${pat + 1}`;
const B2 = `${maj}.${min}.${pat + 2}`;

const base = fs.mkdtempSync(path.join(os.tmpdir(), "zevet-payload-proof-"));
const srv = path.join(base, "srv");
const payloadRoot = path.join(base, "payload");
const userData = path.join(base, "user-data");
const requests = [];
const blobs = () => requests.filter((u) => u.startsWith("/p/b/")).length;

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keyId = Object.keys(PINNED_KEYS)[0];
const pubRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
const signEnv = { ZEVET_UPDATE_SIGNING_KEY: privateKey.export({ format: "pem", type: "pkcs8" }).replaceAll("\n", "|") };

function publish(build, edit) {
  const tree = path.join(base, `tree-${build}`);
  fs.cpSync(seedTree, tree, { recursive: true });
  edit(tree);
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "make-feed.mjs"), "payload", "--out", srv, "--tree", tree, "--build", build, "--channel", "canary"], { encoding: "utf8", windowsHide: true, env: { ...process.env, ...signEnv } });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  console.log(`published ${build} (seq ${cfg.seqOf(build)})`);
}

const server = http.createServer((req, res) => {
  requests.push(req.url);
  const file = path.join(srv, decodeURIComponent(req.url.split("?")[0]));
  if (!file.startsWith(srv) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void res.writeHead(404).end();
  res.writeHead(200, { "cache-control": "no-store" }).end(fs.readFileSync(file));
});

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const current = () => readJson(path.join(payloadRoot, "current.json"));

/** PIDs of everything this run launched, relaunches included: they all carry our unique user-data-dir. */
function ours() {
  try {
    if (process.platform === "win32") {
      const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${base.replaceAll("'", "''")}*' } | ForEach-Object { $_.ProcessId }`;
      return execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", windowsHide: true }).split(/\s+/).filter(Boolean).map(Number);
    }
    return execFileSync("pgrep", ["-f", base], { encoding: "utf8", windowsHide: true }).split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}
function killOurs() {
  for (const pid of ours()) {
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
}

async function waitFor(what, fn, ms = 120_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; current.json = ${JSON.stringify(current())}`);
    await delay(500);
  }
}

function dumpLogs() {
  console.log(`----- ${requests.length} requests: ${requests.join(" ")}
processes still ours: ${ours().join(",") || "none"}; current.json = ${JSON.stringify(current())}`);
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
  for (const f of walk(base).filter((f) => /zevet-boot.*\.log$|std(err|out)\.log$/.test(f))) {
    console.log(`----- ${f}\n${fs.readFileSync(f, "utf8").split("\n").slice(-40).join("\n")}`);
  }
}

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const asarBefore = sha(asar);

  publish(B1, (t) => fs.appendFileSync(path.join(t, "console-log.js"), `\n// payload ${B1}\n`));

  console.log("--- launch the packaged app on the seed ---");
  fs.mkdirSync(base, { recursive: true });
  const out = fs.openSync(path.join(base, "stdout.log"), "w");
  const err = fs.openSync(path.join(base, "stderr.log"), "w");
  const [cmd, ...pre] = /\.m?js$/.test(bin) ? [process.execPath, bin] : [bin]; // a .mjs "binary" is the harness self-check's fake app
  const child = spawn(cmd, [...pre, `--user-data-dir=${userData}`], {
    windowsHide: true,
    detached: true,
    stdio: ["ignore", out, err],
    env: {
      ...process.env,
      HOME: base,
      ZEVET_HOME: path.join(base, "zevet-home"),
      ZEVET_ALLOW_MULTI: "1",
      ZEVET_MASORA_URL: "http://127.0.0.1:1",
      ZEVET_PAYLOAD_ROOT: payloadRoot,
      ZEVET_PAYLOAD_CHANNEL: "canary",
      ZEVET_PAYLOAD_PULSE: `${origin}/p/zevet/canary/${platform}/pulse.json`,
      ZEVET_PAYLOAD_CHECK_MS: "3000",
      // The pulse is signed with a throwaway key: honoured because the URL is loopback (app-update.js loopbackProofKeys).
      ZEVET_APP_FEED_TRUSTED_KEY: `${keyId}:${pubRaw}`,
      // The installer updater points at nothing, so an installer landing here would be a bug in the proof itself.
      ZEVET_APP_FEED: `${origin}/zevet-latest.json`,
    },
  });
  child.unref();

  // The seed must be the version package.json says, or B1 is not newer than it and rightly never applies.
  const seedLine = await waitFor("the app's boot log", () => {
    try { return fs.readFileSync(path.join(userData, "logs", "zevet-boot.log"), "utf8").match(/running payload (\S+) \(seed\)/)?.[1]; } catch { return null; }
  }, 60_000);
  assert.equal(seedLine, V, `the packaged app was built at ${seedLine}, not package.json's ${V}: publish a payload newer than what it carries`);

  // ---- 1. B1 arrives, swaps, confirms --------------------------------------
  await waitFor(`${B1} to become current`, () => current()?.build === B1);
  console.log(`swapped to ${current().build} (trial: ${current().trial})`);
  await waitFor(`${B1} to be confirmed (window loaded + agent API answering)`, () => current()?.build === B1 && current().trial === false);
  assert.equal(blobs(), 1, `fetched ${blobs()} blobs for a one-file change`);
  assert.match(fs.readFileSync(path.join(payloadRoot, "versions", B1, "console-log.js"), "utf8"), new RegExp(`// payload ${B1.replaceAll(".", "\\.")}`));
  assert.ok(ours().length > 0, "the app is not running after the swap");
  console.log(`1 OK: ${B1} live and confirmed, ${blobs()} blob fetched of ${fs.readdirSync(seedTree).length}+ files`);

  // ---- 2. the shell was not touched ----------------------------------------
  assert.equal(sha(asar), asarBefore, "app.asar changed: the swap went through the installer path");
  assert.ok(!requests.some((u) => /\.(exe|dmg)$/.test(u)), "an installer was requested");
  assert.ok(!fs.existsSync(path.join(userData, "updates")) || fs.readdirSync(path.join(userData, "updates")).length === 0, "the installer updater downloaded something");
  console.log("2 OK: app.asar unchanged, no installer fetched");

  // ---- 3. a crashing payload reverts on the third strike --------------------
  const blobsBefore = blobs();
  publish(B2, (t) => {
    fs.appendFileSync(path.join(t, "console-log.js"), `\n// payload ${B1}\n`);
    fs.writeFileSync(path.join(t, "main.js"), `throw new Error("proof: a payload that crashes on boot");\n${fs.readFileSync(path.join(t, "main.js"), "utf8")}`);
  });
  await waitFor(`${B2} to be tried`, () => current()?.build === B2 || readJson(path.join(payloadRoot, "bad.json"))?.builds?.includes(B2));
  await waitFor(`${B2} to be reverted and marked bad`, () => current()?.build === B1 && readJson(path.join(payloadRoot, "bad.json"))?.builds?.includes(B2), 180_000);
  assert.equal(blobs() - blobsBefore, 1, "B2 changed one file (main.js) but more than one blob was fetched");
  await waitFor(`${B1} to be running again`, () => ours().length > 0);
  const requestsAtRevert = requests.length;
  await delay(10_000); // several pulse checks: a reverted build must not be re-applied
  assert.equal(current().build, B1, "the bad build was re-applied");
  assert.equal(blobs() - blobsBefore, 1, "a bad build was fetched again");
  assert.ok(requests.length > requestsAtRevert, "the app stopped checking the pulse");
  console.log(`3 OK: ${B2} crashed, reverted to ${B1}, marked bad, never re-applied`);
}

main()
  .then(() => console.log("PASS"))
  .catch((e) => {
    console.error(`FAIL: ${e && e.stack ? e.stack : e}`);
    dumpLogs();
    process.exitCode = 1;
  })
  .finally(async () => {
    killOurs();
    await new Promise((r) => server.close(r));
    fs.rmSync(base, { recursive: true, force: true });
  });
