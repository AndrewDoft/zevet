// What main.js keeps of each console so a reloaded board can re-attach to the
// agents that kept running through the reload. See desktop/console-log.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createConsoleLog } = require(path.join(ROOT, "desktop", "console-log.js"));

const META = { agent: "claude", root: "/r", model: "opus", mode: "auto", startedAt: 1 };

test("a snapshot hands back each console's metadata and events in order", () => {
  const log = createConsoleLog();
  log.open("a", META);
  const live = log.record("a", { type: "agent", payload: { n: 1 } });
  log.record("a", { type: "prompt", text: "hi" });
  assert.deepEqual(live, { type: "agent", payload: { n: 1 }, id: "a", seq: 1 });

  const snap = log.snapshot();
  assert.equal(snap.seq, 2);
  assert.equal(snap.consoles.length, 1);
  const [c] = snap.consoles;
  assert.equal(c.id, "a");
  assert.equal(c.agent, "claude");
  assert.equal(c.running, true);
  assert.deepEqual(c.events.map((e) => e.type), ["agent", "prompt"]);
});

test("get() returns one console in the same shape snapshot() gives each entry", () => {
  const log = createConsoleLog();
  log.open("a", META);
  log.record("a", { type: "agent", payload: { n: 1 } });
  const [fromSnapshot] = log.snapshot().consoles;
  assert.deepEqual(log.get("a"), fromSnapshot);
});

test("get() is undefined for a console that was never opened, or already forgotten", () => {
  const log = createConsoleLog();
  assert.equal(log.get("nope"), undefined);
  log.open("a", META);
  log.forget("a");
  assert.equal(log.get("a"), undefined);
});

test("a console that finished during the reload comes back finished", () => {
  const log = createConsoleLog();
  log.open("a", META);
  log.record("a", { type: "exit", code: 0, signal: null });
  const [c] = log.snapshot().consoles;
  assert.equal(c.running, false);
  assert.equal(c.events.at(-1).type, "exit");
});

test("live events carry a seq the snapshot can be compared against", () => {
  const log = createConsoleLog();
  log.open("a", META);
  log.record("a", { type: "stderr", text: "x" });
  const { seq } = log.snapshot();
  const after = log.record("a", { type: "stderr", text: "y" });
  assert.ok(after.seq > seq, "an event after the snapshot looks already-replayed");
});

test("the cap drops from the middle and keeps the head, with a marker", () => {
  const log = createConsoleLog({ cap: 10, head: 3 });
  log.open("a", META);
  for (let i = 0; i < 25; i++) log.record("a", { type: "agent", payload: { i } });
  const [c] = log.snapshot().consoles;
  assert.equal(c.events.length, 11);
  assert.deepEqual(c.events.slice(0, 3).map((e) => e.payload.i), [0, 1, 2], "the init events were dropped");
  assert.deepEqual(c.events[3], { type: "gap", id: "a", dropped: 15 });
  assert.equal(c.events.at(-1).payload.i, 24, "the newest event was dropped");
});

test("a resumed console continues the same thread under its new id", () => {
  const log = createConsoleLog();
  log.open("a", META);
  log.record("a", { type: "agent", payload: { turn: 1 } });
  log.record("a", { type: "exit", code: 0 });
  log.open("b", { ...META, mode: "plan", startedAt: 99 }, "a");
  log.record("b", { type: "agent", payload: { turn: 2 } });

  const { consoles } = log.snapshot();
  assert.equal(consoles.length, 1, "a follow-up came back as a second thread");
  const [c] = consoles;
  assert.equal(c.id, "b");
  assert.equal(c.running, true);
  assert.equal(c.mode, "plan");
  assert.equal(c.startedAt, 1, "the thread's start moved to the follow-up's");
  assert.deepEqual(c.events.map((e) => e.type), ["agent", "exit", "agent"]);
  // The board replays each event against the console with that id; one still
  // stamped with the old process's id matches nothing and is dropped.
  assert.deepEqual(c.events.map((e) => e.id), ["b", "b", "b"], "the turns before the follow-up are lost on reload");
});

test("a forgotten console, or one never opened, is not replayed", () => {
  const log = createConsoleLog();
  log.open("a", META);
  log.forget("a");
  const stray = log.record("nope", { type: "stderr", text: "x" });
  assert.equal(stray.id, "nope", "an event for an unknown console is still stamped for the live board");
  assert.deepEqual(log.snapshot().consoles, []);
});

test("clear empties it, for window close and quit", () => {
  const log = createConsoleLog();
  log.open("a", META);
  log.clear();
  assert.deepEqual(log.snapshot().consoles, []);
});

// main.js and board.ts are not loadable under node --test (Electron; TS), so
// these two are pinned against the source, as board.test.mjs does.
const main = readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8");
const board = readFileSync(path.join(ROOT, "board", "src", "lib", "board.ts"), "utf8");

test("a follow-up drops the old process's handle", () => {
  const resume = main.slice(main.indexOf('bridge.handle("local:resumeAgent"'), main.indexOf('bridge.handle("local:sendToAgent"'));
  assert.match(resume, /consoles\.delete\(continues\)/, "every follow-up leaks the exited handle");
});

test("a console closed while starting stops the process it was waiting for", () => {
  assert.match(board, /function closedMeanwhile\([^)]*\)[^{]*\{[^}]*myConsoles\.some\(\(x\) => x\.key === c\.key\)/);
  assert.match(board, /stopAgent\(String\(id\)\);\s*void bridge\.local\?\.forgetAgent\?\.\(String\(id\)\)/);
  // startAgent and both resume paths: every place a new process id lands.
  assert.equal(board.match(/if \(closedMeanwhile\(c, r\.id\)\) return[^;]*;\s*(\/\/[^\n]*\s*)*c\.id = r\.id/g)?.length, 3);
});

test("a generated title is kept with the metadata and follows a continued thread", () => {
  const log = createConsoleLog();
  log.open("a", META);
  assert.equal(log.prompted("a"), false);
  log.record("a", { type: "prompt", text: "hi" });
  assert.equal(log.prompted("a"), true);
  assert.equal(log.setTitle("a", "Greeting"), true);
  assert.equal(log.snapshot().consoles[0].title, "Greeting");
  log.open("b", META, "a");
  assert.equal(log.snapshot().consoles[0].title, "Greeting");
  assert.equal(log.setTitle("a", "Gone"), false);
});

const result = (extra = {}) => ({ type: "agent", payload: { type: "result", result: "ZEVET-OK", total_cost_usd: 0.02, usage: { output_tokens: 4 }, ...extra } });

test("state: idle after open, working after a prompt, idle again on the result, exited on exit", () => {
  const log = createConsoleLog();
  log.open("a", META);
  assert.equal(log.get("a").state, "idle");
  log.record("a", { type: "prompt", text: "go" });
  assert.equal(log.get("a").state, "working");
  log.record("a", result());
  const c = log.get("a");
  assert.equal(c.state, "idle");
  assert.equal(c.running, true);
  assert.equal(c.turns, 1);
  assert.equal(c.lastResult, "ZEVET-OK");
  assert.equal(c.costUsd, 0.02);
  assert.deepEqual(c.usage, { output_tokens: 4 });
  log.record("a", { type: "prompt", text: "again" });
  assert.equal(log.get("a").state, "working");
  log.record("a", { type: "exit", code: 0, signal: null });
  assert.equal(log.get("a").state, "exited");
});

test("an errored result is flagged", () => {
  const log = createConsoleLog();
  log.open("a", META);
  log.record("a", result({ is_error: true }));
  assert.equal(log.get("a").isError, true);
});

test("turn state survives a follow-up's new process id", () => {
  const log = createConsoleLog();
  log.open("a", META);
  log.record("a", result());
  log.open("b", META, "a");
  assert.equal(log.get("b").turns, 1);
  assert.equal(log.get("b").lastResult, "ZEVET-OK");
});

test("claude's text-only user echo is not stored; a tool_result user line is", () => {
  const log = createConsoleLog();
  log.open("a", META);
  log.record("a", { type: "prompt", text: "hi" });
  log.record("a", { type: "agent", payload: { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } } });
  log.record("a", { type: "agent", payload: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } } });
  const kinds = log.get("a").events.map((e) => (e.payload ? e.payload.message.content[0].type : e.type));
  assert.deepEqual(kinds, ["prompt", "tool_result"]);
});

test("partial-message deltas are live-only: sent to the board, never stored", () => {
  const log = createConsoleLog();
  log.open("a", META);
  const live = log.record("a", { type: "agent", payload: { type: "stream_event", event: { delta: { text: "ZE" } } } });
  assert.equal(live.payload.type, "stream_event");
  assert.equal(log.get("a").events.length, 0);
});

test("onceDone fires after the first result of a console marked setOnce, and only then", () => {
  const done = [];
  const log = createConsoleLog({ onceDone: (id) => done.push(id) });
  log.open("a", META);
  log.open("b", META);
  log.setOnce("a");
  log.record("b", result());
  assert.deepEqual(done, []);
  log.record("a", { type: "prompt", text: "x" });
  assert.deepEqual(done, []);
  log.record("a", result());
  assert.deepEqual(done, ["a"]);
});

test("activity() says how many consoles have a live process and when any last spoke (the payload swap gate reads it)", () => {
  let t = 1000;
  const log = createConsoleLog({ now: () => t });
  assert.deepEqual(log.activity(), { running: 0, lastAt: 0 });
  log.open("a", { agent: "claude" });
  log.open("b", { agent: "codex" });
  assert.deepEqual(log.activity(), { running: 2, lastAt: 1000 });
  t = 5000;
  log.record("a", { type: "exit" });
  assert.deepEqual(log.activity(), { running: 1, lastAt: 5000 }, "an exited console is no longer running, but its exit is activity");
  t = 9000;
  log.record("b", { type: "exit" });
  assert.deepEqual(log.activity(), { running: 0, lastAt: 9000 });
});

test("a routed turn that ended on codex or opencode goes idle with its answer (the agent API's /wait returns)", () => {
  const log = createConsoleLog();
  log.open("z", { ...META, agent: "zevet" });
  log.record("z", { type: "prompt", text: "hi" });
  assert.equal(log.get("z").state, "working");
  log.record("z", { type: "turn_end", result: "pineapple" });
  const c = log.get("z");
  assert.equal(c.state, "idle");
  assert.equal(c.lastResult, "pineapple");
  assert.equal(c.turns, 1);
});

test("a console keeps claude's session id, so a restart can resume it", async () => {
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  const { createConsoleLog: make } = req("../desktop/console-log.js");
  const { resumableEntries } = req("../desktop/console-persistence.js");
  const log = make();
  log.open("c1", { agent: "claude", cwd: "/w", root: "/w" });
  log.record("c1", { type: "agent", payload: { type: "system", subtype: "init", session_id: "s-123" } });
  const snap = log.snapshot().consoles;
  assert.equal(snap[0].sessionId, "s-123");
  assert.deepEqual(resumableEntries(snap).map((e) => e.sessionId), ["s-123"], "and it is saved");
  log.open("c2", { agent: "claude", cwd: "/w", root: "/w" }, "c1");
  assert.equal(log.snapshot().consoles[0].sessionId, "s-123", "a follow-up process keeps the thread's id");
});
