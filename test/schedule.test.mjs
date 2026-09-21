// Agent runs on a clock.
//
// A schedule is the spawn zevet could already do, triggered by a timer instead
// of a click — so the risk is not the capability, it is the two ways an
// unattended timer goes wrong: running without anyone there to answer a
// permission prompt, and catching up on everything it missed while the laptop
// was asleep. Both are decided in schedule.js, which is why the pure parts
// live there and are tested here.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const schedule = require(path.join(ROOT, "desktop", "schedule.js"));

const NOW = 1_700_000_000_000;
const make = (over = {}) =>
  schedule.sanitise({ prompt: "run the tests", root: "C:/repo", ...over }, NOW);

describe("a schedule cannot skip permissions", () => {
  test("dangerous is downgraded, not honoured", () => {
    // Unattended AND unprompted is the combination worth refusing: the whole
    // point of a permission prompt is that somebody is there to answer it.
    assert.equal(make({ mode: "dangerous" }).mode, "auto");
  });

  test("every other posture is kept", () => {
    for (const mode of ["plan", "ask", "auto"]) {
      assert.equal(make({ mode }).mode, mode);
    }
  });
});

describe("a missed window does not become a queue", () => {
  test("the next run is measured from now, not from when it was due", () => {
    // A laptop asleep for six hours comes back with ONE overdue schedule. If
    // next were computed from the last due time, it would come back with
    // twenty-four queued runs and spend a day's quota in a minute.
    const s = make({ cadence: "15m", nextAt: NOW - 6 * 60 * 60 * 1000 });
    const after = schedule.advance(s, true, NOW);
    assert.equal(after.nextAt, NOW + 15 * 60_000);
  });

  test("firing records whether it worked", () => {
    const after = schedule.advance(make(), false, NOW);
    const last = after.history[after.history.length - 1];
    assert.equal(last.ok, false);
    assert.equal(last.at, NOW);
  });

  test("history does not grow without bound", () => {
    let s = make();
    for (let i = 0; i < schedule.MAX_HISTORY + 10; i += 1) s = schedule.advance(s, true, NOW + i);
    assert.equal(s.history.length, schedule.MAX_HISTORY);
  });
});

describe("what is due", () => {
  test("a disabled schedule is never due", () => {
    const s = make({ enabled: false, nextAt: NOW - 1 });
    assert.deepEqual(schedule.due([s], NOW), []);
  });

  test("a future schedule is not due", () => {
    assert.deepEqual(schedule.due([make({ nextAt: NOW + 1000 })], NOW), []);
  });

  test("an overdue schedule is due exactly once", () => {
    const s = make({ nextAt: NOW - 1000 });
    assert.equal(schedule.due([s], NOW).length, 1);
    assert.equal(schedule.due([schedule.advance(s, true, NOW)], NOW).length, 0);
  });
});

describe("a new schedule does not fire the moment you save it", () => {
  test("the first run is one cadence away", () => {
    // Running as you press save is a surprise, not a schedule.
    const s = make({ cadence: "1h" });
    assert.equal(s.nextAt, NOW + 60 * 60_000);
    assert.deepEqual(schedule.due([s], NOW), []);
  });
});

describe("a record off disk is coerced, never trusted", () => {
  test("a hand-edited file does not crash the app at startup", () => {
    for (const junk of [null, 7, "nope", [], { prompt: 42, history: "no" }]) {
      const s = schedule.sanitise(junk, NOW);
      assert.equal(typeof s.id, "string");
      assert.equal(typeof s.prompt, "string");
      assert.ok(Array.isArray(s.history));
      assert.ok(s.nextAt > 0);
    }
  });

  test("an unknown cadence falls back rather than producing NaN", () => {
    const s = make({ cadence: "every fortnight" });
    assert.ok(schedule.CADENCES.some((c) => c.id === s.cadence));
    assert.ok(Number.isFinite(schedule.advance(s, true, NOW).nextAt));
  });

  test("a prompt is capped", () => {
    assert.ok(make({ prompt: "x".repeat(99_999) }).prompt.length <= 4000);
  });
});

describe("the module ships", () => {
  test("schedule.js is in the packaged files", () => {
    // A require() added to main.js without adding the file to build.files
    // produces an app that crashes on launch and a build that succeeded.
    const pkg = JSON.parse(
      readFileSyncSafe(path.join(ROOT, "desktop", "package.json")),
    );
    assert.ok(pkg.build.files.includes("schedule.js"));
  });
});

function readFileSyncSafe(p) {
  return require("node:fs").readFileSync(p, "utf8");
}
