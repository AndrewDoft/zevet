// The client, under adversarial input.
//
// The hook makes one load-bearing promise: it cannot affect a Claude Code
// turn. That is worth more than any feature here, so most of this file is
// attempts to falsify it.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { startHub, runScript, state, tempDir, TOKEN, ROOT } from "./helpers.mjs";

/**
 * Every installer run in this file is fenced to throwaway HOMEs.
 *
 * Codex hooks live in $CODEX_HOME/config.toml -- the GLOBAL file -- because a
 * repo-local block never fires. That makes an unfenced installer run in a test
 * an edit to the developer's own ~/.codex/config.toml, which is exactly what
 * happened the first time this moved: the suite quietly wired the real Codex
 * install on this machine to a temp repo. A test may touch its fixtures and
 * nothing else.
 */
const SANDBOX_HOME = tempDir("zevet-testhome-");

/**
 * A stub `claude` on PATH, so the installer has something to wire.
 *
 * CI runners have no coding agent installed, so `install.mjs` correctly refused
 * with "found no agent to wire up here" and every installer test died on a
 * non-zero exit. That was invisible for this repo's whole life because the
 * suite had never actually run on CI -- it only ever ran on a laptop where both
 * agents happen to exist.
 *
 * Skipping these when no agent is present was the other option and it is worse:
 * the installer is the component most likely to break per-platform, and a
 * suite that quietly stops testing it on the only two platforms that matter is
 * not coverage (CLAUDE.md 9.9). detect.mjs identifies an agent by finding a
 * FILE of that name on PATH, so a file is all this needs to be.
 */
const FAKE_BIN = path.join(SANDBOX_HOME.dir, "bin");
mkdirSync(FAKE_BIN, { recursive: true });
for (const name of process.platform === "win32" ? ["claude.cmd"] : ["claude"]) {
  const f = path.join(FAKE_BIN, name);
  const body = process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n";
  writeFileSync(f, body);
  if (process.platform !== "win32") chmodSync(f, 0o755);
}

const SANDBOX = {
  ...process.env,
  PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH || ""}`,
  CODEX_HOME: path.join(SANDBOX_HOME.dir, "codex"),
  ZEVET_HOME: path.join(SANDBOX_HOME.dir, "zevet"),
};
after(() => SANDBOX_HOME.cleanup());

let hub;
let home;

before(async () => {
  hub = await startHub();
  home = tempDir("zevet-home-");
  // Stop the hook's detached update check from firing during the suite.
  writeFileSync(path.join(home.dir, "last-check"), String(Date.now()), "utf8");
});
after(async () => {
  await hub?.stop();
  home?.cleanup();
});

function hookEnv(extra = {}) {
  return {
    ZEVET_HUB: hub.base,
    ZEVET_TOKEN: TOKEN,
    ZEVET_ACTOR: "tester",
    ZEVET_HOME: home.dir,
    ZEVET_UPDATE_INTERVAL_MS: "86400000",
    ...extra,
  };
}

/** A throwaway git repo, so repo/branch detection has something real to read. */
function makeRepo(branch = "main") {
  const t = tempDir("zevet-repo-");
  const git = (...args) => execFileSync("git", args, { cwd: t.dir, stdio: "pipe" });
  git("init", "-q");
  git("checkout", "-q", "-b", branch);
  writeFileSync(path.join(t.dir, "app.js"), "export const a = 1;\n");
  mkdirSync(path.join(t.dir, "src"), { recursive: true });
  writeFileSync(path.join(t.dir, "src", "db.ts"), "export const b = 2;\n");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return t;
}

describe("the hook cannot affect a turn", () => {
  const payloads = {
    "a prompt": { hook_event_name: "UserPromptSubmit", prompt: "do the thing" },
    "a tool call": { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
    "a stop": { hook_event_name: "Stop" },
    "a post-tool event": { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
    "an unknown event": { hook_event_name: "SomethingNew", tool_name: "Bash" },
    "an event with no tool name": { hook_event_name: "PreToolUse" },
    "an empty object": {},
  };

  for (const [label, payload] of Object.entries(payloads)) {
    test(`writes nothing to stdout and exits 0 for ${label}`, async () => {
      const r = await runScript("hook.mjs", { stdin: JSON.stringify(payload), env: hookEnv() });
      assert.equal(r.stdout, "", `stdout must be empty, got ${JSON.stringify(r.stdout)}`);
      assert.equal(r.code, 0);
    });
  }

  test("writes nothing and exits 0 on unparseable stdin", async () => {
    const r = await runScript("hook.mjs", { stdin: "{{{not json", env: hookEnv() });
    assert.equal(r.stdout, "");
    assert.equal(r.code, 0);
  });

  test("writes nothing and exits 0 on empty stdin", async () => {
    const r = await runScript("hook.mjs", { stdin: "", env: hookEnv() });
    assert.equal(r.stdout, "");
    assert.equal(r.code, 0);
  });

  test("writes nothing and exits 0 when the hub is unreachable", async () => {
    const r = await runScript("hook.mjs", {
      stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }),
      env: hookEnv({ ZEVET_HUB: "http://127.0.0.1:1", ZEVET_TIMEOUT_MS: "300" }),
    });
    assert.equal(r.stdout, "", "still silent");
    assert.equal(r.code, 0);
    assert.match(r.stderr, /unaffected/, "says so on stderr, where it is harmless");
  });

  test("writes nothing and exits 0 when the hub rejects the token", async () => {
    const r = await runScript("hook.mjs", {
      stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a.js" } }),
      env: hookEnv({ ZEVET_TOKEN: "wrong-token-value-here" }),
    });
    assert.equal(r.stdout, "");
    assert.equal(r.code, 0);
  });

  test("returns promptly when the hub hangs", async () => {
    // A hub that accepts the connection and never answers is the worst case:
    // it cannot be distinguished from a slow one, so only the timeout saves us.
    const { createServer } = await import("node:http");
    const server = createServer(() => {}); // never responds
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
      const t0 = Date.now();
      const r = await runScript("hook.mjs", {
        stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }),
        env: hookEnv({ ZEVET_HUB: `http://127.0.0.1:${port}`, ZEVET_TIMEOUT_MS: "400" }),
      });
      const elapsed = Date.now() - t0;
      assert.equal(r.stdout, "");
      assert.equal(r.code, 0);
      assert.ok(elapsed < 5000, `took ${elapsed}ms; the timeout must bound this`);
    } finally {
      server.close();
    }
  });
});

describe("what the hook reports", () => {
  let repo;
  before(() => {
    repo = makeRepo("feature/invites");
  });
  after(() => repo.cleanup());

  async function send(payload, env = {}) {
    await runScript("hook.mjs", {
      stdin: JSON.stringify({ cwd: repo.dir, ...payload }),
      env: hookEnv(env),
      cwd: repo.dir,
    });
    const { body } = await state(hub.base);
    return body.events.at(-1);
  }

  test("reports file paths relative to the repo root", async () => {
    const abs = path.join(repo.dir, "src", "db.ts");
    const e = await send({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: abs } });
    assert.equal(e.target, "src/db.ts", "must not be an absolute path");
    assert.ok(!e.target.includes("\\"), "must use forward slashes on every platform");
  });

  test("a path outside the repo is reduced to its basename", async () => {
    // Publishing a teammate's home directory layout to the team is not ours to do.
    const outside = path.join(path.parse(repo.dir).root, "somewhere", "else", "secret.env");
    const e = await send({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: outside } });
    assert.equal(e.target, "secret.env");
  });

  test("reads the branch from .git/HEAD", async () => {
    const e = await send({ hook_event_name: "UserPromptSubmit", prompt: "hi" });
    assert.equal(e.branch, "feature/invites");
    assert.equal(e.repo, path.basename(repo.dir));
  });

  test("a detached HEAD reports a short sha, not a crash", async () => {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.dir }).toString().trim();
    execFileSync("git", ["checkout", "-q", "--detach", sha], { cwd: repo.dir, stdio: "pipe" });
    try {
      const e = await send({ hook_event_name: "UserPromptSubmit", prompt: "hi" });
      assert.equal(e.branch, sha.slice(0, 8));
    } finally {
      execFileSync("git", ["checkout", "-q", "feature/invites"], { cwd: repo.dir, stdio: "pipe" });
    }
  });

  test("PostToolUse sends nothing, so tools are not counted twice", async () => {
    const { body: before } = await state(hub.base);
    await runScript("hook.mjs", {
      stdin: JSON.stringify({
        cwd: repo.dir,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "app.js" },
      }),
      env: hookEnv(),
    });
    const { body: after } = await state(hub.base);
    assert.equal(after.events.length, before.events.length);
  });

  test("a Bash command becomes detail, never a file target", async () => {
    const e = await send({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /tmp/x && echo done" },
    });
    assert.equal(e.target, null);
    assert.match(e.detail, /rm -rf/);
  });

  test("config.json supplies settings when no env vars are set", async () => {
    const cfgHome = tempDir("zevet-cfg-");
    try {
      writeFileSync(
        path.join(cfgHome.dir, "config.json"),
        JSON.stringify({ hub: hub.base, token: TOKEN, actor: "from-config" }),
        "utf8",
      );
      writeFileSync(path.join(cfgHome.dir, "last-check"), String(Date.now()), "utf8");
      await runScript("hook.mjs", {
        stdin: JSON.stringify({ cwd: repo.dir, hook_event_name: "UserPromptSubmit", prompt: "hi" }),
        env: { ZEVET_HOME: cfgHome.dir, ZEVET_UPDATE_INTERVAL_MS: "86400000" },
      });
      const { body } = await state(hub.base);
      assert.equal(body.events.at(-1).actor, "from-config");
    } finally {
      cfgHome.cleanup();
    }
  });
});

describe("secrets never reach the hub", () => {
  // THIS TEST EXISTS BECAUSE THE FEATURE SHIPPED BROKEN AND SILENT. The
  // patterns were written through a heredoc that turned every `\b` into a
  // literal backspace character (0x08), so they matched nothing at all. The
  // suite was green, the code looked right in an editor — which strips those
  // bytes from the display — and a live Stripe key went to the hub verbatim.
  // Redaction that is not tested is decoration.
  let repo;
  before(() => {
    repo = makeRepo("main");
  });
  after(() => repo.cleanup());

  const cases = {
    "a stripe key": "export STRIPE_KEY=sk_live_51H8xQ2abcdefghijklmnop && deploy",
    "a github token": "curl -H 'x: ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345' https://api.github.com",
    "a bearer header": 'curl -H "Authorization: Bearer abc123def456ghi789jkl" https://x.test',
    "an anthropic key": "ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv npm start",
    "an aws key id": "aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE",
    "a password assignment": "psql 'password=hunter2correcthorse' -c 'select 1'",
  };

  for (const [label, command] of Object.entries(cases)) {
    test(`redacts ${label} from a shell command`, async () => {
      await runScript("hook.mjs", {
        stdin: JSON.stringify({
          cwd: repo.dir,
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
        }),
        env: hookEnv(),
      });
      const { body } = await state(hub.base);
      const sent = body.events.at(-1).detail;
      assert.match(sent, /\[redacted\]/, `nothing was redacted from: ${sent}`);
      // And the secret itself must be gone, not merely accompanied by a marker.
      const secret = command.match(/(sk_live_\S+|ghp_\S+|sk-ant-\S+|AKIA\w+|hunter2\S*|abc123def456ghi789jkl)/);
      if (secret) {
        assert.ok(!sent.includes(secret[1]), `the secret survived: ${sent}`);
      }
    });
  }

  test("redacts a secret pasted into a prompt", async () => {
    await runScript("hook.mjs", {
      stdin: JSON.stringify({
        cwd: repo.dir,
        hook_event_name: "UserPromptSubmit",
        prompt: "here is the key sk_live_51H8xQ2abcdefghijklmnop, use it to test billing",
      }),
      env: hookEnv(),
    });
    const { body } = await state(hub.base);
    const sent = body.events.at(-1).detail;
    assert.ok(!sent.includes("sk_live_51H8xQ2abcdefghijklmnop"), `the secret survived: ${sent}`);
  });

  test("ordinary commands are left alone", async () => {
    await runScript("hook.mjs", {
      stdin: JSON.stringify({
        cwd: repo.dir,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "pnpm test -- --watch=false" },
      }),
      env: hookEnv(),
    });
    const { body } = await state(hub.base);
    assert.equal(body.events.at(-1).detail, "pnpm test -- --watch=false");
  });

  test("ZEVET_DETAIL=brief keeps only the first word, and no prompt bodies", async () => {
    await runScript("hook.mjs", {
      stdin: JSON.stringify({
        cwd: repo.dir,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "psql postgres://user:pw@host/db -c 'select 1'" },
      }),
      env: hookEnv({ ZEVET_DETAIL: "brief" }),
    });
    let snap = await state(hub.base);
    assert.equal(snap.body.events.at(-1).detail, "psql");

    await runScript("hook.mjs", {
      stdin: JSON.stringify({ cwd: repo.dir, hook_event_name: "UserPromptSubmit", prompt: "something private" }),
      env: hookEnv({ ZEVET_DETAIL: "brief" }),
    });
    snap = await state(hub.base);
    assert.equal(snap.body.events.at(-1).detail, "");
  });
});

describe("the installer", () => {
  /**
   * A copy of the client in a directory that is NOT called "zevet".
   *
   * This matters more than it looks. The installer used to recognise its own
   * hooks by the path substring `zevet/client/hook.mjs`, which matches
   * `~/.zevet/client/hook.mjs` purely because `.zevet/` contains `zevet/`.
   * These tests ran from the repo — also called `zevet` — so they passed while
   * the installer stacked duplicates and `--remove` did nothing for anyone who
   * had unpacked a ZIP named `zevet-main` or set ZEVET_HOME elsewhere.
   *
   * A test whose result depends on the name of the directory it was checked
   * out into is not testing what it says it is.
   */
  function stagedClient() {
    const t = tempDir("somewhere-else-");
    const dest = path.join(t.dir, "tooling", "client");
    mkdirSync(dest, { recursive: true });
    // Every client file, not a hand-kept subset: install.mjs imports detect.mjs
    // and install-codex.mjs, and a staging list that drifts from the real one
    // fails as "module not found" rather than as the thing under test.
    for (const f of readdirSync(path.join(ROOT, "client")).filter((n) => n.endsWith(".mjs"))) {
      writeFileSync(path.join(dest, f), readFileSync(path.join(ROOT, "client", f)));
    }
    return { installer: path.join(dest, "install.mjs"), cleanup: t.cleanup };
  }

  function entriesPerEvent(file) {
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    const counts = {};
    for (const [evt, groups] of Object.entries(cfg.hooks || {})) {
      counts[evt] = groups.reduce((n, g) => n + (g.hooks || []).length, 0);
    }
    return counts;
  }

  test("installing three times leaves one entry per event, from any directory", async () => {
    const repo = tempDir("zevet-inst-");
    const staged = stagedClient();
    try {
      for (let i = 0; i < 3; i++) {
        execFileSync(process.execPath, [staged.installer, repo.dir], { stdio: "pipe", env: SANDBOX });
      }
      const counts = entriesPerEvent(path.join(repo.dir, ".claude", "settings.json"));
      for (const [evt, n] of Object.entries(counts)) assert.equal(n, 1, `${evt} had ${n}`);
      assert.ok(!("PostToolUse" in counts), "PostToolUse is not registered");
    } finally {
      staged.cleanup();
      repo.cleanup();
    }
  });

  test("--remove actually removes, from any directory", async () => {
    const repo = tempDir("zevet-rm-");
    const staged = stagedClient();
    try {
      execFileSync(process.execPath, [staged.installer, repo.dir], { stdio: "pipe", env: SANDBOX });
      execFileSync(process.execPath, [staged.installer, repo.dir, "--remove"], { stdio: "pipe", env: SANDBOX });
      const cfg = JSON.parse(readFileSync(path.join(repo.dir, ".claude", "settings.json"), "utf8"));
      assert.deepEqual(cfg.hooks, {}, `hooks should be empty, got ${JSON.stringify(cfg.hooks)}`);
    } finally {
      staged.cleanup();
      repo.cleanup();
    }
  });

  test("upgrading over a pre-flag install does not leave two copies", async () => {
    // Older versions wrote the command with no marker flag. If those are not
    // recognised, an upgrade silently doubles every event on the board.
    const repo = tempDir("zevet-upg-");
    const staged = stagedClient();
    try {
      const dir = path.join(repo.dir, ".claude");
      mkdirSync(dir, { recursive: true });
      const legacy = {
        hooks: {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [{ type: "command", command: '"C:\\Users\\kai\\.zevet\\client\\hook.mjs"', timeout: 10 }],
            },
          ],
        },
      };
      writeFileSync(path.join(dir, "settings.json"), JSON.stringify(legacy), "utf8");
      execFileSync(process.execPath, [staged.installer, repo.dir], { stdio: "pipe", env: SANDBOX });
      const counts = entriesPerEvent(path.join(dir, "settings.json"));
      assert.equal(counts.PreToolUse, 1, `PreToolUse had ${counts.PreToolUse}`);
    } finally {
      staged.cleanup();
      repo.cleanup();
    }
  });

  test("leaves somebody else's hooks alone", async () => {
    const repo = tempDir("zevet-inst2-");
    try {
      const dir = path.join(repo.dir, ".claude");
      mkdirSync(dir, { recursive: true });
      const theirs = {
        hooks: {
          PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "node their-hook.js" }] }],
          Notification: [{ hooks: [{ type: "command", command: "say hi" }] }],
        },
        someOtherSetting: { keepMe: true },
      };
      writeFileSync(path.join(dir, "settings.json"), JSON.stringify(theirs), "utf8");

      execFileSync(process.execPath, [path.join(ROOT, "client", "install.mjs"), repo.dir], { stdio: "pipe", env: SANDBOX });
      let cfg = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"));
      assert.ok(JSON.stringify(cfg.hooks.PreToolUse).includes("their-hook.js"), "their PreToolUse survived install");
      assert.ok(cfg.hooks.Notification, "their unrelated hook survived");
      assert.deepEqual(cfg.someOtherSetting, { keepMe: true }, "unrelated settings survived");

      execFileSync(process.execPath, [path.join(ROOT, "client", "install.mjs"), repo.dir, "--remove"], { stdio: "pipe", env: SANDBOX });
      cfg = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"));
      assert.ok(JSON.stringify(cfg.hooks.PreToolUse).includes("their-hook.js"), "their PreToolUse survived remove");
      assert.ok(!JSON.stringify(cfg.hooks).includes("zevet"), "ours is gone");
    } finally {
      repo.cleanup();
    }
  });

  test("the command it writes is runnable as written", async () => {
    const repo = tempDir("zevet-inst3-");
    try {
      execFileSync(process.execPath, [path.join(ROOT, "client", "install.mjs"), repo.dir], { stdio: "pipe", env: SANDBOX });
      const cfg = JSON.parse(readFileSync(path.join(repo.dir, ".claude", "settings.json"), "utf8"));
      const cmd = cfg.hooks.PreToolUse[0].hooks[0].command;
      // Quoted for a shell, not escaped for JSON: no doubled separators.
      assert.ok(!cmd.includes("\\\\"), `doubled backslashes in: ${cmd}`);
      // node, hook and repo — three quoted paths, six quote characters.
      assert.equal((cmd.match(/"/g) || []).length, 6, `expected three quoted paths: ${cmd}`);
      const hookPath = (cmd.match(/" "(.+?)" --zevet-hook\b/) || [])[1];
      assert.ok(hookPath, `command should carry the marker flag: ${cmd}`);
      assert.ok(existsSync(hookPath), `the command points at a file that exists: ${hookPath}`);
      // The repo is on the command line because Codex's hook payload has no
      // cwd; without it, every Codex event is attributed to whatever directory
      // the agent happened to be started from.
      assert.match(cmd, /--zevet-repo "/, `command should carry the repo: ${cmd}`);
      assert.match(cmd, /--zevet-agent claude-code\b/, `command should name the agent: ${cmd}`);
    } finally {
      repo.cleanup();
    }
  });

  test("the hook command never points at the app binary", async (t) => {
    // THE PACKAGED-BUILD BUG. `process.execPath` inside the desktop app is
    // zevet.exe, an Electron binary, and Claude Code does not set
    // ELECTRON_RUN_AS_NODE when it runs a hook. Measured against the real
    // build, the command it wrote booted Chromium: 2 bytes on stdout (rule 1
    // of the hook, broken) and a GUI window per tool call on any machine
    // without an instance already running.
    //
    // This can only be checked with a packaged build to hand, so it SKIPS
    // LOUDLY rather than passing vacuously when there isn't one. Running it
    // under plain node would assert that node is node, which proves nothing.
    const candidates = [
      path.join(ROOT, "desktop", "out", "win-unpacked", "zevet.exe"),
      path.join(ROOT, "desktop", "out", "mac-arm64", "zevet.app", "Contents", "MacOS", "zevet"),
      path.join(ROOT, "desktop", "out", "linux-unpacked", "zevet"),
    ];
    const appBinary = candidates.find((p) => existsSync(p));
    if (!appBinary) {
      t.skip("no packaged build in desktop/out — run `npm run dist` in desktop/ to cover this");
      return;
    }

    const repo = tempDir("zevet-pkg-");
    try {
      const installer = path.join(path.dirname(appBinary), "resources", "client", "install.mjs");
      const staged = existsSync(installer) ? installer : path.join(ROOT, "client", "install.mjs");
      execFileSync(appBinary, [staged, repo.dir], {
        stdio: "pipe",
        env: { ...SANDBOX, ELECTRON_RUN_AS_NODE: "1" },
      });
      const cfg = JSON.parse(readFileSync(path.join(repo.dir, ".claude", "settings.json"), "utf8"));
      const cmd = cfg.hooks.PreToolUse[0].hooks[0].command;
      const interp = (cmd.match(/^"([^"]+)"/) || [])[1] || "";
      assert.match(
        path.basename(interp).toLowerCase(),
        /^node(\.exe)?$/,
        `the hook must be run by node, not by ${interp}`,
      );
    } finally {
      repo.cleanup();
    }
  });

  test("refuses a settings file that is not valid JSON", async () => {
    const repo = tempDir("zevet-inst4-");
    try {
      mkdirSync(path.join(repo.dir, ".claude"), { recursive: true });
      writeFileSync(path.join(repo.dir, ".claude", "settings.json"), "{ this is not json", "utf8");
      assert.throws(() =>
        execFileSync(process.execPath, [path.join(ROOT, "client", "install.mjs"), repo.dir], { stdio: "pipe", env: SANDBOX }),
      );
      // and did not clobber it
      assert.equal(readFileSync(path.join(repo.dir, ".claude", "settings.json"), "utf8"), "{ this is not json");
    } finally {
      repo.cleanup();
    }
  });
});
