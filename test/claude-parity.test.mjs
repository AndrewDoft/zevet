// A Claude Code session inside Zevet's agent console, at parity with the terminal:
// token streaming, tool approval, moving a terminal session in, launch flags and
// honest slash commands. Each block pins one of those; the two that touch a real
// claude (permission prompts, slash commands) were also measured against
// claude 2.1.284 — see the comments in desktop/agent-console.js and
// board/src/lib/slash.mjs.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ac = require(path.join(ROOT, "desktop", "agent-console.js"));
const { createConsoleLog } = require(path.join(ROOT, "desktop", "console-log.js"));
const { ruleKey, createGrants } = require(path.join(ROOT, "desktop", "permit-grants.js"));
const { start: startAskServer } = require(path.join(ROOT, "desktop", "ask-server.js"));
const sessions = require(path.join(ROOT, "desktop", "agent-sessions.js"));
const { draftAfter, overlayDraft } = await import("../board/src/lib/chat-stream.mjs");
const { commandsFor } = await import("../board/src/lib/slash.mjs");

const delta = (text, extra = {}) => ({
  type: "stream_event",
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  ...extra,
});

describe("1. token streaming", () => {
  test("the console asks claude for partial messages", () => {
    assert.ok(ac.invocationFor("claude").includes("--include-partial-messages"));
    // codex and opencode have no such flag and must not be handed it.
    assert.ok(!ac.invocationFor("codex").includes("--include-partial-messages"));
    assert.ok(!ac.invocationFor("opencode").includes("--include-partial-messages"));
  });

  test("text deltas grow a draft and the complete block replaces it", () => {
    let d = "";
    d = draftAfter(d, delta("Hel"));
    d = draftAfter(d, delta("lo"));
    assert.equal(d, "Hello");
    // Non-text deltas (thinking, tool json) say nothing to show.
    assert.equal(draftAfter(d, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "x" } } }), "Hello");
    assert.equal(draftAfter(d, { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }), "");
    assert.equal(draftAfter(d, { type: "result" }), "");
    assert.equal(draftAfter(d, { type: "conversation_reset" }), "");
  });

  test("a subagent's tokens are not this thread's", () => {
    assert.equal(draftAfter("", delta("secret", { parent_tool_use_id: "toolu_1" })), "");
    assert.equal(draftAfter("mine", { type: "assistant", parent_tool_use_id: "toolu_1", message: { content: [] } }), "mine");
  });

  test("the draft is laid over the open message, or opens its own", () => {
    const open = { messages: [{ id: "a", role: "assistant", content: [{ type: "tool-call" }] }], openIndex: 0 };
    assert.deepEqual(overlayDraft(open, "hi")[0].content, [{ type: "tool-call" }, { type: "text", text: "hi" }]);
    assert.equal(overlayDraft(open, ""), open.messages);
    const closed = { messages: [], openIndex: -1 };
    assert.equal(overlayDraft(closed, "hi")[0].id, "zv-draft");
  });

  test("a reload does not replay hundreds of deltas, but still stamps them for the live board", () => {
    const log = createConsoleLog();
    log.open("a", { agent: "claude" });
    const live = log.record("a", { type: "agent", payload: delta("x") });
    assert.equal(live.seq, 1);
    log.record("a", { type: "agent", payload: { type: "assistant" } });
    assert.deepEqual(log.snapshot().consoles[0].events.map((e) => e.payload.type), ["assistant"]);
  });
});

describe("2. tool approval", () => {
  test("a grant is exactly what was approved", () => {
    const g = createGrants();
    assert.equal(g.allows("r1", "Bash", { command: "npm test" }), false);
    assert.ok(g.grant("r1", "Bash", { command: "npm test" }));
    assert.equal(g.allows("r1", "Bash", { command: "npm test" }), true);
    // Not a prefix, not another run, not a similar command.
    assert.equal(g.allows("r1", "Bash", { command: "npm test && rm -rf ." }), false);
    assert.equal(g.allows("r2", "Bash", { command: "npm test" }), false);
    assert.equal(g.allows("r1", "PowerShell", { command: "npm test" }), false);
  });

  test("other tools are granted by name, WebFetch by host, huge commands never", () => {
    const g = createGrants();
    g.grant("r", "Edit", { file_path: "a.txt" });
    assert.equal(g.allows("r", "Edit", { file_path: "b.txt" }), true);
    assert.equal(g.allows("r", "Write", {}), false);
    g.grant("r", "WebFetch", { url: "https://example.com/a" });
    assert.equal(g.allows("r", "WebFetch", { url: "https://example.com/b" }), true);
    assert.equal(g.allows("r", "WebFetch", { url: "https://evil.example.org/" }), false);
    assert.equal(ruleKey("Bash", { command: "x".repeat(5000) }), null);
    assert.equal(g.grant("r", "Bash", { command: "x".repeat(5000) }), false);
    g.forget("r");
    assert.equal(g.allows("r", "Edit", {}), false);
  });

  // The real MCP server over a real pipe, against the real loopback gate.
  function mcp(t, env) {
    const child = spawn(process.execPath, [path.join(ROOT, "desktop", "zevet-mcp.js")], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    t.after(() => child.kill());
    let buf = "";
    const waiters = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) waiters.shift()?.(JSON.parse(line));
      }
    });
    return (name, args) =>
      new Promise((resolve) => {
        waiters.push(resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
      });
  }
  const decision = (res) => JSON.parse(res.result.content[0].text);

  test("Claude's own tool reaches the gate with its name, input and run, tagged as Claude's", async (t) => {
    let seen;
    const gate = await startAskServer({ onPermit: async (req) => ((seen = req), { ok: true }) });
    t.after(gate.close);
    const call = mcp(t, { ZEVET_MCP_URL: gate.url, ZEVET_MCP_TOKEN: gate.token, ZEVET_MCP_RUN: "run-7" });
    const big = "y".repeat(200_000); // a Write of a big file must not exceed the gate's body cap
    const res = await call("permission_prompt", { tool_name: "Write", input: { file_path: "a.txt", content: big } });
    assert.equal(seen.via, "claude");
    assert.equal(seen.run, "run-7");
    assert.equal(seen.tool, "Write");
    assert.equal(seen.arguments.file_path, "a.txt");
    assert.ok(seen.arguments.content.length < 5000, "the card is shown a clipped copy");
    // ...while the allow reply carries the ORIGINAL input back to claude.
    assert.equal(decision(res).behavior, "allow");
    assert.equal(decision(res).updatedInput.content.length, 200_000);
  });

  test("zevet's own tools are not asked about twice (they gate themselves)", async (t) => {
    const gate = await startAskServer({ onPermit: async () => assert.fail("the gate must not be asked") });
    t.after(gate.close);
    const call = mcp(t, { ZEVET_MCP_URL: gate.url, ZEVET_MCP_TOKEN: gate.token });
    for (const tool of ["mcp__zevet__ask_user", "mcp__zevet__click"]) {
      const res = await call("permission_prompt", { tool_name: tool, input: { x: 1 } });
      assert.equal(decision(res).behavior, "allow");
    }
    // A look-alike that is not one of ours still goes to the gate (and is denied here).
    const other = await call("permission_prompt", { tool_name: "mcp__zevet__rm_rf", input: {} });
    assert.equal(decision(other).behavior, "deny");
  });

  test("main.js wires it: every posture but skip-permissions gets the gate, answers carry `always`", () => {
    const main = readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8");
    assert.match(main, /const gate = mode !== "dangerous";/);
    assert.match(main, /if \(\(computerUse \|\| gate\) && fs\.existsSync\(MCP_SERVER\)\)/);
    assert.match(main, /permissionTool: "mcp__zevet__permission_prompt"/);
    assert.match(main, /permitGrants\.allows\(run, request\.tool, request\.arguments\)/);
    assert.match(main, /always: Boolean\(arg && arg\.always\)/);
    // The computer tools are only listed when the env says so; the setting alone never did that.
    assert.match(main, /ZEVET_MCP_COMPUTER: computerUse \? "1" : "0"/);
  });
});

describe("3. continuing a terminal session", () => {
  function withHome(fn) {
    const home = mkdtempSync(path.join(os.tmpdir(), "zevet-cwd-"));
    const was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = process.env.USERPROFILE = home;
    try {
      return fn(home);
    } finally {
      process.env.HOME = was.HOME;
      process.env.USERPROFILE = was.USERPROFILE;
      rmSync(home, { recursive: true, force: true });
    }
  }

  test("cwdOf reads the folder from the session's own transcript", () =>
    withHome((home) => {
      const dir = path.join(home, ".claude", "projects", "C--dev-elsewhere");
      mkdirSync(dir, { recursive: true });
      const cwd = path.resolve(home, "not-a-workspace");
      writeFileSync(path.join(dir, "abc-123.jsonl"), JSON.stringify({ type: "user", cwd, message: { role: "user", content: "hi" } }) + "\n");
      assert.equal(sessions.cwdOf("claude", "abc-123"), cwd);
      assert.equal(sessions.cwdOf("claude", "nope"), null);
      assert.equal(sessions.cwdOf("claude", "../abc-123"), null);
    }));

  test("resumeAgent takes that folder only when it IS the session's, and keeps the workspace rule otherwise", () => {
    const main = readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8");
    const body = main.slice(main.indexOf('bridge.handle("local:resumeAgent"'), main.indexOf('bridge.handle("local:sendToAgent"'));
    assert.match(body, /let dir = knownRoot\(cwd\);/);
    assert.match(body, /agentSessions\.cwdOf\(String\(agent \|\| ""\), resumeFrom\.trim\(\)\)/);
    assert.match(body, /path\.resolve\(own\) === path\.resolve\(cwd\)/);
    assert.match(body, /if \(!dir\) return \{ ok: false, error: "not an opened workspace" \}/);
  });

  test("the sessions list offers Continue in Zevet only to sessions that are not SDK-started", () => {
    const ui = readFileSync(path.join(ROOT, "board", "src", "components", "sessions.tsx"), "utf8");
    assert.match(ui, /s\.surface !== "sdk" && Boolean\(resumeIdForSession\(s\)\)/);
    assert.match(ui, /Continue in Zevet/);
    assert.match(ui, /<ContinueInZevet s=\{s\} \/>/);
  });
});

describe("4. flags", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zevet-adddir-"));
  const dir2 = path.join(dir, "two");
  mkdirSync(dir2);

  test("--add-dir is repeated, --effort is one of claude's levels, --continue only without a session", () => {
    const argv = ac.invocationFor("claude", { addDirs: [dir, dir2], effort: "xhigh", continueLatest: true });
    const at = argv.indexOf("--add-dir");
    assert.deepEqual(argv.slice(at, at + 4), ["--add-dir", dir, "--add-dir", dir2]);
    assert.equal(argv[argv.indexOf("--effort") + 1], "xhigh");
    assert.ok(argv.includes("--continue"));
    // A named session wins: --continue would fight --resume.
    const resumed = ac.invocationFor("claude", { resumeFrom: "s1", continueLatest: true });
    assert.ok(resumed.includes("--resume") && !resumed.includes("--continue"));
    // Nothing asked, nothing added.
    const plain = ac.invocationFor("claude", {});
    for (const f of ["--add-dir", "--effort", "--continue"]) assert.ok(!plain.includes(f), f);
  });

  test("the renderer's values are re-checked before they reach argv", () => {
    const got = ac.extrasFrom({ addDirs: [dir, ".", path.join(dir, "missing"), dir, 5], effort: "turbo", continueLatest: "yes" });
    assert.deepEqual(got, { addDirs: [dir] });
    assert.deepEqual(ac.extrasFrom({ effort: "max", continueLatest: true }), { effort: "max", continueLatest: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test("continue-latest starts in the folder, and only for claude", () => {
    const main = readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8");
    assert.match(main, /opts\.continueLatest === true && String\(agent \|\| ""\) === "claude"/);
    assert.match(main, /\.\.\.\(String\(agent \|\| ""\) === "claude" \? agentConsole\.extrasFrom\(opts\) : \{\}\)/);
    const board = readFileSync(path.join(ROOT, "board", "src", "lib", "board.ts"), "utf8");
    assert.match(board, /\.\.\.\(claude && st\.launchEffort \? \{ effort: st\.launchEffort \} : \{\}\)/);
  });
});

describe("5. slash commands", () => {
  const names = (announced) => commandsFor("claude", announced).map((c) => c.name);

  test("commands that answer 'not available' headless are not offered", () => {
    const shown = names(["compact", "fast", "focus", "agents", "__remote-workflow", "workflow-launch-exec", "usage"]);
    for (const n of ["fast", "focus", "agents", "__remote-workflow", "workflow-launch-exec"]) {
      assert.ok(!shown.includes(n), `${n} should be hidden`);
    }
    assert.ok(shown.includes("compact") && shown.includes("usage"));
    // The fallback list (before the first init line) is filtered the same way.
    assert.ok(!names(undefined).includes("fast"));
  });

  test("unverified and costly commands are offered, and say so", () => {
    const by = Object.fromEntries(commandsFor("claude", ["insights", "ultrareview", "compact"]).map((c) => [c.name, c.description]));
    assert.match(by.insights, /\$1\.9/);
    assert.match(by.ultrareview, /Not verified/);
    assert.doesNotMatch(by.compact, /Not verified/);
  });
});
