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
import os from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const sessionsFile = path.join(ROOT, "board", "src", "lib", "sessions.mjs");
const { codexItem, sessionEvents, sessionTranscript, sessionBlurb, sessionLabel, sessionMatches, sessionProject, sessionWhere } =
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
    assert.equal(sessionLabel({ id: "abc" }), "Session");
    assert.equal(sessionLabel({ title: "x".repeat(200) }).length, 72);
  });

  test("the label strips the harness envelope a recorded prompt arrives in", () => {
    // Measured in ~/.claude/projects on 2026-09-21: a session started with a
    // slash command records the caveat block as the first user message, and
    // the rail titled whole sessions "<local-command-caveat>Caveat: Th…".
    const caveat = [
      "<local-command-caveat>Caveat: The messages below were generated by the user " +
        "while running a local command.</local-command-caveat>",
      "<command-name>/loop</command-name>",
      "keep the tests green",
    ].join("\n\n");
    assert.equal(sessionLabel({ prompt: caveat }), "keep the tests green");
    // The CLI's own title goes through the same peel — that is where claude
    // puts the caveat when it summarises the first turn.
    assert.equal(sessionLabel({ title: caveat }), "keep the tests green");
    // An attribute on the wrapper is still a wrapper.
    assert.equal(sessionLabel({ prompt: '<pasted_content id="7">junk</pasted_content>\nreal ask' }), "real ask");
    // A prompt that is ONLY an envelope means nobody typed anything, so the
    // label falls through to the id rather than reading our plumbing out loud.
    assert.equal(sessionLabel({ prompt: "<system-reminder>be nice</system-reminder>", id: "abc" }), "Session");
    // And a title that is all envelope does not take the prompt down with it.
    assert.equal(
      sessionLabel({ title: "<task-notification><task-id>b1</task-id></task-notification>", prompt: "ship it" }),
      "ship it",
    );
    // Ordinary prompts are untouched, including ones that merely mention a tag.
    assert.equal(sessionLabel({ prompt: "why does <div> collapse?" }), "why does <div> collapse?");
    // ...and one that OPENS with a plain HTML tag. Only hyphenated or
    // underscored names are treated as an envelope, so this is a question
    // about markup, not a wrapper.
    assert.equal(sessionLabel({ prompt: "<div> keeps collapsing" }), "<div> keeps collapsing");

    // A live prompt event carries a truncated `detail`, so the envelope that
    // wraps everything arrives with no closing tag at all. Measured on the
    // deployed board 2026-09-21 — this exact string was on the People rail.
    const cut =
      "<task-notification>\n<task-id>bkp0qq54x</task-id>\n" +
      "<tool-use-id>toolu_01Fe2jumHKv5</tool-use-id>\n<status>completed</status>\nrebuild the tree";
    assert.equal(sessionLabel({ prompt: cut }), "rebuild the tree");
    // With nothing human after the machine blocks, there is nothing to show.
    assert.equal(
      sessionLabel({ prompt: "<task-notification>\n<task-id>b1</task-id>", id: "zz" }),
      "Session",
    );
    // Cut INSIDE the envelope's own closing tag, which is what the rail
    // actually showed after the first truncation fix: "</task-notifi".
    assert.equal(
      sessionLabel({ prompt: "<task-notification>\n<task-id>b1</task-id>\n</task-notifi", id: "zz" }),
      "Session",
    );
    // But markup with words around it is somebody's question, not an envelope.
    assert.equal(
      sessionLabel({ prompt: "<task-notification>\n<task-id>b1</task-id>\nwhy is </div> here" }),
      "why is </div> here",
    );
  });

  test("the blurb is the CLI's own title, or the first sentence of the ask", () => {
    // The CLI's title (claude's `ai-title`, codex's `thread_name`) wins; until
    // one exists, the first sentence. A three-word cut titled twenty agents
    // started from "You are working in …" prompts identically.
    assert.equal(sessionBlurb({ title: "Zevet bugs" }), "Zevet bugs");
    assert.equal(
      sessionBlurb({ prompt: "You are working in a git worktree of zevet. Your branch is checked out." }),
      "You are working in a git worktree of zevet.",
    );
    assert.equal(sessionBlurb({ prompt: "Fix the rail\nthen the composer" }), "Fix the rail");
    // Not a sentence break: an abbreviation followed by lower case.
    assert.equal(sessionBlurb({ prompt: "Use e.g. the fixture. Then test." }), "Use e.g. the fixture.");
    // Same envelope peel the full label gets, and the same fallbacks.
    assert.equal(sessionBlurb({ title: "<task-notification><task-id>b1</task-id>", prompt: "ship it now please" }), "ship it now please");
    assert.equal(sessionBlurb({ id: "abc" }), "Session");
    // A wall of pasted text is bounded; the row's ellipsis does the fitting.
    assert.equal(sessionBlurb({ title: "x".repeat(200) }).length, 80);
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
  test("live() adopts claude's latest ai-title and codex's real context", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "zevet-live-"));
    const was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = process.env.USERPROFILE = home;
    try {
      const cdir = path.join(home, ".claude", "projects", "C--dev-zevet");
      mkdirSync(cdir, { recursive: true });
      const lines = (...o) => o.map((x) => `${JSON.stringify(x)}\n`).join("");
      writeFileSync(
        path.join(cdir, "abc-1.jsonl"),
        lines({ type: "user", message: { role: "user", content: "hi" } }, { type: "ai-title", aiTitle: "Old" }, { type: "ai-title", aiTitle: "Fix the rail" }),
      );
      assert.deepEqual(reader.live("claude", "abc-1"), { title: "Fix the rail", context: null, cached: null, output: null, window: null });
      assert.equal(reader.live("claude", "missing"), null);
      assert.equal(reader.live("claude", "../x"), null);

      // codex: the stream's `turn.completed` is a running total; the rollout's
      // last_token_usage is what the model was sent last.
      const xdir = path.join(home, ".codex", "sessions", "2026", "09", "22");
      mkdirSync(xdir, { recursive: true });
      const tok = (total, last) => ({
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: total }, last_token_usage: last, model_context_window: 258400 } },
      });
      writeFileSync(
        path.join(xdir, "rollout-2026-09-22T16-20-53-t-9.jsonl"),
        lines(tok(20943, { input_tokens: 20943, cached_input_tokens: 13184, output_tokens: 255 }), tok(354000, { input_tokens: 39685, cached_input_tokens: 27904, output_tokens: 112 })),
      );
      writeFileSync(path.join(home, ".codex", "session_index.jsonl"), lines({ id: "t-9", thread_name: "Meter fix" }));
      assert.deepEqual(reader.live("codex", "t-9"), { title: "Meter fix", context: 39685, cached: 27904, output: 112, window: 258400 });
    } finally {
      process.env.HOME = was.HOME;
      process.env.USERPROFILE = was.USERPROFILE;
      rmSync(home, { recursive: true, force: true });
    }
  });

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

  test("a subagent handle is one segment too, and `subagents` is never the caller's", () => {
    const slug = "C--dev-GitHub-zevet";
    const id = "e8605c44-7714-4c03-9ef2-6a1672e304da";
    const ok = reader._fileFor("claude", slug, id, "agent-a0e75d5ead52dc250");
    assert.notEqual(ok, null);
    // The path is BUILT, so the "subagents" directory cannot be redirected.
    assert.equal(String(ok).split(/[\\/]/).at(-2), "subagents");
    for (const child of ["../../x", "a/b", "..", "x\\y"]) {
      assert.equal(reader._fileFor("claude", slug, id, child), null, child);
      assert.equal(reader.read("claude", slug, id, child).ok, false, child);
    }
    // codex writes no per-subagent file; asking for one is a caller error.
    assert.equal(reader._fileFor("codex", "2026/09/21", "rollout-x", "agent-1"), null);
  });

  test("the project filter ignores case, because Windows does", () => {
    /* ⚠️ THIS IS THE BUG THIS TEST EXISTS FOR. Claude Code slugs the path it
       was given, and on Windows one directory is reached under more than one
       spelling — this machine's store holds both `C--dev-GitHub-zevet` and
       `C--dev-Github-zevet` for one repo. A case-sensitive compare showed 10
       of 45 sessions and looked exactly like a folder with fewer sessions. */
    const a = reader.list({ cwd: "C:/dev/GitHub/zevet" }).sessions.length;
    const b = reader.list({ cwd: "C:/dev/Github/zevet" }).sessions.length;
    assert.equal(a, b);
  });

  test("list answers on a machine with no session stores at all", () => {
    // Neither directory existing is not an error — it is a machine that has
    // never run either CLI, and the pane must render rather than throw.
    const r = reader.list({ cwd: "C:\\no\\such\\place\\at\\all" });
    assert.equal(r.ok, true);
    assert.equal(Array.isArray(r.sessions), true);
  });
});
