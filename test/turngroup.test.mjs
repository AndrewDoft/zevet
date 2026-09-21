// One tool-call dropdown per turn, instead of ten.
//
// assistant-ui groups ADJACENT tool calls and closes the group by default,
// which sounds like it is already the feature. Measured against a real session
// on this machine (2026-09-21): 2,342 tool calls across 32 assistant turns
// formed 341 separate groups — 10.7 collapsed rows per turn — because the
// agent breaks adjacency every time it says a sentence between calls.
//
// What is pinned here: that a turn ends up with its tool calls contiguous so
// they form ONE group; that the calls keep their order among themselves; and —
// the one that is invisible until it bites — that a message needing no change
// comes back BY REFERENCE. assistant-ui memoises per message by reference, so
// a transform that allocated fresh objects on every render would re-mount
// every dropdown and close the one you had just opened.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const { groupTurnTools, turnToolCount } = await import(
  pathToFileURL(path.join(ROOT, "board", "src", "lib", "turngroup.mjs")).href
);

const text = (t) => ({ type: "text", text: t });
const call = (id) => ({ type: "tool-call", toolCallId: id, toolName: "Bash", args: {} });
const turn = (...content) => ({ id: "m1", role: "assistant", content });

describe("groupTurnTools", () => {
  test("interleaved tool calls end up contiguous, in order", () => {
    const out = groupTurnTools([turn(text("a"), call("1"), text("b"), call("2"), call("3"))]);
    const kinds = out[0].content.map((p) => p.type);
    assert.deepEqual(kinds, ["text", "text", "tool-call", "tool-call", "tool-call"]);
    assert.deepEqual(
      out[0].content.filter((p) => p.type === "tool-call").map((p) => p.toolCallId),
      ["1", "2", "3"],
    );
  });

  test("a turn already shaped prose-then-tools is returned by reference", () => {
    const m = turn(text("a"), call("1"), call("2"));
    const input = [m];
    const out = groupTurnTools(input);
    assert.equal(out, input, "the array itself must be unchanged");
    assert.equal(out[0], m, "the message must be the same object");
  });

  test("a turn below the threshold is left interleaved", () => {
    // One call is not a dropdown worth having, and reordering would cost the
    // interleaving for nothing.
    const m = turn(text("a"), call("1"), text("b"));
    const out = groupTurnTools([m]);
    assert.equal(out[0], m);
  });

  test("user messages and empty input are untouched", () => {
    const u = { id: "u", role: "user", content: [text("hi")] };
    const input = [u];
    assert.equal(groupTurnTools(input), input);
    assert.equal(groupTurnTools([]).length, 0);
    assert.deepEqual(groupTurnTools(null), null);
  });

  test("only the turns that changed are new objects", () => {
    const untouched = turn(text("a"), call("1"), call("2"));
    const rearranged = turn(call("3"), text("b"), call("4"));
    const out = groupTurnTools([untouched, rearranged]);
    assert.equal(out[0], untouched);
    assert.notEqual(out[1], rearranged);
    // And the original is not mutated: the source stays in true order for the
    // panels that read the transcript rather than render it.
    assert.equal(rearranged.content[0].type, "tool-call");
  });

  test("turnToolCount counts calls and nothing else", () => {
    assert.equal(turnToolCount(turn(text("a"), call("1"), call("2"))), 2);
    assert.equal(turnToolCount(turn(text("a"))), 0);
    assert.equal(turnToolCount(null), 0);
  });
});
