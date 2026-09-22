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
  const resume = main.slice(main.indexOf('ipcMain.handle("local:resumeAgent"'), main.indexOf('ipcMain.handle("local:sendToAgent"'));
  assert.match(resume, /consoles\.delete\(continues\)/, "every follow-up leaks the exited handle");
});

test("a console closed while starting stops the process it was waiting for", () => {
  assert.match(board, /function closedMeanwhile\([^)]*\)[^{]*\{[^}]*myConsoles\.some\(\(x\) => x\.key === c\.key\)/);
  assert.match(board, /stopAgent\(String\(id\)\);\s*void bridge\.local\?\.forgetAgent\?\.\(String\(id\)\)/);
  // startAgent and both resume paths: every place a new process id lands.
  assert.equal(board.match(/if \(closedMeanwhile\(c, r\.id\)\) return;\s*(\/\/[^\n]*\s*)*c\.id = r\.id/g)?.length, 3);
});
