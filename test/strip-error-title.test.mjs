import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const src = readFileSync(path.join(ROOT, "board", "src", "components", "strip.tsx"), "utf8");

test("a clipped localError segment carries its full text as a title", () => {
  assert.match(src, /<Sp cls="bad" text=\{localError\} title=\{localError\} \/>/);
});
