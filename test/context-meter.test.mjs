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
const choice = readFileSync(path.join(ROOT, "board", "src", "components", "model-choice.tsx"), "utf8");
const modelsLib = await import(pathToFileURL(path.join(ROOT, "board", "src", "lib", "models.mjs")).href);

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

  test("with a console in front, the picker stays and shows that console's model", () => {
    // The launch picker's default read "Opus 5.5" over a Sonnet 5 run. The
    // picker must stay live mid-run (Andrew: "you should still be able to
    // choose model and effort and posture"), so it is not swapped for a label.
    const { runningModelName } = modelsLib;
    const sonnet = { agent: "claude", model: "claude-opus-5-5", usage: { model: "claude-sonnet-5" } };
    assert.equal(runningModelName(sonnet.usage.model, sonnet.model), "Sonnet 5");
    assert.match(controls, /const model = active \? runningModelName\(active\.usage\.model, active\.model\) : "";/);
    // Rendered unconditionally — not behind `active ?` — and handed the running model.
    assert.match(controls, /<div className=\{compactModelChoice\}>\s*<ModelChoice\s+agents=\{usable\}\s+running=\{\s*active\s*\?\s*\{ id: `\$\{active\.agent\}:\$\{active\.usage\.model \|\| active\.model\}`, name: model/);
    assert.ok(!/\{active \? \([\s\S]{0,80}<span[^>]*>\s*\{model\}/.test(controls), "the picker is swapped for a label again");
    // The trigger shows that name instead of the launch default.
    assert.match(choice, /\{running \? \([\s\S]*?\{running\.name\}[\s\S]*?\) : \(\s*<ModelSelectorValue \/>/);
    assert.match(choice, /value=\{running && all\.some\(\(m\) => m\.id === running\.id\) \? running\.id : selected\}/);
  });
});
