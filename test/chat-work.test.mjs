// Chat + Work: a chat that can do work in a folder, run on any provider the
// desktop drives, beside the team in the rail.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { tempDir, ROOT } from "./helpers.mjs";

const home = tempDir("zevet-chatwork-");
process.env.ZEVET_HOME = home.dir;
const work = tempDir("zevet-chatwork-folder-");
const other = tempDir("zevet-chatwork-other-");

const require = createRequire(import.meta.url);
const chats = require(path.join(ROOT, "desktop", "chat.js"));
const cli = require(path.join(ROOT, "desktop", "chat-cli.js"));
const { createClaudeCli } = require(path.join(ROOT, "desktop", "chat-claude.js"));
const lib = (f) => import(pathToFileURL(path.join(ROOT, "board", "src", "lib", f)).href);
const stream = await lib("chat-stream.mjs");
const { teammateTurns } = await lib("roster.mjs");
const { readMode, writeMode } = await lib("mode.mjs");
const src = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");

/** A startConsole that records argv, cwd and what was written. */
function fake() {
  const calls = [];
  const startConsole = (opts) => {
    const call = { agent: opts.agent, cwd: opts.cwd, args: opts.args, writes: [], emit: opts.onEvent };
    calls.push(call);
    return { ok: true, send: (t) => (call.writes.push(t), { ok: true }), stop: () => ({ ok: true }) };
  };
  return { calls, startConsole };
}

describe("a folder makes a chat do work", () => {
  test("claude keeps its tools and gets the work prompt only with a folder", () => {
    const plain = chats.chatArgs({ sessionId: "s", started: false });
    const doing = chats.chatArgs({ sessionId: "s", started: false, work: true });
    assert.ok(plain.includes("--tools"), "plain chat: tools off");
    assert.ok(!doing.includes("--tools"), "work: claude's own tools");
    assert.equal(doing[doing.indexOf("--append-system-prompt") + 1], chats.WORK_PROMPT);
    assert.equal(plain[plain.indexOf("--append-system-prompt") + 1], chats.SYSTEM_PROMPT);
    for (const a of doing) assert.ok(!/["&|<>^%!]/.test(a), "nothing cmd.exe would re-parse");
  });

  test("claude runs IN the folder, and a new folder is a new session", () => {
    const c = chats.create("andrew", work.dir);
    assert.equal(chats.read(c.id).folder, work.dir);
    const f = fake();
    const p = createClaudeCli({ startConsole: f.startConsole });
    p.open({ chat: chats.read(c.id), folder: work.dir, onEvent() {} });
    assert.equal(f.calls[0].cwd, work.dir);
    assert.ok(!f.calls[0].args.includes("--tools"));
    f.calls[0].emit({ type: "agent", payload: { type: "system", subtype: "init" } });
    p.open({ chat: chats.read(c.id), folder: work.dir, onEvent() {} });
    assert.ok(f.calls[1].args.includes("--resume"), "same folder resumes");
    p.open({ chat: chats.read(c.id), folder: other.dir, onEvent() {} });
    assert.ok(f.calls[2].args.includes("--session-id"), "another folder cannot resume it: fresh session, history replayed");
    chats.remove(c.id);
  });

  test("setFolder attaches and detaches; the summary carries it", () => {
    const c = chats.create("andrew");
    assert.equal(chats.list().find((x) => x.id === c.id).folder, undefined);
    assert.equal(chats.setFolder(c.id, work.dir).folder, work.dir);
    assert.equal(chats.list().find((x) => x.id === c.id).folder, work.dir);
    assert.equal(chats.setFolder(c.id, "").folder, undefined);
    chats.remove(c.id);
  });
});

describe("codex and opencode run a chat through Code's own invocation", () => {
  test("no folder: the most restrictive posture, in the chat's neutral folder", () => {
    const c = chats.create("andrew");
    const f = fake();
    cli.createCli({ agent: "codex", id: "codex-cli", startConsole: f.startConsole })
      .open({ chat: chats.read(c.id), model: "gpt-5.5", mode: "dangerous", onEvent() {} });
    const { args, cwd } = f.calls[0];
    assert.deepEqual(args.slice(0, 1), ["exec"]);
    assert.ok(args.join(" ").includes("--sandbox read-only"), "plain chat stays read-only whatever the posture");
    assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.equal(args[args.indexOf("-m") + 1], "gpt-5.5");
    assert.equal(cwd, chats.dirOf(c.id));
    chats.remove(c.id);
  });

  test("with a folder: the chosen posture, in that folder; the model reaches argv", () => {
    const c = chats.create("andrew", work.dir);
    const f = fake();
    cli.createCli({ agent: "opencode", id: "opencode-cli", startConsole: f.startConsole })
      .open({ chat: chats.read(c.id), model: "opencode/big-pickle", mode: "auto", folder: work.dir, onEvent() {} });
    const { args, cwd } = f.calls[0];
    assert.deepEqual(args.slice(0, 3), ["run", "--format", "json"]);
    assert.ok(args.includes("--auto"));
    assert.equal(args[args.indexOf("-m") + 1], "opencode/big-pickle");
    assert.equal(cwd, work.dir);
    assert.equal(args[args.indexOf("--dir") + 1], work.dir, "opencode is told the folder, not left to $PWD");
    chats.remove(c.id);
  });

  test("codex auto is --approve-for-me alone: it exits 2 beside --sandbox", () => {
    const { modeFlags } = require(path.join(ROOT, "desktop", "agent-console.js"));
    assert.deepEqual(modeFlags("codex", "auto").flags, ["--approve-for-me"]);
  });

  test("codex resume gets its posture as -c keys: the flags exit 2 on resume", () => {
    const { invocationFor } = require(path.join(ROOT, "desktop", "agent-console.js"));
    for (const mode of ["plan", "ask", "auto"]) {
      const a = invocationFor("codex", { model: "m", mode, resumeFrom: "T" });
      assert.deepEqual(a.slice(0, 3), ["exec", "resume", "T"]);
      assert.ok(!a.includes("--sandbox") && !a.includes("--approve-for-me"), mode);
      assert.ok(a.some((x) => x.startsWith("sandbox_mode=")), mode);
    }
    assert.deepEqual(
      invocationFor("codex", { mode: "plan", resumeFrom: "T" }).filter((x) => x.startsWith("sandbox_mode=")),
      ["sandbox_mode=read-only"],
    );
    assert.ok(!invocationFor("codex", { mode: "auto" }).some((x) => x.startsWith("sandbox_mode=")), "a first turn keeps the flags");
  });

  test("the CLI's session id is kept and the next turn resumes it; history replays once", () => {
    const c = chats.create("andrew", work.dir);
    const f = fake();
    const p = cli.createCli({ agent: "codex", id: "codex-cli", startConsole: f.startConsole });
    const prior = [{ role: "user", author: "a", text: "hi" }, { role: "assistant", author: "assistant", text: "yo" }];
    const one = p.open({ chat: chats.read(c.id), mode: "auto", folder: work.dir, onEvent() {} });
    one.send("do it", { prior });
    assert.match(f.calls[0].writes[0], /<prior-conversation>[\s\S]*<instructions>|<instructions>[\s\S]*<prior-conversation>/);
    f.calls[0].emit({ type: "agent", payload: { type: "thread.started", thread_id: "T-123" } });
    p.open({ chat: chats.read(c.id), mode: "auto", folder: work.dir, onEvent() {} }).send("more", { prior });
    assert.deepEqual(f.calls[1].args.slice(0, 3), ["exec", "resume", "T-123"]);
    assert.equal(f.calls[1].writes[0], "more", "resumed: no replay");
    // Another folder cannot resume it.
    p.open({ chat: chats.read(c.id), mode: "auto", folder: other.dir, onEvent() {} });
    assert.ok(!f.calls[2].args.includes("resume"));
    chats.remove(c.id);
  });

  test("replies and session ids are read off each CLI's own events", () => {
    assert.equal(cli.replyOf("codex", { type: "item.completed", item: { type: "agent_message", text: "hello" } }), "hello");
    assert.equal(cli.replyOf("codex", { type: "item.started", item: { type: "agent_message", text: "he" } }), "");
    assert.equal(cli.replyOf("opencode", { type: "text", part: { type: "text", text: "hi" } }), "hi");
    assert.equal(cli.replyOf("opencode", { type: "step_start" }), "");
    assert.equal(cli.sessionIdOf("opencode", { type: "text", sessionID: "ses_1" }), "ses_1");
    assert.equal(cli.sessionIdOf("codex", { type: "thread.started", thread_id: "T" }), "T");
  });
});

describe("the board reads each provider's stream with that provider's vocabulary", () => {
  const run = (agent, events) => {
    let t = stream.sendUser(stream.emptyChatThread(), "go", "m", agent);
    for (const payload of events) t = stream.chatEvent(t, { type: "agent", payload });
    return stream.chatEvent(t, { type: "exit", code: 0 });
  };
  const partsOf = (t) => t.transcript.messages.at(-1).content;

  test("codex: a command shows as a tool call beside the reply, and the exit ends the turn", () => {
    const t = run("codex", [
      { type: "item.started", item: { id: "c1", type: "command_execution", command: "ls" } },
      { type: "item.completed", item: { id: "c1", type: "command_execution", command: "ls", aggregated_output: "a.txt", status: "completed" } },
      { type: "item.completed", item: { type: "agent_message", text: "Done." } },
    ]);
    const parts = partsOf(t);
    assert.ok(parts.some((p) => p.type === "tool-call" && p.toolName === "Bash"));
    assert.ok(parts.some((p) => p.type === "text" && p.text === "Done."));
    assert.equal(t.busy, false);
  });

  test("opencode: a tool_use and its text", () => {
    const t = run("opencode", [
      { type: "tool_use", part: { type: "tool", id: "t1", tool: "read", state: { status: "completed", input: { filePath: "a" }, output: "x" } } },
      { type: "text", part: { type: "text", text: "Read it." } },
    ]);
    assert.ok(partsOf(t).some((p) => p.type === "tool-call"));
    assert.ok(partsOf(t).some((p) => p.type === "text" && p.text === "Read it."));
  });

  test("the same codex payload is dropped when read as claude: the agent tag is what selects", () => {
    const t = run("claude", [{ type: "item.completed", item: { type: "agent_message", text: "Done." } }]);
    assert.ok(!partsOf(t).some((p) => p.type === "text" && p.text === "Done."));
  });
});

describe("the mode switch", () => {
  test("a stored 'chat' is Chat + Work; nothing else is", () => {
    const m = new Map();
    const st = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
    st.setItem("zevet.mode", "chat");
    assert.equal(readMode(st, true), "chat");
    writeMode(st, "chat");
    assert.equal(m.get("zevet.mode"), "chat", "the stored id does not change");
  });

  test("the label is exactly Chat + Work, beside Code", () => {
    assert.match(src("board", "src", "components", "chatmode.tsx"), /m === "code" \? "Code" : "Chat \+ Work"/);
  });
});

describe("the rail is Code's rail", () => {
  test("Chat + Work mounts PeoplePane, not a second team list", () => {
    const s = src("board", "src", "components", "chatmode.tsx");
    assert.match(s, /<PeoplePane\s+threads=/);
    assert.match(src("board", "src", "components", "people.tsx"), /threads \? threads\(hue\)/);
  });

  test("a teammate's work is their prompts and tool calls, in order", () => {
    const ev = [
      { actor: "kai", kind: "prompt", detail: "fix it", ts: 1 },
      { actor: "sam", kind: "prompt", detail: "other", ts: 2 },
      { actor: "kai", kind: "tool", tool: "Edit", target: "a.js", ts: 3 },
      { actor: "kai", kind: "turn_end", ts: 4 },
      { actor: "kai", kind: "prompt", detail: "again", ts: 5 },
    ];
    const t = teammateTurns(ev, "kai");
    assert.equal(t.length, 2);
    assert.equal(t[0].prompt.detail, "fix it");
    assert.deepEqual(t[0].tools.map((e) => e.tool), ["Edit"]);
    assert.equal(t[0].ended, true);
    assert.equal(t[1].ended, false);
  });

  test("a teammate opens read-only: no composer while one is in view", () => {
    assert.match(src("board", "src", "components", "chatmode.tsx"), /hidden=\{Boolean\(viewActor\)\}/);
  });
});

describe("every provider is offered", () => {
  test("Chat lists all three CLIs and Gemini; a missing one is a Connect chip, not a missing group", () => {
    const c = src("board", "src", "components", "composercontrols.tsx");
    assert.match(c, /CHAT_AGENTS as readonly string\[\]\)\.includes\(a\.name\)/);
    assert.match(c, /name: "gemini", ok: false/);
    const m = src("board", "src", "components", "model-choice.tsx");
    assert.match(m, /data-slot="connect-chip"/);
    assert.match(m, /disabled: Boolean\(resetAt\) \|\| !a\.ok/);
  });

  test("the pick drives the run: the store sends the agent and model, not a claude-only fallback", () => {
    const s = src("board", "src", "lib", "chat.ts");
    assert.match(s, /chatSend\(chatId, text, \{ agent, model: launchModel/);
    assert.ok(!/launchAgent === "claude" \? picked/.test(s));
  });

  test("desktop chooses the provider by the agent it was sent", () => {
    const m = src("desktop", "main.js");
    assert.match(m, /chatProviders\[opts\.agent\]/);
    assert.match(m, /codex: createChatCli\(/);
    assert.match(m, /opencode: createChatCli\(/);
  });
});
