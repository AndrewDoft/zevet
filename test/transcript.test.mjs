// Agent JSONL -> assistant-ui messages.
//
// The board used to flatten every structured agent event to a string before
// anything could render it, which is why the assistant-ui components that were
// in the tree had nothing to draw. board/src/lib/transcript.mjs keeps the
// structure; this runs that exact file, the way roster.test.mjs runs
// roster.mjs.
//
// What is pinned here: that a tool call keeps its name, arguments and result
// and that a result finds the call it belongs to; that streamed deltas
// concatenate instead of stacking; that reasoning stays separate from prose;
// that a message is copied rather than mutated, because assistant-ui memoises
// per message by reference; that CLI housekeeping never reaches the
// conversation; and that a failed run always ends in one plain sentence.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const {
  _resetIds,
  appendAgentPayload,
  appendUserText,
  assembleTranscript,
  closeTranscript,
  emptyTranscript,
  plainError,
} = await import(pathToFileURL(path.join(ROOT, "board", "src", "lib", "transcript.mjs")).href);
const { resetClock } = await import(pathToFileURL(path.join(ROOT, "board", "src", "lib", "model-limits.mjs")).href);

beforeEach(() => _resetIds());

const claude = (payload, state = emptyTranscript()) =>
  appendAgentPayload(state, payload, { agent: "claude" });

const text = (t) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }] } });
const toolUse = (id, name, input) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});
const toolResult = (id, content, isError) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
});

describe("shape", () => {
  test("an empty transcript has no messages and nothing open", () => {
    const s = emptyTranscript();
    assert.deepEqual(s.messages, []);
    assert.equal(s.openIndex, -1);
  });

  test("a prompt becomes a user message", () => {
    const s = appendUserText(emptyTranscript(), "run the tests");
    assert.equal(s.messages.length, 1);
    assert.equal(s.messages[0].role, "user");
    assert.deepEqual(s.messages[0].content, [{ type: "text", text: "run the tests" }]);
  });

  test("an empty prompt is not a message", () => {
    assert.equal(appendUserText(emptyTranscript(), "").messages.length, 0);
    assert.equal(appendUserText(emptyTranscript(), null).messages.length, 0);
  });

  test("assistant output opens one message and marks it running", () => {
    const s = claude(text("working on it"));
    assert.equal(s.messages.length, 1);
    assert.equal(s.messages[0].role, "assistant");
    assert.equal(s.messages[0].status.type, "running");
  });
});

describe("streaming", () => {
  test("consecutive text concatenates into one part", () => {
    let s = claude(text("Hello"));
    s = claude(text(", world"), s);
    assert.equal(s.messages.length, 1);
    assert.deepEqual(s.messages[0].content, [{ type: "text", text: "Hello, world" }]);
  });

  test("a prompt between turns closes the open message", () => {
    let s = claude(text("first"));
    s = appendUserText(s, "now do this");
    s = claude(text("second"), s);
    assert.deepEqual(
      s.messages.map((m) => m.role),
      ["assistant", "user", "assistant"],
    );
  });

  test("reasoning does not merge into prose", () => {
    let s = appendAgentPayload(
      emptyTranscript(),
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } },
      { agent: "claude" },
    );
    s = claude(text("the answer"), s);
    assert.deepEqual(
      s.messages[0].content.map((p) => p.type),
      ["reasoning", "text"],
    );
  });
});

describe("tool calls", () => {
  test("a call keeps its name and arguments", () => {
    const s = claude(toolUse("t1", "Edit", { file_path: "src/db.ts" }));
    const part = s.messages[0].content[0];
    assert.equal(part.type, "tool-call");
    assert.equal(part.toolName, "Edit");
    assert.equal(part.toolCallId, "t1");
    assert.deepEqual(part.args, { file_path: "src/db.ts" });
  });

  test("a result attaches to its call rather than becoming a user message", () => {
    let s = claude(toolUse("t1", "Bash", { command: "npm test" }));
    s = claude(toolResult("t1", "875 passing"), s);
    assert.equal(s.messages.length, 1, "the tool result must not open a user message");
    assert.equal(s.messages[0].content[0].result, "875 passing");
    assert.equal(s.messages[0].content[0].isError, false);
  });

  test("a failing tool is marked as one", () => {
    let s = claude(toolUse("t1", "Bash", {}));
    s = claude(toolResult("t1", "exit 1", true), s);
    assert.equal(s.messages[0].content[0].isError, true);
  });

  test("a result for a call we never saw is ignored, not thrown", () => {
    const s = claude(toolResult("nope", "x"));
    assert.equal(s.messages.length, 0);
  });

  test("a result finds its call across an intervening turn", () => {
    let s = claude(toolUse("t1", "Read", {}));
    s = claude(text("reading"), s);
    s = appendUserText(s, "carry on");
    s = claude(toolResult("t1", "contents"), s);
    assert.equal(s.messages[0].content[0].result, "contents");
  });

  test("absolute paths under the repo are trimmed to repo-relative", () => {
    const s = appendAgentPayload(
      emptyTranscript(),
      toolUse("t1", "Edit", { file_path: "C:/dev/zevet/src/db.ts", other: 7 }),
      { agent: "claude", localRoot: "C:/dev/zevet" },
    );
    assert.deepEqual(s.messages[0].content[0].args, { file_path: "src/db.ts", other: 7 });
  });
});

describe("copy on write", () => {
  test("appending does not mutate the previous state", () => {
    const before = claude(text("one"));
    const snapshot = JSON.parse(JSON.stringify(before.messages));
    const after = claude(text(" two"), before);
    assert.deepEqual(before.messages, snapshot, "the earlier state was mutated");
    assert.notEqual(after.messages, before.messages);
    assert.notEqual(after.messages[0], before.messages[0]);
  });

  test("an untouched message keeps its identity", () => {
    let s = appendUserText(emptyTranscript(), "hi");
    const user = s.messages[0];
    s = claude(text("hello"), s);
    assert.equal(s.messages[0], user, "an untouched message must not be copied");
  });
});

describe("endings", () => {
  test("a result event completes the turn", () => {
    let s = claude(text("done"));
    s = claude({ type: "result", subtype: "success" }, s);
    assert.equal(s.messages[0].status.type, "complete");
    assert.equal(s.openIndex, -1);
  });

  test("a non-zero exit is incomplete, in words rather than an exit code", () => {
    let s = claude(text("half"));
    s = closeTranscript(s, { code: 1 });
    assert.equal(s.messages[0].status.type, "incomplete");
    assert.equal(s.messages[0].status.error, "The run stopped.");
  });

  test("a run we stopped ends clean, with no error, whatever its exit code", () => {
    let s = claude(text("half"));
    s = closeTranscript(s, { code: 1, stopped: true });
    assert.deepEqual(s.messages[0].status, { type: "complete", reason: "stop" });
  });

  test("a process replaced by a follow-up adds nothing under the new prompt", () => {
    let s = claude(text("done"));
    s = claude({ type: "result", subtype: "success" }, s);
    s = appendUserText(s, "and then?");
    s = closeTranscript(s, { code: 1, stopped: true });
    assert.deepEqual(s.messages.map((m) => m.role), ["assistant", "user"]);
  });

  test("an error with nothing open still lands on a message", () => {
    const s = closeTranscript(appendUserText(emptyTranscript(), "ok"), { error: "The model returned an error." });
    assert.deepEqual(s.messages.map((m) => m.role), ["user", "assistant"]);
    assert.equal(s.messages[1].status.error, "The model returned an error.");
    assert.equal(s.openIndex, -1);
  });

  test("a run that ends with no output and no error adds nothing and is not running", () => {
    const s = closeTranscript(appendUserText(emptyTranscript(), "ok"), { code: 0 });
    assert.equal(s.messages.length, 1);
    assert.equal(s.openIndex, -1);
    assert.equal(s.running, false);
  });

  test("a claude result that is an error says so in one plain line", () => {
    let s = claude(text("x"));
    s = claude({ type: "result", is_error: true, result: 'API Error: 429 {"type":"rate_limit_error"}' }, s);
    assert.equal(s.messages[0].status.error, "Rate limited");
  });

  test("closing an already-closed transcript is a no-op", () => {
    let s = closeTranscript(claude(text("x")), { code: 0 });
    const again = closeTranscript(s, { code: 1 });
    assert.equal(again.messages[0].status.type, "complete");
  });
});

describe("raw output", () => {
  test("stdout that is not JSON, and stderr, are not conversation", () => {
    const s = assembleTranscript([
      { type: "stdout-line", line: "npm notice new version available" },
      { type: "stderr", text: "ERROR rmcp::transport::worker: worker quit" },
    ]);
    assert.equal(s.messages.length, 0);
  });
});

describe("opencode", () => {
  const oc = (p, state = emptyTranscript()) => appendAgentPayload(state, p, { agent: "opencode" });

  test("text parts render", () => {
    const s = oc({ type: "text", part: { type: "text", text: "hi" } });
    assert.deepEqual(s.messages[0].content, [{ type: "text", text: "hi" }]);
  });

  test("a tool reported twice updates rather than duplicating", () => {
    let s = oc({ type: "tool_use", part: { type: "tool", id: "c1", tool: "bash", state: { status: "running", input: { cmd: "ls" } } } });
    s = oc({ type: "tool_use", part: { type: "tool", id: "c1", tool: "bash", state: { status: "completed", output: "a b c" } } }, s);
    const parts = s.messages[0].content.filter((p) => p.type === "tool-call");
    assert.equal(parts.length, 1, "the second report must update the first");
    assert.equal(parts[0].result, "a b c");
  });

  // MEASURED 2026-09-23 against opencode 1.18.31: a `write` outside the repo
  // in a headless run gets one tool_use, status "error", the reason at
  // `state.error` and no `state.output` at all — auto-rejected because a
  // headless run has nobody to ask. Before this, only `output` was read, so
  // the tool call kept no result and no isError: not running, not failed,
  // nothing visible. Andrew: it "auto-rejected, which ended the run" with no
  // indication why.
  test("a tool opencode auto-rejects (no state.output, only state.error) still shows why", () => {
    const s = oc({
      type: "tool_use",
      part: {
        type: "tool",
        callID: "call_9c957d5e",
        tool: "write",
        state: {
          status: "error",
          input: { filePath: "C:/Windows/Temp/x.txt", content: "x" },
          error: "The user rejected permission to use this specific tool call.",
        },
      },
    });
    const part = s.messages[0].content.find((p) => p.type === "tool-call");
    assert.ok(part, "the rejected call must still appear");
    assert.equal(part.result, "The user rejected permission to use this specific tool call.");
    assert.equal(part.isError, true);
  });

  test("step_finish closes the turn", () => {
    let s = oc({ type: "text", part: { type: "text", text: "x" } });
    s = oc({ type: "step_finish", part: { type: "step-finish", reason: "stop" } }, s);
    assert.equal(s.messages[0].status.type, "complete");
  });

  // Captured 2026-09-22: `opencode run --format json` asked to read three
  // files. Every tool call is its own step, finishing with reason
  // "tool-calls". They are one turn, so one "N tool calls" group.
  test("steps that hand off to a tool stay one turn", () => {
    const tool = (n) => [
      { type: "step_start", part: { type: "step-start" } },
      { type: "tool_use", part: { type: "tool", id: `prt_${n}`, callID: `call_${n}`, tool: "read", state: { status: "completed", input: { filePath: `${n}.txt` }, output: String(n) } } },
      { type: "step_finish", part: { type: "step-finish", reason: "tool-calls" } },
    ];
    const payloads = [
      ...[1, 2, 3, 4].flatMap(tool),
      { type: "step_start", part: { type: "step-start" } },
      { type: "text", part: { type: "text", text: "Done." } },
      { type: "step_finish", part: { type: "step-finish", reason: "stop" } },
    ];
    const s = assembleTranscript(
      [{ type: "you", text: "read them" }, ...payloads.map((payload) => ({ type: "agent", payload }))],
      { agent: "opencode" },
    );
    assert.deepEqual(s.messages.map((m) => m.role), ["user", "assistant"]);
    assert.equal(s.messages[1].content.filter((p) => p.type === "tool-call").length, 4);
    assert.equal(s.messages[1].status.type, "complete");
  });

  // Captured 2026-09-22: openrouter/google/gemma-4-31b-it:free past the free
  // daily cap. The whole stream is this one line (headers trimmed), then exit 1.
  test("a provider error before any output ends in one plain line, not silence or the payload", () => {
    const payload = {
      type: "error",
      timestamp: 1790108523032,
      sessionID: "ses_f3538c910ffePe9VXNUXptNZI1",
      error: {
        name: "APIError",
        data: {
          message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
          statusCode: 429,
          isRetryable: true,
          responseHeaders: { "x-ratelimit-limit": "50", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790121600000" },
          responseBody: '{"error":{"message":"Rate limit exceeded: free-models-per-day.","code":429}}',
          metadata: { url: "https://openrouter.ai/api/v1/chat/completions" },
        },
      },
    };
    let s = appendUserText(emptyTranscript(), "ok");
    s = appendAgentPayload(s, payload, { agent: "opencode", model: "openrouter/google/gemma-4-31b-it:free" });
    s = closeTranscript(s, { code: 1 });
    assert.equal(s.messages.length, 2);
    // The reset time comes off this same payload's responseHeaders (see
    // resetFromPayload in model-limits.mjs) — terse, no model name, per
    // CLAUDE.md's ui-copy-zevet-style note.
    assert.equal(s.messages[1].status.error, `Rate limited · resets ${resetClock(1790121600000)}`);
    assert.equal(s.openIndex, -1);
  });
});

describe("codex", () => {
  const cx = (p, state = emptyTranscript()) => appendAgentPayload(state, p, { agent: "codex" });

  test("an agent_message item renders", () => {
    const s = cx({ type: "item.completed", item: { type: "agent_message", text: "ok" } });
    assert.deepEqual(s.messages[0].content, [{ type: "text", text: "ok" }]);
  });

  test("a command execution becomes a tool call with its output", () => {
    const s = cx({
      type: "item.completed",
      item: { id: "i1", type: "command_execution", command: "ls", aggregated_output: "a\nb", status: "completed" },
    });
    const part = s.messages[0].content[0];
    assert.equal(part.type, "tool-call");
    assert.equal(part.toolName, "Bash");
    assert.deepEqual(part.args, { command: "ls" });
    assert.equal(part.result, "a\nb");

    // ANSI leaks into a Bash tool's own output whenever the command forces
    // colour (git, npm, eslint all do under some flag or env, even off a real
    // TTY) — ToolFallbackResult renders a string result verbatim in a <pre>,
    // so raw \x1b bytes used to show up as garbage in the tool-call card.
    const colored = cx({
      type: "item.completed",
      item: { id: "i2", type: "command_execution", command: "git log -1", aggregated_output: "\x1b[33mcommit abc123\x1b[m\r\nfix: thing\r\n", status: "completed" },
    });
    const cleanPart = colored.messages[0].content[0];
    assert.equal(cleanPart.result, "commit abc123\nfix: thing\n");
  });

  test("turn.failed ends the turn with a plain reason", () => {
    let s = cx({ type: "item.completed", item: { type: "agent_message", text: "x" } });
    s = cx({ type: "turn.failed", error: { message: 'unexpected status 401 Unauthorized: {"detail":"x"}' } }, s);
    assert.equal(s.messages[0].status.error, "Not signed in.");
  });

  // A codex run that fails on a usage limit emits both an `error` event and
  // a `turn.failed` event for the same failure. Each one closed the
  // transcript with the same error, so the conversation drew the line twice:
  // "GPT-6-Astra hit its usage limit.GPT-6-Astra hit its usage limit."
  test("an error event plus turn.failed shows the error once, not twice", () => {
    const opts = { agent: "codex", model: "gpt-6-astra" };
    let s = appendUserText(emptyTranscript(), "ok");
    s = appendAgentPayload(s, { type: "error", error: { message: "usage limit reached" } }, opts);
    s = appendAgentPayload(s, { type: "turn.failed", error: { message: "usage limit reached" } }, opts);
    const errors = s.messages.filter((m) => m.status && m.status.error).map((m) => m.status.error);
    assert.deepEqual(errors, ["Rate limited"]);
  });

  // Captured 2026-09-22 from `codex exec --json`: a non-fatal notice from
  // codex itself, first in the turn. It was drawn as the start of the reply.
  test("codex's own notices are not the reply", () => {
    let s = cx({ type: "turn.started" });
    s = cx({ type: "item.completed", item: { id: "item_0", type: "error", message: "Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest" } }, s);
    s = cx({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "done" } }, s);
    assert.deepEqual(s.messages[0].content, [{ type: "text", text: "done" }]);
  });
});

describe("CLI plumbing is not conversation", () => {
  test("an unrecognised payload is not drawn", () => {
    for (const agent of ["claude", "codex", "opencode"]) {
      assert.equal(appendAgentPayload(emptyTranscript(), { type: "some_future_event" }, { agent }).messages.length, 0);
      assert.equal(appendAgentPayload(emptyTranscript(), { nope: 1 }, { agent }).messages.length, 0);
    }
  });

  test("errors become one plain line, never the payload", () => {
    assert.equal(plainError("Rate limit exceeded: free-models-per-day"), "Rate limited");
    assert.equal(plainError("HTTP 429 Too Many Requests", { model: "x/y" }), "Rate limited");
    // resetClock reads the viewer's own local clock (not UTC — a person
    // reads "resets 14:05" against their own time), so the expected string
    // is computed the same way rather than hard-coded against one timezone.
    const resetAt = Date.now() + 3_600_000;
    assert.equal(plainError("HTTP 429 Too Many Requests", { resetAt }), `Rate limited · resets ${resetClock(resetAt)}`);
    assert.equal(plainError("Could not find codex on this machine. Looked in 9 directories"), "Codex isn't installed.");
    // A code-bearing provider error (not 429/401), and a 401 kept distinct
    // from it — CLAUDE.md's rate-limit ask draws that line explicitly.
    assert.equal(plainError('{"error":{"code":500}}'), "Provider error 500");
    assert.equal(plainError("unexpected status 401 Unauthorized"), "Not signed in.");
    assert.equal(plainError("Streaming response failed: [504] A Timeout Occurred"), "Provider error 504");
    assert.equal(plainError("Streaming response timed out"), "Timed out");
    assert.equal(plainError("spawn EINVAL", { fallback: "Couldn't start." }), "Couldn't start.");
  });

  test("a non-object payload is ignored without throwing", () => {
    assert.equal(appendAgentPayload(emptyTranscript(), null).messages.length, 0);
    assert.equal(appendAgentPayload(emptyTranscript(), 7).messages.length, 0);
    assert.equal(appendAgentPayload(emptyTranscript(), "hi").messages.length, 0);
  });
});

describe("assembleTranscript", () => {
  test("replays a whole console from its event stream", () => {
    const s = assembleTranscript(
      [
        { type: "you", text: "fix the test" },
        { type: "agent", payload: text("Looking.") },
        { type: "agent", payload: toolUse("t1", "Bash", { command: "npm test" }) },
        { type: "agent", payload: toolResult("t1", "1 failing") },
        { type: "agent", payload: text(" Found it.") },
        { type: "agent", payload: { type: "result" } },
      ],
      { agent: "claude" },
    );
    assert.deepEqual(
      s.messages.map((m) => m.role),
      ["user", "assistant"],
    );
    assert.deepEqual(
      s.messages[1].content.map((p) => p.type),
      ["text", "tool-call", "text"],
    );
    assert.equal(s.messages[1].status.type, "complete");
  });

  test("an empty or missing event list is an empty transcript", () => {
    assert.equal(assembleTranscript([]).messages.length, 0);
    assert.equal(assembleTranscript(undefined).messages.length, 0);
  });
});

/* A bare ordered-list marker is a real answer, and markdown eats it.
 *
 * Asked "what is 17 times 3?", claude replied exactly `51.` — and every
 * markdown renderer, correctly by the spec, turns a line of `51.` with nothing
 * after it into an EMPTY ordered list starting at 51. Measured in the running
 * app on 2026-09-21: the DOM held `<ol start="51"><li></li></ol>` and the
 * answer was invisible. Andrew: "the response looked super weird."
 *
 * What is pinned: that the escape happens, that a REAL list never gets it, and
 * — the part that is easy to get wrong — that it is idempotent under
 * streaming, because the text arrives in pieces and `51.` becomes
 * `51. something` one delta later. */
describe("a bare number and a full stop is not a list", () => {
  const first = (state) => state.messages[0].content[0].text;
  const stream = (...chunks) =>
    assembleTranscript(
      chunks.map((text) => ({
        type: "agent",
        payload: { type: "assistant", message: { content: [{ type: "text", text }] } },
      })),
    );

  test("an answer that is only a marker is escaped", () => {
    assert.equal(first(stream("51.")), "51" + String.fromCharCode(92) + ".");
  });

  test("and unescaped again once the sentence continues", () => {
    // The escape must not survive into text that no longer needs it: a stray
    // backslash would reach copy and the raw-output panel.
    assert.equal(first(stream("51.", " Three times seventeen.")), "51. Three times seventeen.");
  });

  test("a real numbered list is untouched", () => {
    assert.equal(first(stream("1. one\n2. two")), "1. one\n2. two");
  });

  test("a number mid-sentence is untouched", () => {
    assert.equal(first(stream("it cost 51. then more")), "it cost 51. then more");
  });

  test("reasoning is not markdown, so it is not rewritten", () => {
    const s = assembleTranscript([
      { type: "agent", payload: { type: "assistant", message: { content: [{ type: "thinking", thinking: "51." }] } } },
    ]);
    assert.equal(s.messages[0].content[0].text, "51.");
  });
});

/* Payloads that are real, understood, and deliberately not transcript content.
 *
 * ⚠️ `stream_event` WAS THE BUG ANDREW SAW. --include-partial-messages wraps
 * every raw SSE event in one, nothing read them, and each printed the literal
 * `[claude: stream_event]` into the assistant's own message — a one-sentence
 * answer came back as dozens of them. The flag is gone from the invocation
 * (agent-console.test.mjs pins its absence); this pins that an older desktop
 * build still degrades to silence rather than to garbage. */
describe("claude payloads that are not transcript content", () => {
  for (const type of ["stream_event", "rate_limit_event", "system"]) {
    test(`${type} adds nothing to the transcript`, () => {
      const before = emptyTranscript();
      const after = appendAgentPayload(before, { type, event: { type: "content_block_delta" } });
      assert.equal(after.messages.length, 0, `${type} put something on screen`);
    });
  }

  // MEASURED 2026-09-21 (board.ts's limitsOf comment): the one captured
  // rate_limit_event carried rate_limit_info.status "allowed" — this must
  // stay silent, same as the loop above (no status field is the same case).
  test("rate_limit_event with status allowed still adds nothing", () => {
    const before = claude(text("x"));
    const after = claude({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: {} } }, before);
    assert.equal(after.messages[0].status.type, "running", "an allowed status must not close the turn");
  });

  // Verified 2026-09-23 in the claude 2.1.278 binary: "allowed_warning" is
  // near the limit (request still served); "rejected" is exhaustion.
  test("rate_limit_event allowed_warning does not end the turn", () => {
    const s = claude({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", unifiedWindows: {} } }, claude(text("x")));
    assert.equal(s.messages[0].status.type, "running");
  });

  test("rate_limit_event rejected ends the turn as a rate limit", () => {
    let s = claude(text("x"));
    s = claude({ type: "rate_limit_event", rate_limit_info: { status: "rejected", unifiedWindows: {} } }, s);
    assert.equal(s.messages[0].status.type, "incomplete");
    assert.equal(s.messages[0].status.error, "Rate limited");
  });
});
