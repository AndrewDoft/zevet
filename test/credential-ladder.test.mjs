// The pure ladder decision (desktop/credential-ladder.js). No fetch, no fs,
// no Electron — just the arithmetic, against the exact example ladder from
// D-0NN's own worked cases.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { choose } = require(path.join(ROOT, "desktop", "credential-ladder.js"));

const LADDER = [
  { credentialId: "e1", untilPct: 50 },
  { credentialId: "e2", untilPct: 80 },
  { credentialId: "e1", untilPct: 99 },
  { credentialId: "e2", untilPct: 100 },
];

describe("choose", () => {
  test("the exact worked example: (0.1, 0) -> e1", () => {
    assert.equal(choose(LADDER, { e1: 0.1, e2: 0 }), "e1");
  });

  test("the exact worked example: (0.5, 0) -> e2", () => {
    assert.equal(choose(LADDER, { e1: 0.5, e2: 0 }), "e2");
  });

  test("the exact worked example: (0.6, 0.8) -> e1", () => {
    assert.equal(choose(LADDER, { e1: 0.6, e2: 0.8 }), "e1");
  });

  test("the exact worked example: (0.99, 0.9) -> e2", () => {
    assert.equal(choose(LADDER, { e1: 0.99, e2: 0.9 }), "e2");
  });

  test("hitting a ceiling exactly rolls to the next rung, does not stay", () => {
    // e1 at exactly 50% against a 50 ceiling: 50 < 50 is false.
    assert.equal(choose(LADDER, { e1: 0.5, e2: 0.79 }), "e2");
  });

  test("a step with unknown usage (probe failed) is skipped, not treated as empty or full", () => {
    assert.equal(choose(LADDER, { e2: 0 }), "e2", "e1's usage is absent, so its two rungs are skipped entirely");
  });

  test("every rung exhausted (or unknown) falls onto the last step regardless of its own usage", () => {
    assert.equal(choose(LADDER, { e1: 1, e2: 1 }), "e2");
    assert.equal(choose(LADDER, {}), "e2", "no usage known for anything");
  });

  test("an empty ladder chooses nothing", () => {
    assert.equal(choose([], { e1: 0 }), null);
    assert.equal(choose(undefined, {}), null);
  });

  test("a single-step ladder that qualifies is chosen immediately", () => {
    assert.equal(choose([{ credentialId: "only", untilPct: 100 }], { only: 0.3 }), "only");
  });
});
