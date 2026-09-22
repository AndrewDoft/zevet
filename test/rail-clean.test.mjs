// The rail's rows, the inbox card and the user's bubble, as seen in the
// running app 2026-09-22: titles squeezed to "You …", a card over the list,
// and a multi-paragraph prompt flattened to one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const read = (...p) => readFileSync(path.join(ROOT, "board", "src", ...p), "utf8");
const people = read("components", "people.tsx");
const inbox = read("components", "inbox.tsx");
const css = read("styles", "masora.css");
const rule = (sel) => css.slice(css.indexOf(sel + " {"), css.indexOf("}", css.indexOf(sel + " {")));

test("a row is mark, title and time; Stop is an icon over the time slot", () => {
  assert.ok(!people.includes('"Stop" : "Close"}\n'), "Stop is text on the row again");
  assert.match(people, /<SquareIcon/);
  assert.match(rule("  .agent-row-stop"), /position: absolute/);
  assert.match(rule("  .agent-row-stop"), /opacity: 0/);
  // Reachable by keyboard: shown on focus, not display:none.
  assert.match(css, /\.agent-row-stop:focus-visible \{ opacity: 1; \}/);
});

test("a console row and the inbox use the CLI's title, never agent · model", () => {
  assert.match(people, /blurb: consoleBlurb\(c\)/);
  assert.match(inbox, /title: consoleBlurb\(c\)/);
  assert.ok(!inbox.includes("`${c.agent} · ${c.model}`"));
});

test("the inbox card is bounded and scrolls instead of taking the list's space", () => {
  assert.match(inbox, /className="rail-inbox"/);
  const r = rule("  .rail-inbox");
  assert.match(r, /flex: none/);
  assert.match(r, /max-height:/);
  assert.match(r, /overflow-y: auto/);
});

test("the user's bubble keeps its line breaks", () => {
  assert.match(css, /\.aui-user-message-content \{ white-space: pre-wrap; \}/);
});

test("the working line has no shimmer to erase its first letters", () => {
  assert.match(rule("  .thinking-row .shimmer"), /animation: none/);
});
