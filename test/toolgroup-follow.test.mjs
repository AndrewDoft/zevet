// Watching tool calls. Andrew: "when i hit expand on the tool calls ... it
// should autoscroll to the bottom when there is a new tool call". A line of
// text between calls starts a new group, so the group he opened stopped
// growing and the new calls landed below it, collapsed. A group that starts
// while the turn runs now opens if the last one touched was left open.
// Source assertions (no jsdom here — see test/dead-buttons.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const tg = readFileSync(path.join(ROOT, "board", "src", "components", "toolgroup.tsx"), "utf8");

test("a new running group starts open when the last one was left open", () => {
  assert.match(tg, /useState\(\(\) => watching && running\)/);
});

test("opening or closing a group is what sets it", () => {
  const set = tg.slice(tg.indexOf("const setOpen ="), tg.indexOf("const count ="));
  assert.match(set, /watching = v;/);
  assert.match(tg, /onOpenChange=\{setOpen\}/);
});

test("an open group still follows its own calls into view", () => {
  assert.match(tg, /if \(open\) trigger\.current\?\.scrollIntoView\(\{ block: "nearest" \}\);\s*\}, \[open, count\]\);/);
});
