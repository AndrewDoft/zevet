import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const src = readFileSync(path.join(ROOT, "board", "src", "components", "search.tsx"), "utf8");

test("IndexSearch treats a never-built index as onboarding, not a red error", () => {
  assert.match(src, /res\.error === "no index for this workspace yet"/);
  assert.match(src, /setNotBuilt\(true\)/);
  assert.match(src, /Build the index in Settings to search code\./);
  assert.match(src, /notBuilt \? \(/, "renders the onboarding branch ahead of the raw error");
});
