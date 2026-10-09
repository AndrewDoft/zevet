// The thread draws only the tail (board/src/lib/window.mjs): a 300-turn thread cost 25 s of CPU to stream 60 events.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const { tail, WINDOW, moreFor, widen } = await import(pathToFileURL(path.join(ROOT, "board", "src", "lib", "window.mjs")).href);
const ms = (n) => Array.from({ length: n }, (_, i) => ({ id: i }));

test("a thread that fits comes back untouched, by reference", () => {
  const m = ms(WINDOW);
  const r = tail(m);
  assert.equal(r.shown, m);
  assert.equal(r.hidden, 0);
});

test("a long thread keeps the newest messages and counts the rest", () => {
  const m = ms(WINDOW + 25);
  const r = tail(m);
  assert.equal(r.shown.length, WINDOW);
  assert.equal(r.shown[r.shown.length - 1], m[m.length - 1]);
  assert.equal(r.shown[0], m[25]);
  assert.equal(r.hidden, 25);
});

test("widening one thread draws one more window of it and leaves other threads narrow", () => {
  const m = ms(WINDOW * 3);
  let state = { key: "", n: 0 };
  state = widen(state, "c:1");
  assert.equal(tail(m, moreFor(state, "c:1")).hidden, WINDOW);
  assert.equal(tail(m, moreFor(state, "c:2")).hidden, WINDOW * 2, "another thread starts at the base window");
  state = widen(state, "c:1");
  assert.equal(tail(m, moreFor(state, "c:1")).hidden, 0);
  state = widen(state, "c:2");
  assert.equal(moreFor(state, "c:1"), 0, "switching thread forgets the old widening");
});
