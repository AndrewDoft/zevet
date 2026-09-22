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
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { startHub, runScript, state, tempDir, TOKEN, ROOT } from "./helpers.mjs";
import { deriveAuthToken } from "../client/secret.mjs";

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
  // The installer otherwise spawns the real `codex app-server` on every run to
  // read hook hashes -- a very large binary, eight times over, which pushed the
  // suite past two minutes. The block it writes is tested directly instead.
  ZEVET_SKIP_CODEX_TRUST: "1",
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
    // Blanked, not omitted. resolveAuth lets a secret win over a token, so a
    // ZEVET_SECRET exported in whatever shell runs the suite would silently
    // replace the credential every test below assumes — on one developer's
    // machine and nowhere else, which is the worst shape a flake can have.
    ZEVET_SECRET: "",
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
    const root = repo.dir.replaceAll("\\", "/");
    assert.equal(e.checkout, createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex"));
    assert.ok(!e.target.includes("\\"), "must use forward slashes on every platform");
  });

  test("an agent in a zevet-made worktree reports the repo it was made from", async () => {
    // desktop/agent-worktree.js: a second agent in one repo works in a worktree
    // under the zevet home. Its activity is still that repo's, down to the
    // checkout, or the board drops it as another checkout's.
    const { createAgentWorktrees } = createRequire(import.meta.url)(path.join(ROOT, "desktop", "agent-worktree.js"));
    const wts = createAgentWorktrees({ home: home.dir });
    const wt = await wts.create(repo.dir);
    assert.ok(wt);
    try {
      const e = await send({ cwd: wt.dir, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: path.join(wt.dir, "src", "db.ts") } });
      assert.equal(e.repo, path.basename(repo.dir));
      assert.equal(e.branch, "feature/invites");
      assert.equal(e.target, "src/db.ts");
      const root = repo.dir.replaceAll("\\", "/");
      assert.equal(e.checkout, createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex"));
    } finally {
      await wts.release(wt);
    }
  });

  test("relative file paths resolve from the agent working directory", async () => {
    const e = await send({ cwd: path.join(repo.dir, "src"), hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "db.ts" } });
    assert.equal(e.target, "src/db.ts");
  });

  test("a path outside the repo has no file target", async () => {
    // Publishing a teammate's home directory layout to the team is not ours to do.
    const outside = path.join(path.parse(repo.dir).root, "somewhere", "else", "secret.env");
    const e = await send({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: outside } });
    assert.equal(e.target, null);
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
  function stagedClient(subdir = "tooling") {
    const t = tempDir("somewhere-else-");
    const dest = path.join(t.dir, subdir, "client");
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

  test("POSIX hook commands preserve shell metacharacters in client and repo paths", { skip: process.platform === "win32" }, async () => {
    const special = "literal $ZEVET_QUOTE_PROBE `printf expanded` ' \"";
    const base = tempDir("zevet-quoted-");
    const repoName = `${special} \\`;
    const repo = path.join(base.dir, repoName);
    const staged = stagedClient(special);
    mkdirSync(repo);
    mkdirSync(path.join(repo, ".git"));
    writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    try {
      execFileSync(process.execPath, [staged.installer, repo, "--agents=claude-code"], { stdio: "pipe", env: SANDBOX });
      const cfg = JSON.parse(readFileSync(path.join(repo, ".claude", "settings.json"), "utf8"));
      const command = cfg.hooks.PreToolUse[0].hooks[0].command;
      const before = (await state(hub.base)).body.events.length;
      const stdout = execFileSync("/bin/sh", ["-c", command], {
        input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a.js" } }),
        env: { ...SANDBOX, ...hookEnv(), ZEVET_QUOTE_PROBE: "expanded" },
        encoding: "utf8",
      });
      assert.equal(stdout, "", "the hook must stay silent even through a shell");
      const events = (await state(hub.base)).body.events;
      assert.equal(events.length, before + 1, "the literal client path should execute successfully");
      assert.equal(events.at(-1).repo, repoName, "the repo argument must reach the hook without shell expansion");
    } finally {
      staged.cleanup();
      base.cleanup();
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

/**
 * The master secret used by everything below.
 *
 * Fixed, so the derived token is a stable vector, and deliberately spelled out
 * of distinctive hex words: `stdout.includes(...)` failing on "beefca" is a
 * real leak rather than a collision with a port number or a temp path.
 */
const MASTER = "beefcafe0d15ea5e8badf00dfeedfacedead10ccabad1dea";
const DERIVED = deriveAuthToken(MASTER);

describe("what the client actually presents to the hub", () => {
  // THE FAILURE THIS IS AIMED AT. The hub is given a value it can compare and
  // nothing else; the master secret is also the document key and must never
  // cross the wire (client/secret.mjs). "We send the derived token" is easy to
  // believe and impossible to see -- both values are opaque hex in a header --
  // so it is pinned here from three directions rather than asserted once.
  let repo;
  before(() => {
    repo = makeRepo("main");
  });
  after(() => repo.cleanup());

  /** A config-file-only run: no ZEVET_TOKEN, no ZEVET_SECRET in the environment. */
  async function hookWithConfig(config, hubBase, extraEnv = {}) {
    const cfgHome = tempDir("zevet-auth-");
    try {
      writeFileSync(path.join(cfgHome.dir, "config.json"), JSON.stringify(config), "utf8");
      writeFileSync(path.join(cfgHome.dir, "last-check"), String(Date.now()), "utf8");
      return await runScript("hook.mjs", {
        stdin: JSON.stringify({ cwd: repo.dir, hook_event_name: "UserPromptSubmit", prompt: "hi" }),
        cwd: repo.dir,
        env: {
          ZEVET_HOME: cfgHome.dir,
          ZEVET_HUB: hubBase,
          ZEVET_TOKEN: "",
          ZEVET_SECRET: "",
          ZEVET_ACTOR: "",
          ZEVET_UPDATE_INTERVAL_MS: "86400000",
          ...extraEnv,
        },
      });
    } finally {
      cfgHome.cleanup();
    }
  }

  test("a hub holding the DERIVED token lets a secret-configured client in", async () => {
    const fresh = await startHub({ ZEVET_TOKEN: DERIVED });
    try {
      await hookWithConfig({ hub: fresh.base, secret: MASTER, actor: "derived-actor" }, fresh.base);
      const { body } = await state(fresh.base, DERIVED);
      assert.equal(body.events.at(-1)?.actor, "derived-actor", "the event never arrived");
    } finally {
      await fresh.stop();
    }
  });

  test("a hub holding the MASTER SECRET does not, because the secret is never sent", async () => {
    // The mirror of the test above, and the one that actually proves the
    // negative. A hub started with the secret itself would accept a client that
    // forwarded it verbatim -- which is precisely the regression to catch -- so
    // silence here is the evidence.
    const fresh = await startHub({ ZEVET_TOKEN: MASTER });
    try {
      const before = (await state(fresh.base, MASTER)).body.events.length;
      await hookWithConfig({ hub: fresh.base, secret: MASTER, actor: "leaky" }, fresh.base);
      const { body } = await state(fresh.base, MASTER);
      assert.equal(body.events.length, before, "the hub accepted something; the master secret went on the wire");
    } finally {
      await fresh.stop();
    }
  });

  test("the header bytes are the derived token, exactly", async () => {
    // The two tests above establish accept/reject against real hubs. This one
    // reads the header itself, because "the hub let it in" would also be true
    // of any other value the hub happened to hold, and the exact string is what
    // the hub operator has to paste into ZEVET_TOKEN.
    const { createServer } = await import("node:http");
    const seen = [];
    const server = createServer((req, res) => {
      seen.push(req.headers["x-zevet-token"]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await hookWithConfig({ hub: base, secret: MASTER, actor: "tester" }, base);
      assert.equal(seen.length, 1, `expected one request, got ${seen.length}`);
      assert.equal(seen[0], DERIVED);
      assert.notEqual(seen[0], MASTER);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test("a LEGACY token-only config still authenticates, unchanged", async () => {
    // The whole reason resolveAuth has a legacy branch: there are installs in
    // the field whose config holds the hub's ZEVET_TOKEN verbatim, and they must
    // keep working until the hub's env is cut over. A change that took the board
    // away from everyone the moment they updated would be worse than the bug.
    const fresh = await startHub();
    try {
      await hookWithConfig({ hub: fresh.base, token: TOKEN, actor: "legacy-actor" }, fresh.base);
      const { body } = await state(fresh.base, TOKEN);
      assert.equal(body.events.at(-1)?.actor, "legacy-actor");
    } finally {
      await fresh.stop();
    }
  });

  test("a malformed secret sends nothing, and the hook is still silent and still exits 0", async () => {
    // "The board is empty and nobody knows why", caught at the one place it can
    // be caught. resolveAuth refuses to fall back to anything, so there is no
    // credential at all -- and the hook's two rules survive that untouched.
    const fresh = await startHub();
    try {
      const before = (await state(fresh.base, TOKEN)).body.events.length;
      const r = await hookWithConfig({ hub: fresh.base, secret: "not hex at all", token: TOKEN }, fresh.base);
      assert.equal(r.stdout, "", "rule 1: nothing on stdout");
      assert.equal(r.code, 0, "rule 2: exit 0");
      assert.match(r.stderr, /master secret is unusable/i, "and it says so on stderr, where it is harmless");
      const { body } = await state(fresh.base, TOKEN);
      assert.equal(
        body.events.length,
        before,
        "a broken secret must NOT quietly fall back to the stale token sitting next to it",
      );
    } finally {
      await fresh.stop();
    }
  });
});

describe("the update channel ships what the client imports", () => {
  /** CLIENT_FILES out of hub/server.mjs, parsed the same way the closure test does. */
  function shippedFiles() {
    const server = readFileSync(path.join(ROOT, "hub", "server.mjs"), "utf8");
    const block = server.slice(
      server.indexOf("const CLIENT_FILES"),
      server.indexOf("];", server.indexOf("const CLIENT_FILES")),
    );
    return [...block.matchAll(/"([a-z0-9-]+\.mjs)"/g)].map((m) => m[1]);
  }

  test("secret.mjs and doc-crypto.mjs are on the list", () => {
    // Named explicitly rather than left to the closure test. The closure test
    // only fires once something IMPORTS a missing file, and doc-crypto.mjs is
    // not imported by anything shipped yet -- so it would have gone missing
    // silently until the editor landed and then broken on arrival.
    const shipped = shippedFiles();
    for (const name of ["secret.mjs", "doc-crypto.mjs"]) {
      assert.ok(shipped.includes(name), `${name} is not in CLIENT_FILES: ${shipped.join(", ")}`);
    }
  });

  test("the doctor's copy of the list agrees with the hub's", () => {
    // client/doctor.mjs keeps its own literal on purpose (see its comment: a
    // doctor that asks a broken install what it should contain cannot detect a
    // missing answer). Two literals is two things that can drift, and the
    // symptom of drift is a doctor that reports "all files present" about an
    // install the updater will never complete.
    const doctor = readFileSync(path.join(ROOT, "client", "doctor.mjs"), "utf8");
    const block = doctor.slice(
      doctor.indexOf("const CLIENT_FILES"),
      doctor.indexOf("];", doctor.indexOf("const CLIENT_FILES")),
    );
    const theirs = [...block.matchAll(/"([a-z0-9-]+\.mjs)"/g)].map((m) => m[1]);
    assert.deepEqual([...theirs].sort(), [...shippedFiles()].sort());
  });

  test("every file on the list exists on disk", () => {
    for (const name of shippedFiles()) {
      assert.ok(existsSync(path.join(ROOT, "client", name)), `CLIENT_FILES names ${name}, which is not in client/`);
    }
  });
});

describe("the setup scripts derive the same token the client does", () => {
  /**
   * THE POINT OF THIS WHOLE BLOCK. setup.ps1 and setup.sh cannot import
   * client/secret.mjs: they need the derived token in order to DOWNLOAD the
   * client, so at that moment there is either nothing on disk or a stale
   * pre-cutover copy. The derivation is therefore written out a second and a
   * third time, and two of the three can drift from the first without anything
   * failing until a teammate is locked out of a hub for reasons nobody can see.
   *
   * So: extract the inlined program from both scripts, prove they are the same
   * program, run it, and compare its answer with deriveAuthToken().
   */
  const START = "# zevet:derive:start";
  const END = "# zevet:derive:end";

  function inlinedProgram(file) {
    const src = readFileSync(path.join(ROOT, "dist", file), "utf8");
    const from = src.indexOf(START);
    const to = src.indexOf(END);
    assert.ok(from >= 0 && to > from, `${file} has no ${START} / ${END} markers`);
    const body = src.slice(from + START.length, to);
    const first = body.indexOf("'");
    const last = body.lastIndexOf("'");
    assert.ok(first >= 0 && last > first, `${file}: no single-quoted program between the markers`);
    return body.slice(first + 1, last);
  }

  /**
   * Run the shared program the way setup.sh does: `node -e PROG SECRET`.
   * The secret lands at process.argv[1].
   */
  const runInlined = (program, secret) =>
    execFileSync(process.execPath, ["-e", program, secret], { encoding: "utf8" }).trim();

  /**
   * Run the shared program the way setup.ps1 does: written to a file, then
   * `node prog.cjs SECRET`. The secret lands at process.argv[2], because
   * argv[1] is the script's own path.
   */
  function runAsFile(program, secret) {
    const dir = tempDir("zevet-derive-");
    try {
      const file = path.join(dir.dir, "derive.cjs");
      writeFileSync(file, program, "utf8");
      return execFileSync(process.execPath, [file, secret], { encoding: "utf8" }).trim();
    } finally {
      dir.cleanup();
    }
  }

  test("both scripts inline byte-identical derivation code", () => {
    assert.equal(inlinedProgram("setup.sh"), inlinedProgram("setup.ps1"));
  });

  test("the inlined derivation equals deriveAuthToken for a fixed secret", () => {
    assert.equal(runInlined(inlinedProgram("setup.sh"), MASTER), DERIVED);
    assert.equal(runInlined(inlinedProgram("setup.ps1"), MASTER), DERIVED);
  });

  test("it derives the same token whether it is run by -e or from a file", () => {
    // MEASURED, and the reason this test exists. One program, two delivery
    // mechanisms — setup.sh uses `node -e`, setup.ps1 must write it to a file
    // because PowerShell's native-argument parser eats the double quotes out of
    // a command line — and node numbers the arguments differently for the two:
    // `-e` puts the first user argument at argv[1], a file puts the SCRIPT PATH
    // there. Reading argv[1] therefore hashed the temp file's own path on
    // Windows, printed BAD, and told the person their perfectly good secret was
    // malformed. Nothing that reads either script could have caught that.
    for (const f of ["setup.sh", "setup.ps1"]) {
      const program = inlinedProgram(f);
      assert.equal(runInlined(program, MASTER), DERIVED, `${f} via -e`);
      assert.equal(runAsFile(program, MASTER), DERIVED, `${f} via a file`);
    }
  });

  test("it survives the ways a person will actually paste a secret", () => {
    // The same cases client/secret.mjs's normaliser is tested against. A setup
    // script stricter than the client would reject a secret the client would
    // have accepted, at the one moment the person has no other way to find out
    // what is wrong.
    const p = inlinedProgram("setup.sh");
    assert.equal(runInlined(p, `  ${MASTER.toUpperCase()}  `), DERIVED);
    assert.equal(runInlined(p, `${MASTER.slice(0, 24)}\n${MASTER.slice(24)}`), DERIVED);
  });

  test("a truncated or non-hex secret is refused rather than silently derived", () => {
    const p = inlinedProgram("setup.sh");
    for (const bad of [MASTER.slice(0, 40), "not hex at all", `${MASTER}a`, ""]) {
      assert.equal(runInlined(p, bad), "BAD", `${JSON.stringify(bad)} was accepted`);
    }
  });

  test("both scripts store the secret and never the derived token", () => {
    const sh = readFileSync(path.join(ROOT, "dist", "setup.sh"), "utf8");
    const ps = readFileSync(path.join(ROOT, "dist", "setup.ps1"), "utf8");
    assert.match(sh, /JSON\.stringify\(\{ hub, secret, actor \}/, "setup.sh must write { hub, secret, actor }");
    assert.match(
      ps,
      /@\{ hub = \$Hub; secret = \$Secret; actor = \$Name \}/,
      "setup.ps1 must write { hub, secret, actor }",
    );
    assert.ok(!/\{ hub, token, actor \}/.test(sh), "setup.sh still writes a raw token");
    assert.ok(!/token = \$Token;/.test(ps), "setup.ps1 still writes a raw token");
  });

  test("setup.ps1 does not hand the program to node on the command line", () => {
    // MEASURED, against a real hub, and the reason this test exists at all:
    // `& node -e '<program>' $Secret` runs, and PowerShell's native-argument
    // parser strips every double quote out of the program on the way to node.
    // node got `require(node:crypto)`, died with a SyntaxError, wrote nothing
    // to stdout, and setup carried on with an EMPTY token — which the hub
    // answered 401 to and the script reported as "could not reach the hub, or
    // the token was rejected". The credential was never derived; the message
    // blamed the network and the secret.
    //
    // This cannot be caught by running the script here (CI has no PowerShell,
    // and the suite must not depend on one), so what is asserted is the shape
    // that survives: the program is written to a file and node is pointed at
    // it. Escaping the quotes as \" would also work and would make setup.ps1's
    // copy of the program differ byte-for-byte from setup.sh's, which is
    // precisely the drift the first test in this block exists to stop.
    //
    // Scoped to the DERIVATION, not to the whole file: setup.ps1 also reads
    // config.json back with `node -e "..."`, and that one is fine — it is a
    // DOUBLE-quoted PowerShell string whose JavaScript uses single quotes, so
    // there are no double quotes for the parser to eat. A blunt file-wide
    // substring check would fail on a working line and, worse, invite somebody
    // to "fix" it.
    const ps = readFileSync(path.join(ROOT, "dist", "setup.ps1"), "utf8");
    const block = ps.slice(ps.indexOf(START), ps.indexOf("$headers"));
    const executable = block.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
    assert.ok(
      !executable.some((l) => l.includes("node -e")),
      "the derivation is passed to `node -e`; PowerShell's native-argument parser eats its quotes",
    );
    assert.match(ps, /Write-Utf8NoBom \$deriveFile \$deriveJs/, "the program must reach node through a file");
    assert.match(ps, /& node \$deriveFile \$Secret/);
  });

  test("both scripts treat an empty derivation result as a failure", () => {
    // The other half of the same bug. `$Token -eq "BAD"` was false for an empty
    // string, so the only check in the script waved the failure through.
    const sh = readFileSync(path.join(ROOT, "dist", "setup.sh"), "utf8");
    const ps = readFileSync(path.join(ROOT, "dist", "setup.ps1"), "utf8");
    assert.match(sh, /\[ -n "\$TOKEN" \] && \[ "\$TOKEN" != "BAD" \]/);
    assert.match(ps, /if \(-not \$Token -or \$Token -eq "BAD"\)/);
  });

  test("both scripts print the ZEVET_TOKEN line the hub operator needs", () => {
    // Without it the cutover cannot be completed by anyone: the hub compares
    // against a value only a machine holding the secret can compute.
    for (const f of ["setup.sh", "setup.ps1"]) {
      assert.match(readFileSync(path.join(ROOT, "dist", f), "utf8"), /ZEVET_TOKEN=/, `${f} never prints it`);
    }
  });

  test("setup.ps1 still writes config.json without a BOM", () => {
    // A regression fence, not a new claim. PowerShell 5.1 writes a UTF-8 BOM
    // with Set-Content, JSON.parse rejects a leading U+FEFF, and the result was
    // a Windows teammate who silently never appeared on the board while setup
    // printed "Done." Changing WHAT goes in the file must not change HOW.
    const ps = readFileSync(path.join(ROOT, "dist", "setup.ps1"), "utf8");
    assert.match(ps, /Write-Utf8NoBom \(Join-Path \$home_ "config\.json"\) \$cfg/);
    assert.match(ps, /New-Object System\.Text\.UTF8Encoding\(\$false\)/);
    // Comment lines are excluded deliberately: the file NAMES Set-Content in
    // the comment explaining why it must not be used, and a blunt substring
    // check would fail on the documentation of the very rule it enforces.
    const executable = ps.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
    assert.ok(
      !executable.some((l) => l.includes("Set-Content")),
      "Set-Content is how the BOM got in last time",
    );
  });
});
