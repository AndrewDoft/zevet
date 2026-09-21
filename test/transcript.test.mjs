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
// per message by reference; and — the one that matters most for an agent you
// are watching — that an event nobody recognised still appears.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const {
  _resetIds,
  appendAgentPayload,
  appendRaw,
  appendUserText,
  assembleTranscript,
  closeTranscript,
  emptyTranscript,
} = await import(pathToFileURL(path.join(ROOT, "board", "src", "lib", "transcript.mjs")).href);

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

  test("a non-zero exit is incomplete and says why", () => {
    let s = claude(text("half"));
    s = closeTranscript(s, { code: 1 });
    assert.equal(s.messages[0].status.type, "incomplete");
    assert.match(s.messages[0].status.error, /exited 1/);
  });

  test("closing an already-closed transcript is a no-op", () => {
    let s = closeTranscript(claude(text("x")), { code: 0 });
    const again = closeTranscript(s, { code: 1 });
    assert.equal(again.messages[0].status.type, "complete");
  });
});

describe("raw output", () => {
  test("a non-JSON line is kept as text, not treated as an error", () => {
    const s = appendRaw(emptyTranscript(), "npm notice new version available");
    assert.equal(s.messages[0].role, "assistant");
    assert.equal(s.messages[0].content[0].type, "text");
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

  test("step_finish closes the turn", () => {
    let s = oc({ type: "text", part: { type: "text", text: "x" } });
    s = oc({ type: "step_finish", part: { reason: "done" } }, s);
    assert.equal(s.messages[0].status.type, "complete");
  });

  test("an error ends the turn with its message", () => {
    let s = oc({ type: "text", part: { type: "text", text: "x" } });
    s = oc({ type: "error", error: { message: "rate limited" } }, s);
    assert.equal(s.messages[0].status.error, "rate limited");
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
  });

  test("turn.failed ends the turn with its reason", () => {
    let s = cx({ type: "item.completed", item: { type: "agent_message", text: "x" } });
    s = cx({ type: "turn.failed", error: { message: "no auth" } }, s);
    assert.equal(s.messages[0].status.error, "no auth");
  });
});

describe("nothing is silently dropped", () => {
  // The point of the whole module. An agent that emitted something we do not
  // model must still look like it did something, or you sit watching a blank
  // pane wondering whether it hung.
  test("an unrecognised payload is shown, naming its type", () => {
    const s = appendAgentPayload(emptyTranscript(), { type: "some_future_event" }, { agent: "codex" });
    assert.equal(s.messages.length, 1);
    assert.match(s.messages[0].content[0].text, /some_future_event/);
  });

  test("a payload with no type at all still produces something", () => {
    const s = appendAgentPayload(emptyTranscript(), { nope: 1 }, { agent: "claude" });
    assert.match(s.messages[0].content[0].text, /event/);
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

  test("but a type nobody has seen is still shown", () => {
    // The fallback is not the bug and must stay: an event silently dropped is
    // how you end up believing an agent did nothing for thirty seconds.
    const after = appendAgentPayload(emptyTranscript(), { type: "something_new" });
    assert.match(after.messages[0].content[0].text, /something_new/);
  });
});
