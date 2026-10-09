// The thread draws only the tail (board/src/lib/window.mjs): a 300-turn thread cost 25 s of CPU to stream 60 events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const { tail, WINDOW } = await import(pathToFileURL(path.join(ROOT, "board", "src", "lib", "window.mjs")).href);
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

test("asking for earlier widens the window by exactly what was asked", () => {
  const m = ms(WINDOW * 3);
  assert.equal(tail(m, WINDOW).hidden, WINDOW);
  assert.equal(tail(m, WINDOW * 2).hidden, 0);
  assert.equal(tail(m, -5).shown.length, WINDOW, "negative widening is ignored");
});

test("the runtime is handed the window, not the whole thread", () => {
  const src = readFileSync(path.join(ROOT, "board", "src", "lib", "runtime.tsx"), "utf8");
  assert.match(src, /messages: shown as ThreadMessageLike\[\]/);
});
