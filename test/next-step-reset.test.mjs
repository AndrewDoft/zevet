// NextStep's useState("idle") was never reset when the agent's plan moved
// to a different pending todo, so the card kept showing "Sent" for a
// recommendation nobody had accepted, with no way to accept the real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const src = readFileSync(path.join(ROOT, "board", "src", "components", "moreviews.tsx"), "utf8");
const fn = src.slice(src.indexOf("export function NextStep"), src.indexOf("export function NextStep") + 900);

test("NextStep resets its accepted state when the pending todo's text changes", () => {
  assert.match(fn, /useEffect\(\(\) => \{\s*setState\("idle"\);\s*\}, \[text\]\);/);
  // The effect must run before any conditional return (rules of hooks).
  const effectAt = fn.indexOf("useEffect(");
  const returnAt = fn.indexOf("if (!pending || !text) return null;");
  assert.ok(effectAt > 0 && effectAt < returnAt, "useEffect must precede the early return");
});
