// client/detect.mjs — which coding agents are on this machine, and are they
// signed in. Verified live against a real machine 2026-09-27 (Andrew's): it
// correctly found Claude Code on PATH, OpenCode on PATH, and Codex NOT on PATH
// but installed under the Windows build-hash directory
// (%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe) — exactly the case this
// file exists to catch, and until now had zero automated coverage.
//
// detect.mjs reads HOME/PATH/env once at module load (`const HOME =
// os.homedir()`), so each scenario runs in its own subprocess via runScript
// rather than re-importing the module with a monkeypatched env.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { runScript, tempDir } from "./helpers.mjs";

const WIN = process.platform === "win32";
const EXT = WIN ? ".exe" : "";

function writeExe(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "#!/bin/sh\necho fake\n");
  if (!WIN) chmodSync(filePath, 0o755);
}

async function detect(env) {
  // No HOME override needed when nothing under it matters for a given
  // scenario, but always pin one so a real dev machine's own ~/.claude etc.
  // never leaks into the assertion.
  const { code, stdout } = await runScript("detect.mjs", { env });
  assert.equal(code, 0, `detect.mjs exited ${code}, stderr would show why`);
  return stdout;
}

test("nothing installed anywhere reports nothing to watch", async (t) => {
  const dir = tempDir("zevet-detect-empty-");
  t.after(() => dir.cleanup());
  const emptyBin = path.join(dir.dir, "empty-bin");
  mkdirSync(emptyBin);
  const out = await detect({
    HOME: dir.dir, USERPROFILE: dir.dir, PATH: emptyBin,
    APPDATA: path.join(dir.dir, "Roaming"), LOCALAPPDATA: path.join(dir.dir, "Local"),
  });
  assert.match(out, /Claude Code\s+not installed/);
  assert.match(out, /Codex\s+not installed/);
  assert.match(out, /OpenCode\s+not installed/);
  assert.match(out, /zevet has nothing to watch here/);
});

test("Claude Code on PATH with a credentials file reads as signed in", async (t) => {
  const dir = tempDir("zevet-detect-claude-");
  t.after(() => dir.cleanup());
  const bin = path.join(dir.dir, "bin");
  writeExe(path.join(bin, `claude${EXT}`));
  mkdirSync(path.join(dir.dir, ".claude"), { recursive: true });
  writeFileSync(path.join(dir.dir, ".claude", ".credentials.json"), "{}");
  const out = await detect({
    HOME: dir.dir, USERPROFILE: dir.dir, PATH: bin,
    APPDATA: path.join(dir.dir, "Roaming"), LOCALAPPDATA: path.join(dir.dir, "Local"),
  });
  assert.match(out, /Claude Code\s+installed, signed in/);
});

test("Codex installed only under the Windows build-hash directory, not on PATH, still detected", { skip: !WIN }, async (t) => {
  // This is the exact shape that found Codex on Andrew's real machine
  // (%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe) -- mutation check:
  // renaming AGENTS[1].globPaths' dir or leaf without updating this test
  // would fail it.
  const dir = tempDir("zevet-detect-codex-");
  t.after(() => dir.cleanup());
  const emptyBin = path.join(dir.dir, "empty-bin");
  mkdirSync(emptyBin);
  const local = path.join(dir.dir, "Local");
  const hashDir = path.join(local, "OpenAI", "Codex", "bin", "somebuildhash");
  writeExe(path.join(hashDir, "codex.exe"));
  mkdirSync(path.join(dir.dir, ".codex"), { recursive: true });
  writeFileSync(path.join(dir.dir, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  const out = await detect({
    HOME: dir.dir, USERPROFILE: dir.dir, PATH: emptyBin,
    APPDATA: path.join(dir.dir, "Roaming"), LOCALAPPDATA: local,
  });
  assert.match(out, /Codex\s+installed, signed in/);
  assert.match(out, /known install location/);
});

test("OpenCode signed in via OPENROUTER_API_KEY env, with no auth file", async (t) => {
  const dir = tempDir("zevet-detect-opencode-");
  t.after(() => dir.cleanup());
  const bin = path.join(dir.dir, "bin");
  writeExe(path.join(bin, WIN ? "opencode.cmd" : "opencode"));
  const out = await detect({
    HOME: dir.dir, USERPROFILE: dir.dir, PATH: bin,
    APPDATA: path.join(dir.dir, "Roaming"), LOCALAPPDATA: path.join(dir.dir, "Local"),
    OPENROUTER_API_KEY: "sk-or-fake-for-this-test-only",
  });
  assert.match(out, /OpenCode\s+installed, signed in/);
});
