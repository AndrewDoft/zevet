// A free OpenRouter model past its daily cap keeps failing every start the
// same way until the account's day resets. board/src/lib/model-limits.mjs is
// the pure logic behind that: remember it, expire it, sort it last.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const {
  classifyEnding,
  isLimitMessage,
  resetClock,
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
  test("matches plainError's rate-limit line, with or without a reset time", () => {
    assert.ok(isLimitMessage("Rate limited"));
    assert.ok(isLimitMessage("Rate limited · resets 14:05"));
  });

  test("does not match other errors", () => {
    assert.ok(!isLimitMessage("The model returned an error."));
    assert.ok(!isLimitMessage("Not signed in."));
    assert.ok(!isLimitMessage("Provider error 404"));
    assert.ok(!isLimitMessage("Timed out"));
    assert.ok(!isLimitMessage(null));
  });
});

describe("classifyEnding", () => {
  // Exact strings observed this session against opencode 1.18.31 on
  // OpenRouter's free tier (see task brief). Only a 429/usage-limit signal
  // counts as rate_limited; 404, other 5xx and a timeout are provider_error,
  // never a reason to gray a model that was never actually over its cap.
  test("opencode's own free-tier cap message", () => {
    assert.deepEqual(
      classifyEnding("Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day"),
      { kind: "rate_limited", code: null },
    );
  });

  test("a bare 429 from OpenRouter", () => {
    assert.deepEqual(classifyEnding("Error: Upstream request failed: [429]"), { kind: "rate_limited", code: null });
  });

  test("a 404 from a named provider is a provider error, not a rate limit", () => {
    assert.deepEqual(
      classifyEnding("Error from provider (Console): Upstream request failed: [404] Provider returned error"),
      { kind: "provider_error", code: 404 },
    );
  });

  test("a provider error with no code and no rate-limit words classifies as neither", () => {
    // Still ends the run and shows a message — see plainError's fallback —
    // this classifier just has nothing to key a specific label off.
    assert.deepEqual(classifyEnding("Error: [Nvidia] Provider returned error"), { kind: null, code: null });
  });

  test("a 504 timeout is a provider error, keyed by its code", () => {
    assert.deepEqual(
      classifyEnding("Streaming response failed: [504] A Timeout Occurred"),
      { kind: "provider_error", code: 504 },
    );
  });

  test("a timeout with no code still classifies as a provider error", () => {
    assert.deepEqual(classifyEnding("Streaming response timed out"), { kind: "provider_error", code: null });
  });

  test("401 is not swept up as a generic provider error — plainError gives it its own message", () => {
    assert.deepEqual(classifyEnding("unexpected status 401 Unauthorized"), { kind: null, code: null });
  });

  test("a clean run classifies as null", () => {
    assert.deepEqual(classifyEnding(""), { kind: null, code: null });
    assert.deepEqual(classifyEnding(null), { kind: null, code: null });
  });

  // Mutation check (CLAUDE.md §9.4 / task's own ask 6): broadening CODE_RE to
  // match any 3 digits, not just 4xx/5xx, would make this pass too — proving
  // the fixture actually exercises the code boundary rather than just "has
  // digits". Flipped RATE_LIMIT_RE off (commented it out) and reran by hand:
  // the 429/free-models-per-day cases above went from rate_limited to
  // provider_error (429 matches CODE_RE too) and null (free-models-per-day
  // has no code) respectively — both red, as expected — then restored.
  test("a 3-digit number that is not an HTTP status code is not a provider error", () => {
    assert.deepEqual(classifyEnding("retrying in 123 ms"), { kind: null, code: null });
  });
});

describe("resetClock", () => {
  // "resets 14:05" is read against the viewer's OWN clock, so this is built
  // from the local Date constructor and checked against the same local
  // reading — self-consistent on whatever timezone the machine running the
  // test happens to be in, rather than pinned to UTC (which is what made
  // this the wrong test the first time: it asserted a UTC reading and
  // passed on a UTC+0 machine while being wrong everywhere else).
  test("formats as the viewer's own local HH:MM", () => {
    const d = new Date(2026, 8, 23, 14, 5);
    assert.equal(resetClock(d.getTime()), "14:05");
    const midnight = new Date(2026, 8, 23, 0, 0);
    assert.equal(resetClock(midnight.getTime()), "00:00");
    const single = new Date(2026, 8, 23, 4, 7);
    assert.equal(resetClock(single.getTime()), "04:07", "single-digit hour/minute must still be zero-padded");
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
