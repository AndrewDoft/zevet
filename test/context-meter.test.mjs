// The composer's context ring, and why it once read "354k/200k".
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const { contextShare, CONTEXT_FLOOR } = await import(
  pathToFileURL(path.join(ROOT, "board", "src", "lib", "meter.mjs")).href
);
const board = readFileSync(path.join(ROOT, "board", "src", "lib", "board.ts"), "utf8");
const controls = readFileSync(path.join(ROOT, "board", "src", "components", "composercontrols.tsx"), "utf8");

describe("contextShare", () => {
  test("is used over the reported window, else over the 200k floor", () => {
    assert.equal(contextShare(100_000, 1_000_000), 0.1);
    assert.equal(contextShare(50_000, null), 50_000 / CONTEXT_FLOOR);
    assert.equal(CONTEXT_FLOOR, 200_000);
  });

  test("never passes full, never goes negative", () => {
    // A 1M-window model past 200k before its window is reported.
    assert.equal(contextShare(354_000, null), 1);
    assert.equal(contextShare(0, 200_000), 0);
    assert.equal(contextShare(null, 200_000), 0);
    assert.equal(contextShare(-5, 200_000), 0);
  });
});

describe("running totals are not the context", () => {
  test("usageOf ignores claude's result and codex's turn.completed", () => {
    // Both carry cumulative usage; read as the context they exceed the window.
    const fn = board.slice(board.indexOf("function usageOf("));
    assert.match(fn, /if \(payload\.type === "result" \|\| payload\.type === "turn\.completed"\) return null;/);
  });

  test("codex's real context comes off its rollout file", () => {
    const fn = board.slice(board.indexOf("export async function pollConsoleFiles("));
    assert.match(fn, /bridge\.local\.sessionLive/);
    assert.match(fn, /c\.title = r\.title/);
    assert.match(fn, /recordUsage\(/);
  });
});

describe("the composer shows one model label", () => {
  test("no second model name or mono numbers beside the picker", () => {
    assert.ok(!controls.includes("<AgentLogo"), "the running model's mark is back beside the picker");
    assert.ok(!/\{tokens\(usage\.context\)\}\/\{tokens\(window\)\}/.test(controls), "the 354k/200k text is back");
    assert.match(controls, /<ContextRing share=\{share\} label=\{detail\} \/>/);
  });
});
