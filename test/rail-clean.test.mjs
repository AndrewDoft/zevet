// The rail's rows and the user's bubble, as seen in the running app
// 2026-09-22: titles squeezed to "You …", a card over the list, and a
// multi-paragraph prompt flattened to one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const read = (...p) => readFileSync(path.join(ROOT, "board", "src", ...p), "utf8");
const people = read("components", "people.tsx");
const board = read("lib", "board.ts");
const app = read("App.tsx");
const css = read("styles", "masora.css");
const rule = (sel) => css.slice(css.indexOf(sel + " {"), css.indexOf("}", css.indexOf(sel + " {")));

test("a row is mark, title and time; Stop is an icon over the time slot", () => {
  // A bare text child, on a line of its own, is the regression; the aria-label
  // and title attributes carrying the same words are fine.
  assert.ok(!/^\s*\{c\.running \? "Stop" : "Close"\}\s*$/m.test(people), "Stop is text on the row again");
  assert.match(people, /<SquareIcon/);
  assert.match(rule("  .agent-row-stop"), /position: absolute/);
  assert.match(rule("  .agent-row-stop"), /opacity: 0/);
  // Reachable by keyboard: shown on focus, not display:none.
  assert.match(css, /\.agent-row-stop:focus-visible \{ opacity: 1; \}/);
});

test("a console row uses the CLI's title, never agent · model", () => {
  assert.match(people, /blurb: consoleBlurb\(c\)/);
});

test("no card duplicates the rail: a finished run is a dot on its own row", () => {
  assert.ok(!existsSync(path.join(ROOT, "board", "src", "components", "inbox.tsx")));
  assert.ok(!/BackgroundInbox|Running elsewhere/.test(app));
  assert.ok(!css.includes(".rail-inbox"));
  // A dot, not words, and only on a finished run you are not looking at.
  assert.match(people, /c && !c\.running && c\.id && !isOpen && !seenRuns\.includes\(c\.id\)/);
  assert.match(people, /className="agent-row-unseen"/);
  assert.match(rule("  .agent-row-unseen"), /border-radius: 50%/);
  assert.match(css, /\.agent-row-unseen\[data-failed="true"\] \{ background: var\(--alert\); \}/);
});

test("seen is per run, survives a reload, and is marked by what is in front", () => {
  // Keyed by process id (stable across the console replay), not the
  // per-page `key` a reload renumbers.
  assert.match(board, /seenRuns: loadSeenRuns\(\)/);
  assert.match(board, /zStorage\.setItem\(SEEN_RUNS_KEY/);
  assert.ok(!/seenConsole/.test(board));
  // One subscription marks the run in front, only once it has finished — a
  // run you glanced at while it ran and then left still gets its dot.
  assert.match(board, /useBoard\.subscribe\(\(s\) => \{\s*const c = selectActiveConsole\(s\);\s*if \(!c \|\| c\.running \|\| !c\.id/);
});

test("the user's bubble keeps its line breaks", () => {
  assert.match(css, /\.aui-user-message-content \{ white-space: pre-wrap; \}/);
});

test("the working line has no shimmer to erase its first letters", () => {
  assert.match(rule("  .thinking-row .shimmer"), /animation: none/);
});
