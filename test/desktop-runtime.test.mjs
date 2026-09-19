import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { tempDir } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { preparePath, clientFile, installerPath } = require("../desktop/runtime.js");

test("Finder PATH recovers the login shell's Node selection without importing credentials", async () => {
  const env = { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh", ZEVET_SECRET: "unchanged" };
  let launch;
  await preparePath({ platform: "darwin", env, home: "/Users/Person Name", execFileImpl(file, args, options, done) {
    launch = { file, args, options };
    done(null, "profile banner\n\0/Users/Person Name/.nvm/versions/node/v22/bin:/usr/bin::.:relative/bin\n\0logout banner\n");
  } });
  assert.equal(launch.file, "/bin/zsh");
  assert.equal(launch.args[0], "-ilc");
  assert.ok(launch.options.timeout > 0);
  assert.equal(launch.options.cwd, "/Users/Person Name");
  assert.deepEqual(env.PATH.split(":").slice(0, 3), ["/Users/Person Name/.nvm/versions/node/v22/bin", "/usr/bin", "/bin"]);
  assert.ok(env.PATH.includes("/opt/homebrew/bin"));
  assert.ok(env.PATH.includes("/Users/Person Name/.local/bin"));
  assert.ok(!env.PATH.split(":").some((p) => !p.startsWith("/")));
  assert.equal(env.ZEVET_SECRET, "unchanged");
  assert.deepEqual(Object.keys(env).sort(), ["PATH", "SHELL", "ZEVET_SECRET"]);
});

test("broken and noisy login shells retain the Homebrew fallback", async () => {
  for (const failure of ["throw", "error", "noise"]) {
    const env = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    await preparePath({ platform: "darwin", env, home: "/Users/test", execFileImpl(_file, _args, _options, done) {
      if (failure === "throw") throw new Error("cannot start shell");
      done(failure === "error" ? new Error("profile failed") : null, "a banner, not PATH");
    } });
    assert.ok(env.PATH.split(":").includes("/opt/homebrew/bin"));
    assert.ok(!env.PATH.includes("banner"));
  }
});

test("a shell waiting for input cannot stall startup or later replace PATH", async () => {
  const env = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
  let lateCallback;
  let killed = false;
  await preparePath({ platform: "darwin", env, home: "/Users/test", timeoutMs: 20,
    execFileImpl(_file, _args, _options, done) {
      lateCallback = done;
      return { kill(signal) { killed = signal === "SIGKILL"; } };
    } });
  assert.equal(killed, true);
  const fallback = env.PATH;
  lateCallback(null, "\0/late/shell/path\0");
  assert.equal(env.PATH, fallback);
});

test("Windows and Linux keep their existing environment", async () => {
  for (const platform of ["win32", "linux"]) {
    const env = { PATH: "the original path" };
    await preparePath({ platform, env, execFileImpl() { assert.fail("must not start a login shell"); } });
    assert.equal(env.PATH, "the original path");
  }
});

test("a real macOS login shell enables an npm-style env-node executable", { skip: process.platform !== "darwin" }, async (t) => {
  const fixture = tempDir("zevet-shell-");
  t.after(fixture.cleanup);
  const bin = path.join(fixture.dir, "Node with spaces", "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, path.join(bin, "node"));
  writeFileSync(path.join(fixture.dir, ".zshrc"), `export PATH=${JSON.stringify(bin)}:$PATH\nprintf 'profile banner\\n'\n`);
  const agent = path.join(bin, "claude");
  writeFileSync(agent, '#!/usr/bin/env node\nconsole.log("agent started");\n', { mode: 0o755 });
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/zsh", ZDOTDIR: fixture.dir };
  assert.throws(() => execFileSync(agent, [], { env, stdio: "pipe" }), "Finder PATH should reproduce env: node: No such file or directory");
  await preparePath({ platform: "darwin", env, home: fixture.dir });
  assert.equal(execFileSync(agent, [], { env, encoding: "utf8" }).trim(), "agent started");
});

test("a clean packaged install stages a complete client with a stable hook path", (t) => {
  const fixture = tempDir("zevet-bundle-");
  t.after(fixture.cleanup);
  const resourcesPath = path.join(fixture.dir, "mounted image", "zevet.app", "Contents", "Resources");
  const sourceDir = path.join(resourcesPath, "client");
  const clientDir = path.join(fixture.dir, "home", ".zevet", "client");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(sourceDir, "install.mjs"), "import { value } from './detect.mjs'; console.log(value);\n");
  writeFileSync(path.join(sourceDir, "detect.mjs"), "export const value = 'bundled client';\n");
  writeFileSync(path.join(sourceDir, "hook.mjs"), "// hook\n");
  writeFileSync(path.join(sourceDir, "not-client.txt"), "not copied");
  const options = { clientDir, resourcesPath, desktopDir: path.join(resourcesPath, "app.asar") };
  assert.equal(clientFile("detect.mjs", options), path.join(sourceDir, "detect.mjs"));
  const installer = installerPath(options);
  assert.equal(installer, path.join(clientDir, "install.mjs"));
  assert.deepEqual(readdirSync(clientDir).sort(), ["detect.mjs", "hook.mjs", "install.mjs"]);
  rmSync(resourcesPath, { recursive: true }); // The disk image has been ejected.
  assert.equal(execFileSync(process.execPath, [installer], { encoding: "utf8" }).trim(), "bundled client");
  writeFileSync(path.join(clientDir, "hook.mjs"), "// newer hub update\n");
  assert.equal(installerPath(options), installer);
  assert.equal(readFileSync(path.join(clientDir, "hook.mjs"), "utf8"), "// newer hub update\n");
  assert.equal(clientFile("detect.mjs", options), path.join(clientDir, "detect.mjs"));
});

test("a missing bundled client is reported and a checkout can bootstrap one", (t) => {
  const fixture = tempDir("zevet-checkout-");
  t.after(fixture.cleanup);
  const options = { clientDir: path.join(fixture.dir, "installed"), resourcesPath: path.join(fixture.dir, "missing"), desktopDir: path.join(fixture.dir, "desktop") };
  assert.equal(installerPath(options), null);
  mkdirSync(path.join(fixture.dir, "client"));
  writeFileSync(path.join(fixture.dir, "client", "install.mjs"), "// checkout client\n");
  assert.equal(installerPath(options), path.join(options.clientDir, "install.mjs"));
});
