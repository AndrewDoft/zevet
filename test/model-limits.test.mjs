// A free OpenRouter model past its daily cap keeps failing every start the
// same way until the account's day resets. board/src/lib/model-limits.mjs is
// the pure logic behind that: remember it, expire it, sort it last.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const {
  isLimitMessage,
  resetFromPayload,
  recordModelLimit,
  clearModelLimit,
  modelLimitedUntil,
  sortByLimit,
} = await import(pathToFileURL(path.join(ROOT, "board", "src", "lib", "model-limits.mjs")).href);

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    map,
  };
}

describe("isLimitMessage", () => {
  test("matches plainError's two limit sentences", () => {
    assert.ok(isLimitMessage("Gemma 4 31B hit its free daily limit."));
    assert.ok(isLimitMessage("Sonnet 5 hit its usage limit."));
  });

  test("does not match other errors", () => {
    assert.ok(!isLimitMessage("The model returned an error."));
    assert.ok(!isLimitMessage("Not signed in."));
    assert.ok(!isLimitMessage(null));
  });
});

describe("resetFromPayload", () => {
  test("reads OpenRouter's X-RateLimit-Reset off opencode's captured shape", () => {
    const payload = {
      error: { data: { responseHeaders: { "x-ratelimit-reset": "1790121600000" } } },
    };
    assert.equal(resetFromPayload(payload), 1790121600000);
  });

  test("null when there is nothing to read", () => {
    assert.equal(resetFromPayload({ error: { data: {} } }), null);
    assert.equal(resetFromPayload({}), null);
    assert.equal(resetFromPayload(null), null);
  });
});

describe("recordModelLimit / modelLimitedUntil / clearModelLimit", () => {
  test("a recorded limit is seen until its reset time", () => {
    const s = fakeStorage();
    const now = Date.UTC(2026, 8, 22, 12, 0, 0);
    recordModelLimit(s, "openrouter/google/gemma-4-31b-it:free", now + 60_000, now);
    assert.equal(modelLimitedUntil(s, "openrouter/google/gemma-4-31b-it:free", now), now + 60_000);
    // past the reset time, it clears itself
    assert.equal(modelLimitedUntil(s, "openrouter/google/gemma-4-31b-it:free", now + 61_000), null);
  });

  test("no reset time falls back to the next UTC midnight", () => {
    const s = fakeStorage();
    const now = Date.UTC(2026, 8, 22, 15, 30, 0);
    recordModelLimit(s, "m", null, now);
    assert.equal(modelLimitedUntil(s, "m", now), Date.UTC(2026, 8, 23, 0, 0, 0));
  });

  test("a model never recorded is not limited", () => {
    const s = fakeStorage();
    assert.equal(modelLimitedUntil(s, "never-seen"), null);
  });

  test("clearModelLimit forgets the mark, e.g. after a run succeeds", () => {
    const s = fakeStorage();
    const now = Date.now();
    recordModelLimit(s, "m", now + 60_000, now);
    clearModelLimit(s, "m");
    assert.equal(modelLimitedUntil(s, "m", now), null);
  });

  test("a corrupt store is treated as empty, not thrown", () => {
    const s = fakeStorage();
    s.setItem("zevet.modelLimits.v1", "{not json");
    assert.equal(modelLimitedUntil(s, "m"), null);
    recordModelLimit(s, "m", Date.now() + 60_000);
    assert.ok(modelLimitedUntil(s, "m") !== null);
  });
});

describe("sortByLimit", () => {
  test("limited models sink below the rest, order otherwise kept", () => {
    const s = fakeStorage();
    const now = Date.now();
    recordModelLimit(s, "b", now + 60_000, now);
    const sorted = sortByLimit(["a", "b", "c", "d"], s, now);
    assert.deepEqual(sorted, ["a", "c", "d", "b"]);
  });

  test("nothing limited keeps the original order", () => {
    const s = fakeStorage();
    assert.deepEqual(sortByLimit(["a", "b", "c"], s), ["a", "b", "c"]);
  });

  test("more than one limited model keeps them in their own relative order", () => {
    const s = fakeStorage();
    const now = Date.now();
    recordModelLimit(s, "a", now + 60_000, now);
    recordModelLimit(s, "c", now + 60_000, now);
    assert.deepEqual(sortByLimit(["a", "b", "c", "d"], s, now), ["b", "d", "a", "c"]);
  });
});
