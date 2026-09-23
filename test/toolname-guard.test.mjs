// A tool-call part with no toolName crashed the whole panel on
// `c.toolName.toLowerCase()` — first hit and fixed in knowledge.tsx (see its
// own comment: "took the whole Citations/Reads panel down with it"), then
// found unfixed at five sibling sites during the views.md audit. Source
// assertions: these are TSX render/derive helpers, not meant to be
// unit-rendered outside the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const src = (rel) => readFileSync(path.join(ROOT, "board", "src", "components", rel), "utf8");

const sites = [
  ["knowledge.tsx", "allToolCalls", /if \(typeof c\.toolName === "string" && match\(c\.toolName\.toLowerCase\(\)\)\) out\.push\(c\);/],
  ["agentviews.tsx", "allToolCalls", /if \(typeof c\.toolName === "string" && match\(c\.toolName\.toLowerCase\(\)\)\) out\.push\(c\);/],
  ["graphviews.tsx", "allToolCalls", /if \(typeof c\.toolName === "string" && match\(c\.toolName\.toLowerCase\(\)\)\) out\.push\(c\);/],
  ["graphviews.tsx", "the todo/source-read scan", /if \(typeof c\.toolName !== "string"\) continue;\s*\n\s*const name = c\.toolName\.toLowerCase\(\);/],
  ["moreviews.tsx", "allToolCalls", /if \(typeof c\.toolName === "string" && match\(c\.toolName\.toLowerCase\(\)\)\) out\.push\(c\);/],
  ["moreviews.tsx", "CommandRuns' isBash filter", /typeof c\.toolName === "string" && isBash\(c\.toolName\.toLowerCase\(\)\)/],
  ["provenance.tsx", "groundedIn", /if \(typeof c\.toolName !== "string"\) continue;\s*\n\s*const n = c\.toolName\.toLowerCase\(\);/],
  ["permits.tsx", "shotsWithSteps", /if \(typeof c\.toolName !== "string"\) continue;\s*\n\s*const name = c\.toolName\.toLowerCase\(\);/],
];

for (const [file, where, pattern] of sites) {
  test(`${file}: ${where} guards toolName before .toLowerCase()`, () => {
    assert.match(src(file), pattern);
  });
}

test("no remaining unguarded c.toolName.toLowerCase() anywhere under board/src/components", () => {
  const dir = path.join(ROOT, "board", "src", "components");
  const files = readdirSync(dir).filter((f) => f.endsWith(".tsx"));
  for (const f of files) {
    const text = src(f);
    // A guarded use has `typeof X.toolName` on the same or the previous line;
    // anything else calling `.toolName.toLowerCase()` is unguarded.
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (!/\.toolName\.toLowerCase\(\)/.test(line)) return;
      const window = lines.slice(Math.max(0, i - 1), i + 1).join("\n");
      assert.match(window, /typeof \w+\.toolName/, `${f}:${i + 1} unguarded: ${line.trim()}`);
    });
  }
});
