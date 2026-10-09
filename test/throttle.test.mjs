// Console publishes (board/src/lib/publish.mjs over throttle.mjs): agent events arrive by the
// hundred a second and each publish re-renders thread, rail and composer. A burst costs two
// publishes, not a thousand, and the last state always lands.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const lib = (f) => import(pathToFileURL(path.join(ROOT, "board", "src", "lib", f)).href);
const { throttle } = await lib("throttle.mjs");
const { consolePublisher } = await lib("publish.mjs");

test("first call runs now; a burst collapses to one trailing run", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let n = 0;
  const f = throttle(() => n++, 50);
  f();
  assert.equal(n, 1);
  for (let i = 0; i < 1000; i++) f();
  assert.equal(n, 1);
  t.mock.timers.tick(50);
  assert.equal(n, 2);
  t.mock.timers.tick(500);
  assert.equal(n, 2, "no run without a call");
});

test("a lone call after quiet runs at once again", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let n = 0;
  const f = throttle(() => n++, 50);
  f();
  t.mock.timers.tick(200);
  f();
  assert.equal(n, 2);
});

test("a steady stream publishes at most once per window", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let n = 0;
  const f = throttle(() => n++, 50);
  for (let i = 0; i < 1000; i++) { f(); t.mock.timers.tick(1); }
  assert.ok(n >= 19 && n <= 21, `got ${n}`);
});

test("flush runs a pending call immediately and not twice", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let n = 0;
  const f = throttle(() => n++, 50);
  f(); f();
  f.flush();
  assert.equal(n, 2);
  t.mock.timers.tick(100);
  assert.equal(n, 2);
});

test("the publisher hands subscribers a fresh array holding the latest in-place state", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const list = [{ lines: 0 }];
  const seen = [];
  const publish = consolePublisher(() => list, (next) => seen.push(next));
  for (let i = 1; i <= 500; i++) { list[0].lines = i; publish(); }
  t.mock.timers.tick(50);
  assert.equal(seen.length, 2, "one leading, one trailing");
  assert.notEqual(seen[1], list, "a new array, so subscribers re-render");
  assert.equal(seen[1][0].lines, 500);
});

test("a run that ends flushes the pending publish", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const list = [{ running: true }];
  const seen = [];
  const publish = consolePublisher(() => list, (next) => seen.push(next.map((c) => c.running)));
  publish();
  list[0].running = false;
  publish();
  publish.flush();
  assert.deepEqual(seen[seen.length - 1], [false]);
  assert.equal(seen.length, 2);
});
