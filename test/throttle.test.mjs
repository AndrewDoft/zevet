// The console publish throttle (board/src/lib/throttle.mjs): agent events arrive
// by the hundred a second and each publish re-renders the thread, rail and
// composer. A burst must cost two publishes, not a thousand, and nothing may be lost.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const { throttle } = await import(pathToFileURL(path.join(ROOT, "board", "src", "lib", "throttle.mjs")).href);

function clock() {
  let now = 0;
  const q = [];
  return {
    set: (f, ms) => { const t = { f, at: now + ms }; q.push(t); return t; },
    clear: (t) => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at);
        if (!q.length || q[0].at > end) break;
        const t = q.shift();
        now = t.at;
        t.f();
      }
      now = end;
    },
  };
}

test("first call runs now; a burst collapses to one trailing run", () => {
  const c = clock();
  let n = 0;
  const f = throttle(() => n++, 50, c);
  f();
  assert.equal(n, 1);
  for (let i = 0; i < 1000; i++) f();
  assert.equal(n, 1);
  c.advance(50);
  assert.equal(n, 2);
  c.advance(500);
  assert.equal(n, 2, "no run without a call");
});

test("a lone call after quiet runs at once again", () => {
  const c = clock();
  let n = 0;
  const f = throttle(() => n++, 50, c);
  f();
  c.advance(200);
  f();
  assert.equal(n, 2);
});

test("a steady stream publishes at most once per window", () => {
  const c = clock();
  let n = 0;
  const f = throttle(() => n++, 50, c);
  for (let t = 0; t < 1000; t++) { f(); c.advance(1); }
  assert.ok(n <= 21 && n >= 19, `got ${n}`);
});

test("flush runs a pending call immediately and not twice", () => {
  const c = clock();
  let n = 0;
  const f = throttle(() => n++, 50, c);
  f(); f();
  f.flush();
  assert.equal(n, 2);
  c.advance(100);
  assert.equal(n, 2);
});

test("board.ts publishes console changes through it", () => {
  const src = readFileSync(path.join(ROOT, "board", "src", "lib", "board.ts"), "utf8");
  assert.match(src, /const signalConsolesChanged = throttle\(/);
});
