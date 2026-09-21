// Session files on disk -> the same transcript a live console renders.
//
// zevet could only show agents it spawned. Most of the work is typed into a
// terminal or one of the desktop apps, and the only record of it is a JSONL
// file nobody opens. desktop/agent-sessions.js reads those files;
// board/src/lib/sessions.mjs turns them into transcript events. This runs both
// against FIXTURES SHAPED FROM REAL FILES on this machine (2026-09-21) —
// ~/.claude/projects and ~/.codex/sessions — not from documentation.
//
// What is pinned here, in order of how expensive it is to get wrong:
//
//  1. A `user` record with STRING content is a person; with ARRAY content it
//     is usually a tool result. Confusing the two puts tool output in the
//     transcript in the user's voice and detaches it from its call.
//  2. codex's rollout vocabulary is NOT its live one — PascalCase items,
//     `changes` as an object rather than an array, argv as an array. Each is a
//     silent wrong-render, not a crash.
//  3. Containment: the read handle comes from a renderer, so a slug or id that
//     is not a single path-safe segment must be refused rather than resolved.
//  4. Sidechains stay out: a subagent's turns are interleaved into the same
//     file and read as the conversation being asked something nobody typed.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const sessionsFile = path.join(ROOT, "board", "src", "lib", "sessions.mjs");
const { codexItem, sessionEvents, sessionTranscript, sessionLabel, sessionMatches, sessionProject, sessionWhere } =
  await import(pathToFileURL(sessionsFile).href);
const reader = require(path.join(ROOT, "desktop", "agent-sessions.js"));

const claude = (type, content, extra = {}) => ({
  source: "claude",
  type,
  uuid: "u1",
  timestamp: "2026-09-21T00:00:00.000Z",
  message: { role: type, content },
  ...extra,
});
const codex = (item) => ({ source: "codex", timestamp: "2026-09-21T00:00:00.000Z", item });

describe("claude session records", () => {
  test("a string prompt is the person, an array of tool results is not", () => {
    const events = sessionEvents([
      claude("user", "what does this do?"),
      claude("assistant", [{ type: "text", text: "reading it" }]),
      claude("user", [{ type: "tool_result", tool_use_id: "t1", content: "42" }]),
    ]);
    assert.deepEqual(
      events.map((e) => e.type),
      ["you", "agent", "agent"],
    );
    assert.equal(events[0].text, "what does this do?");
    // The tool result went back as a `user` PAYLOAD, which is the shape
    // transcript.mjs attaches to a call — not as a prompt.
    assert.equal(events[2].payload.type, "user");
    assert.equal(events[2].payload.message.content[0].type, "tool_result");
  });

  test("a tool call keeps its arguments and finds its result", () => {
    const state = sessionTranscript([
      claude("user", "read it"),
      claude("assistant", [
        { type: "text", text: "ok" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
      ]),
      claude("user", [{ type: "tool_result", tool_use_id: "t1", content: "contents" }]),
    ]);
    const call = state.messages
      .flatMap((m) => m.content)
      .find((p) => p.type === "tool-call");
    assert.equal(call.toolName, "Read");
    assert.equal(call.args.file_path, "a.ts");
    assert.equal(call.result, "contents");
  });

  test("a record carrying text AND a tool result keeps its order", () => {
    // The prompt OPENS A NEW TURN, so a result that came before it must be
    // emitted before it or it lands on the wrong turn.
    const events = sessionEvents([
      claude("user", [
        { type: "tool_result", tool_use_id: "t1", content: "done" },
        { type: "text", text: "thanks, now do the next one" },
      ]),
    ]);
    assert.deepEqual(
      events.map((e) => e.type),
      ["agent", "you"],
    );
  });

  test("an open turn is closed: a session on disk is not streaming", () => {
    const state = sessionTranscript([
      claude("user", "hi"),
      claude("assistant", [{ type: "text", text: "hello" }]),
    ]);
    assert.equal(state.openIndex, -1);
    assert.equal(state.running, false);
    const last = state.messages[state.messages.length - 1];
    assert.equal(last.status.type, "complete");
  });

  test("empty thinking produces no reasoning part", () => {
    // MEASURED: Claude Code persists the thinking SIGNATURE but not the text —
    // 925 of 925 thinking parts in a real session file were empty. A reader
    // that trusted the field would render 925 blank reasoning panels.
    const state = sessionTranscript([
      claude("assistant", [
        { type: "thinking", thinking: "" },
        { type: "text", text: "answer" },
      ]),
    ]);
    const kinds = state.messages.flatMap((m) => m.content).map((p) => p.type);
    assert.deepEqual(kinds, ["text"]);
  });
});

describe("codex rollout items", () => {
  test("UserMessage is a prompt, AgentMessage is prose", () => {
    const events = sessionEvents([
      codex({ type: "UserMessage", id: "i1", content: [{ type: "text", text: "go" }] }),
      codex({ type: "AgentMessage", id: "i2", content: [{ type: "Text", text: "done" }] }),
    ]);
    assert.equal(events[0].type, "you");
    assert.equal(events[0].text, "go");
    assert.equal(events[1].payload.item.type, "agent_message");
  });

  test("CommandExecution's argv array becomes a command line", () => {
    // ⚠️ `command` is an ARRAY here and a STRING in the live stream. Handed
    // over as an array the terminal card has nothing to print.
    const ev = codexItem({
      type: "CommandExecution",
      id: "exec-1",
      command: ["pwsh.exe", "-Command", "Get-Location"],
      aggregated_output: "C:\\",
      status: "completed",
    });
    assert.equal(ev.payload.item.command, "pwsh.exe -Command Get-Location");
    assert.equal(ev.payload.item.aggregated_output, "C:\\");
  });

  test("FileChange's object of changes becomes the array fromCodex reads", () => {
    const ev = codexItem({
      type: "FileChange",
      id: "exec-2",
      changes: { "src/a.ts": { type: "update", unified_diff: "@@ -1 +1 @@" } },
      status: "completed",
    });
    assert.equal(Array.isArray(ev.payload.item.changes), true);
    assert.equal(ev.payload.item.changes[0].path, "src/a.ts");
    assert.equal(ev.payload.item.changes[0].kind, "update");
    // And it reaches the card with a file path in its arguments. The source
    // has to be named: without it the events are read with claude's
    // vocabulary and every one renders as "[claude: item.completed]".
    const state = sessionTranscript(
      [codex({ type: "FileChange", id: "e", changes: { "src/a.ts": { type: "update" } } })],
      { source: "codex" },
    );
    const call = state.messages.flatMap((m) => m.content).find((p) => p.type === "tool-call");
    assert.equal(call.args.file_path, "src/a.ts");
  });

  test("Reasoning uses summary_text, and an unknown item is dropped", () => {
    const ev = codexItem({ type: "Reasoning", summary_text: ["**Checking it**"] });
    assert.equal(ev.payload.item.type, "reasoning");
    assert.equal(ev.payload.item.text, "**Checking it**");
    assert.equal(codexItem({ type: "SomethingNobodyHasShipped" }), null);
    assert.equal(codexItem(null), null);
  });

  test("a codex transcript renders as codex, not as claude", () => {
    const state = sessionTranscript(
      [codex({ type: "AgentMessage", content: [{ type: "Text", text: "hi" }] })],
      { source: "codex" },
    );
    assert.equal(state.messages[0].content[0].text, "hi");
  });
});

describe("row helpers", () => {
  test("the label prefers the CLI's own title, then the first prompt", () => {
    assert.equal(sessionLabel({ title: "Fix the parser", prompt: "p", id: "x" }), "Fix the parser");
    assert.equal(sessionLabel({ prompt: "make it faster", id: "x" }), "make it faster");
    assert.equal(sessionLabel({ id: "abc" }), "abc");
    assert.equal(sessionLabel({ title: "x".repeat(200) }).length, 72);
  });

  test("the project is the last segment, of a path or of a slug", () => {
    assert.equal(sessionProject({ cwd: "C:\\dev\\GitHub\\zevet" }), "zevet");
    assert.equal(sessionProject({ cwd: "C--dev-GitHub-zevet" }), "zevet");
    assert.equal(sessionProject({}), "");
  });

  test("where it was typed falls back to the raw origin, never to a guess", () => {
    assert.equal(sessionWhere({ surface: "desktop", origin: "Codex Desktop" }), "desktop");
    // A provenance string nobody has bucketed yet arrives as itself.
    assert.equal(sessionWhere({ surface: "", origin: "some-new-host" }), "some-new-host");
    assert.equal(sessionWhere({}), "");
  });

  test("every word of the filter has to match something", () => {
    const s = { title: "voice rename", cwd: "C:/dev/GitHub/zevet", surface: "desktop" };
    assert.equal(sessionMatches(s, "zevet voice"), true);
    assert.equal(sessionMatches(s, "desktop"), true);
    assert.equal(sessionMatches(s, "zevet parser"), false);
    assert.equal(sessionMatches(s, ""), true);
  });
});

describe("desktop reader", () => {
  test("a read handle that is not a path segment is refused", () => {
    // Containment by construction: these never reach the filesystem.
    for (const [slug, id] of [
      ["../../etc", "x"],
      ["ok", "../secret"],
      ["ok", "a/b"],
      ["ok\\b", "x"],
      ["", "x"],
      ["ok", ""],
    ]) {
      assert.equal(reader._fileFor("claude", slug, id), null, `${slug} ${id}`);
      assert.equal(reader.read("claude", slug, id).ok, false);
    }
    assert.notEqual(reader._fileFor("claude", "C--dev-GitHub-zevet", "abc-123"), null);
  });

  test("codex handles are dated directories and nothing else", () => {
    assert.notEqual(reader._fileFor("codex", "2026/09/21", "rollout-x"), null);
    assert.equal(reader._fileFor("codex", "2026/09", "rollout-x"), null);
    assert.equal(reader._fileFor("codex", "../../x/y/z", "rollout-x"), null);
    // A claude-shaped slug is not a codex one.
    assert.equal(reader._fileFor("codex", "C--dev-GitHub-zevet", "abc"), null);
  });

  test("list answers on a machine with no session stores at all", () => {
    // Neither directory existing is not an error — it is a machine that has
    // never run either CLI, and the pane must render rather than throw.
    const r = reader.list({ cwd: "C:\\no\\such\\place\\at\\all" });
    assert.equal(r.ok, true);
    assert.equal(Array.isArray(r.sessions), true);
  });
});
