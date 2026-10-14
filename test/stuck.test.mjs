// The stuck detector, driven through the real transcript builder so the
// message shape is the one the board actually holds.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assembleTranscript } from "../board/src/lib/transcript.mjs";
import { detectStuck, REPEAT_SAME, ERROR_LOOP, PING_PONG, MONOLOGUE } from "../board/src/lib/stuck.mjs";

let n = 0;
const use = (name, input) => ({
  type: "agent",
  payload: { type: "assistant", message: { content: [{ type: "tool_use", id: `t${++n}`, name, input }] } },
});
const back = (id, content, is_error = false) => ({
  type: "agent",
  payload: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } },
});
/** A completed call: the tool_use and its result. */
const call = (name, input, out = "ok", err = false) => {
  const e = use(name, input);
  return [e, back(`t${n}`, out, err)];
};
const say = (text) => ({ type: "agent", payload: { type: "assistant", message: { content: [{ type: "text", text }] } } });
const stuckOf = (events) => detectStuck(assembleTranscript(events).messages);
const times = (k, f) => Array.from({ length: k }, (_, i) => f(i)).flat();

describe("detectStuck", () => {
  test("same call, same result, REPEAT_SAME times", () => {
    assert.equal(stuckOf(times(REPEAT_SAME, () => call("Bash", { command: "ls" }, "a b"))).pattern, "repeat");
    assert.equal(stuckOf(times(REPEAT_SAME - 1, () => call("Bash", { command: "ls" }, "a b"))), null);
  });

  test("same call erroring with a different message each time", () => {
    const ev = times(ERROR_LOOP, (i) => call("Edit", { file: "a.js" }, `no match ${i}`, true));
    assert.equal(stuckOf(ev).pattern, "error-loop");
    assert.equal(stuckOf(ev.slice(2)), null);
  });

  test("A/B ping-pong with unchanging results", () => {
    const ev = times(PING_PONG, (i) => (i % 2 ? call("Read", { f: "b" }, "B") : call("Edit", { f: "a" }, "A")));
    assert.equal(stuckOf(ev).pattern, "ping-pong");
    assert.equal(stuckOf(ev.slice(2)), null);
  });

  test("the same words repeated with no tool call between", () => {
    const ev = times(MONOLOGUE, () => [say("I will fix it now."), { type: "exit", code: 0 }]);
    assert.equal(stuckOf(ev).pattern, "monologue");
    assert.equal(stuckOf(times(MONOLOGUE - 1, () => [say("I will fix it now."), { type: "exit", code: 0 }])), null);
  });

  test("a healthy transcript is not flagged", () => {
    const ev = [
      { type: "you", text: "fix the bug" },
      say("Looking."),
      ...call("Read", { f: "a.js" }, "src"),
      ...call("Read", { f: "b.js" }, "src2"),
      ...call("Edit", { f: "a.js", n: 1 }, "done"),
      ...call("Bash", { command: "npm test" }, "1 failing"),
      ...call("Edit", { f: "a.js", n: 2 }, "done"),
      ...call("Bash", { command: "npm test" }, "all passing"),
      ...call("Read", { f: "a.js" }, "src"),
      ...call("Read", { f: "a.js" }, "src"),
      say("Done."),
    ];
    assert.equal(stuckOf(ev), null);
    assert.equal(detectStuck([]), null);
  });

  test("a loop before the last prompt does not count", () => {
    const ev = [...times(REPEAT_SAME, () => call("Bash", { command: "ls" }, "x")), { type: "you", text: "stop that" }];
    assert.equal(stuckOf(ev), null);
  });

  test("a call still in flight breaks a repeat", () => {
    const ev = [...times(REPEAT_SAME - 1, () => call("Bash", { command: "ls" }, "x")), use("Bash", { command: "ls" })];
    assert.equal(stuckOf(ev), null);
  });
});

describe("detectStuck: near misses", () => {
  const exit = { type: "exit", code: 0 };
  test("same call with changing results is progress, not a repeat", () => {
    assert.equal(stuckOf(times(REPEAT_SAME, (i) => call("Bash", { command: "ls" }, `out ${i}`))), null);
  });
  test("one call whose result alternates is not a ping-pong", () => {
    assert.equal(stuckOf(times(PING_PONG, (i) => call("Bash", { command: "ls" }, i % 2 ? "x" : "y"))), null);
  });
  test("a prompt in the middle cuts the run", () => {
    const ev = [...call("Bash", { command: "ls" }, "x"), { type: "you", text: "again" }, ...times(REPEAT_SAME - 1, () => call("Bash", { command: "ls" }, "x"))];
    assert.equal(stuckOf(ev), null);
  });
  test("an empty-result call still in flight is not counted as done", () => {
    const ev = [...times(REPEAT_SAME - 1, () => call("Bash", { command: "true" }, "")), use("Bash", { command: "true" })];
    assert.equal(stuckOf(ev), null);
  });
  test("different messages are not a monologue", () => {
    assert.equal(stuckOf(times(MONOLOGUE, (i) => [say(`step ${i}`), exit])), null);
  });
});

test("narration between identical calls does not hide the loop", () => {
  const ev = times(REPEAT_SAME, () => [say("retrying"), ...call("Bash", { command: "ls" }, "x")]);
  assert.equal(stuckOf(ev).pattern, "repeat");
});

test("results sharing a long prefix but differing in length are progress", () => {
  const head = "h".repeat(500);
  assert.equal(stuckOf(times(REPEAT_SAME, (i) => call("Bash", { command: "npm test" }, `${head}${"f".repeat(i + 1)}`))), null);
});

test("two calls alternating but with changing results is progress", () => {
  const ev = times(PING_PONG, (i) => (i % 2 ? call("Read", { f: "b" }, `B${i}`) : call("Edit", { f: "a" }, `A${i}`)));
  assert.equal(stuckOf(ev), null);
});
