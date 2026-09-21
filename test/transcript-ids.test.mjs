// A tool call id has to be unique within a transcript.
//
// ⚠️ MEASURED, and it took down the whole conversation. assistant-ui keys
// message parts by toolCallId. Sending a second prompt replayed a turn whose
// tool ids repeated, and React threw
//
//     Error: Duplicate key toolCallId-t2 in useResources
//
// inside AuiProvider — not a broken card, the entire thread gone. One repeated
// id from any of the three CLIs, across any version, does the same to somebody
// mid-session, and zevet does not control those ids.
//
// So transcript.mjs makes them unique. A result matches by id and a repeated
// id could only ever match the wrong call anyway, so the newest wins — the
// rule a person reading the stream in order would apply.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const { _resetIds, appendAgentPayload, emptyTranscript } = await import(
  pathToFileURL(path.join(ROOT, "board", "src", "lib", "transcript.mjs")).href
);

beforeEach(() => _resetIds());

const claude = (payload, state = emptyTranscript()) =>
  appendAgentPayload(state, payload, { agent: "claude" });

const toolUse = (id, name) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] },
});
const toolResult = (id, content) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
});

const callsIn = (state) =>
  state.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === "tool-call");

describe("ids are unique even when the agent reuses one", () => {
  test("a repeated id does not collide", () => {
    let s = claude(toolUse("t2", "Bash"));
    s = claude(toolUse("t2", "Bash"), s);
    const ids = callsIn(s).map((p) => p.toolCallId);
    assert.equal(ids.length, 2);
    assert.equal(new Set(ids).size, 2, `both calls kept the same id: ${ids.join(", ")}`);
  });

  test("the first keeps the id the agent gave it", () => {
    let s = claude(toolUse("t2", "Bash"));
    s = claude(toolUse("t2", "Bash"), s);
    assert.equal(callsIn(s)[0].toolCallId, "t2");
  });

  test("a result after a repeat lands on the newest call", () => {
    // Which is the only reading that can be right: the older call's result has
    // already been and gone, or was never coming.
    let s = claude(toolUse("t2", "Bash"));
    s = claude(toolResult("t2", "first"), s);
    s = claude(toolUse("t2", "Bash"), s);
    s = claude(toolResult("t2", "second"), s);
    const calls = callsIn(s);
    assert.equal(calls[0].result, "first");
    assert.equal(calls[1].result, "second");
  });

  test("three of the same id all survive", () => {
    let s = emptyTranscript();
    for (let i = 0; i < 3; i += 1) s = claude(toolUse("dup", "Read"), s);
    const ids = callsIn(s).map((p) => p.toolCallId);
    assert.equal(new Set(ids).size, 3, ids.join(", "));
  });
});

describe("tool calls carry when they happened", () => {
  // Nothing else records this: the CLIs do not timestamp their events, so the
  // only honest clock is the one on the machine reading them. It is what lets
  // a turn be drawn as a waterfall rather than a list.
  test("a call records when it started", () => {
    const part = callsIn(claude(toolUse("t1", "Bash")))[0];
    assert.equal(typeof part.startedAt, "number");
    assert.ok(part.startedAt > 0);
  });

  test("a result records when it ended", () => {
    let s = claude(toolUse("t1", "Bash"));
    s = claude(toolResult("t1", "done"), s);
    const part = callsIn(s)[0];
    assert.equal(typeof part.endedAt, "number");
    assert.ok(part.endedAt >= part.startedAt);
  });

  test("a call still running has no end", () => {
    const part = callsIn(claude(toolUse("t1", "Bash")))[0];
    assert.equal(part.endedAt, undefined, "an unfinished call must not claim an end time");
  });
});
