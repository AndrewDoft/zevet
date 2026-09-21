// Times, in both directions.
//
// The same list can hold a commit (past) and a scheduled run (future), so this
// never assumes a direction the caller did not state. `agoText` in text.mjs
// answers a different question — how long ago, against a server clock — and is
// not a substitute.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { ROOT } from "./helpers.mjs";

const schedule = createRequire(import.meta.url)(path.join(ROOT, "desktop", "schedule.js"));

const { cadenceLabel, whenText } = await import(
  pathToFileURL(path.join(ROOT, "board", "src", "lib", "when.mjs")).href
);

const NOW = 1_700_000_000_000;
const MIN = 60_000;

describe("a moment reads forwards and backwards", () => {
  test("the past says ago", () => {
    assert.equal(whenText(NOW - 5 * MIN, NOW), "5m ago");
    assert.equal(whenText(NOW - 3 * 60 * MIN, NOW), "3h ago");
    assert.equal(whenText(NOW - 2 * 24 * 60 * MIN, NOW), "2d ago");
  });

  test("the future says in", () => {
    assert.equal(whenText(NOW + 7 * 60 * MIN, NOW), "in 7h");
    assert.equal(whenText(NOW + 12 * MIN, NOW), "in 12m");
  });

  test("either side of a minute is just now", () => {
    // "in 3s" is noise and "0m ago" reads as broken.
    assert.equal(whenText(NOW + 3000, NOW), "just now");
    assert.equal(whenText(NOW - 3000, NOW), "just now");
  });
});

describe("a time it cannot read is blank, not wrong", () => {
  for (const bad of [0, -1, NaN, undefined, null, "soon"]) {
    test(`${JSON.stringify(bad)} produces nothing`, () => {
      assert.equal(whenText(bad, NOW), "");
    });
  }
});

describe("cadence labels", () => {
  test("the ids desktop/schedule.js offers all have a label", () => {
    // If a cadence is added there and not here, the id itself is shown rather
    // than a wrong label — checked, because a silent mislabel on a schedule
    // says it runs at a time it does not.
    for (const c of schedule.CADENCES) {
      assert.notEqual(cadenceLabel(c.id), c.id, `cadence "${c.id}" has no label in when.mjs`);
    }
  });

  test("an unknown id falls back to itself", () => {
    assert.equal(cadenceLabel("every fortnight"), "every fortnight");
    assert.equal(cadenceLabel(undefined), "");
  });
});
