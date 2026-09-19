// Run the built artifact, using only temporary application and user data.
// This is an integrity/runtime gate, not a claim of Apple notarization or a
// substitute for trying onboarding with a real teammate.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "desktop/package.json"), "utf8"));
const dmg = path.resolve(process.argv[2] || path.join(root, "desktop/out", `zevet-${pkg.version}-macos-arm64.dmg`));
assert.equal(process.platform, "darwin", "the macOS artifact must be tested on macOS");
assert.equal(process.arch, "arm64", "the macOS artifact must be tested natively on Apple Silicon");
assert.ok(fs.existsSync(dmg), `missing disk image: ${dmg}`);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "zevet-macos-smoke-"));
const mount = path.join(temp, "volume");
let mounted = false;
let appProcess;
let log = "";
const run = (program, args, options = {}) => execFileSync(program, args, { encoding: "utf8", timeout: 60_000, ...options });

function nativeFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...nativeFiles(name));
    else if (entry.isFile()) {
      const fd = fs.openSync(name, "r");
      const header = Buffer.alloc(4);
      fs.readSync(fd, header, 0, 4, 0);
      fs.closeSync(fd);
      if (["cffaedfe", "cefaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(header.toString("hex"))) files.push(name);
    }
  }
  return files;
}

try {
  fs.mkdirSync(mount);
  run("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-mountpoint", mount]);
  mounted = true;
  const apps = fs.readdirSync(mount).filter((name) => name.endsWith(".app"));
  assert.equal(apps.length, 1, "the image must contain exactly one app");
  assert.equal(fs.readlinkSync(path.join(mount, "Applications")), "/Applications", "the DMG must offer the Applications install destination");
  const app = path.join(temp, apps[0]);
  run("ditto", [path.join(mount, apps[0]), app]);
  run("hdiutil", ["detach", mount]);
  mounted = false;

  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  console.log("Final bundle signature: valid (trust/notarization is separate)");
  if (process.env.ZEVET_EXPECT_SIGNED === "1") {
    run("spctl", ["--assess", "--type", "execute", "--verbose", app]);
    console.log("Publisher-signed build: Gatekeeper accepted");
  }
  const binaries = nativeFiles(app);
  assert.ok(binaries.length > 5, "Electron and its native dependencies must be present");
  for (const binary of binaries) {
    const architectures = run("lipo", ["-archs", binary]).trim().split(/\s+/);
    assert.ok(architectures.includes("arm64"), `${path.relative(app, binary)} has no arm64 code: ${architectures}`);
  }
  console.log(`Native architecture: arm64 in all ${binaries.length} Mach-O files`);

  const bin = path.join(app, "Contents/MacOS/zevet");
  const resources = path.join(app, "Contents/Resources");
  const home = path.join(temp, "home");
  fs.mkdirSync(home);
  const env = {
    ...process.env,
    SHELL: "/bin/zsh",
    ZDOTDIR: home,
    ZEVET_ALLOW_MULTI: "1",
    ZEVET_HOME: path.join(home, ".zevet"),
    // Prevent a smoke test from contacting the public update service.
    ZEVET_APP_FEED: "http://127.0.0.1:1/zevet-latest.json",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const probe = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const { createRequire } = require('node:module');
    const resources = process.argv[1];
    const req = createRequire(path.join(resources, 'app.asar/package.json'));
    assert.equal(process.arch, 'arm64');
    assert.equal(req('./package.json').version, process.argv[2]);
    for (const file of JSON.parse(process.argv[3])) fs.accessSync(path.join(resources, 'app.asar', file));
    const transformers = req('@huggingface/transformers');
    const ort = req('onnxruntime-node');
    assert.equal(typeof transformers.pipeline, 'function');
    assert.equal(typeof ort.InferenceSession.create, 'function');
    const secret = require(path.join(resources, 'client/secret.mjs'));
    assert.equal(typeof secret.deriveAuthToken, 'function');
    fs.accessSync(path.join(resources, 'client/install.mjs'));
    console.log('Packaged Node', process.version, process.arch, ': app files, client, Transformers and ONNX Runtime loaded');
  `;
  const appFiles = pkg.build.files.filter((file) => !file.includes("*") && !file.startsWith("!"));
  console.log(run(bin, ["-e", probe, resources, pkg.version, JSON.stringify(appFiles)], {
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
  }).trim());

  appProcess = spawn(bin, [`--user-data-dir=${path.join(temp, "user-data")}`], { env, stdio: ["ignore", "pipe", "pipe"] });
  appProcess.stdout.on("data", (data) => { log += data; });
  appProcess.stderr.on("data", (data) => { log += data; });
  let launchError;
  appProcess.on("error", (error) => { launchError = error; });
  await delay(12_000);
  assert.ifError(launchError);
  assert.equal(appProcess.exitCode, null, `app exited early (${appProcess.exitCode}):\n${log}`);
  assert.equal(appProcess.signalCode, null, `app was killed (${appProcess.signalCode}):\n${log}`);
  console.log("App remained running for 12 seconds with its normal Chromium sandbox");
  if (log.trim()) console.log(log.trim());
} finally {
  if (appProcess && appProcess.exitCode === null && appProcess.signalCode === null) {
    appProcess.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => appProcess.once("exit", resolve)), delay(3000)]);
    if (appProcess.exitCode === null && appProcess.signalCode === null) appProcess.kill("SIGKILL");
  }
  if (mounted) run("hdiutil", ["detach", mount]);
  fs.rmSync(temp, { recursive: true, force: true });
}
