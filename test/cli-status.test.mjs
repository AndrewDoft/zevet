// The CLI is the authority on whether a login is live (desktop/cli-status.js).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { interpret, createCliStatus } = require(path.join(ROOT, "desktop", "cli-status.js"));

const CLAUDE_PLAN = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "a@b.c" });

describe("interpret", () => {
  test("claude: JSON loggedIn decides; plan vs key from authMethod", () => {
    assert.deepEqual(interpret("claude", 0, CLAUDE_PLAN), { loggedIn: true, method: "plan", plan: "max", email: "a@b.c" });
    assert.deepEqual(interpret("claude", 0, JSON.stringify({ loggedIn: true, authMethod: "api_key" })), { loggedIn: true, method: "key" });
    assert.deepEqual(interpret("claude", 1, JSON.stringify({ loggedIn: false })), { loggedIn: false });
    assert.deepEqual(interpret("claude", 1, CLAUDE_PLAN), { loggedIn: false }, "a non-zero exit is not logged in");
    assert.deepEqual(interpret("claude", 0, "not json"), { loggedIn: false });
  });
  test("codex: text decides; ChatGPT plan vs API key; Not logged in is not logged in", () => {
    assert.deepEqual(interpret("codex", 0, "Logged in using ChatGPT\n"), { loggedIn: true, method: "plan" });
    assert.deepEqual(interpret("codex", 0, "Logged in using an API key - sk-***"), { loggedIn: true, method: "key" });
    assert.deepEqual(interpret("codex", 1, "Not logged in"), { loggedIn: false });
    assert.deepEqual(interpret("codex", 0, "Not logged in"), { loggedIn: false });
    assert.deepEqual(interpret("codex", 0, ""), { loggedIn: false });
  });
});

describe("createCliStatus", () => {
  const clock = () => { let t = 0; const f = () => t; f.tick = (ms) => { t += ms; }; return f; };

  test("runs the CLI's own status command, once, and caches the answer", async () => {
    const calls = [];
    const s = createCliStatus({ run: async (a, args) => { calls.push([a, ...args]); return { rc: 0, out: CLAUDE_PLAN }; }, now: clock() });
    assert.equal((await s.get("claude")).loggedIn, true);
    assert.equal((await s.get("claude")).loggedIn, true);
    assert.deepEqual(calls, [["claude", "auth", "status"]]);
    await s.get("codex");
    assert.deepEqual(calls[1], ["codex", "login", "status"]);
  });
  test("a revoked login is seen once the TTL passes -- the stale answer is returned without waiting", async () => {
    const now = clock();
    let out = CLAUDE_PLAN;
    const s = createCliStatus({ run: async () => ({ rc: 0, out }), now, ttlMs: 1000 });
    await s.get("claude");
    out = JSON.stringify({ loggedIn: false });
    now.tick(2000);
    assert.equal((await s.get("claude")).loggedIn, true, "stale answer comes back immediately");
    await s.refresh("claude");
    assert.equal(s.peek("claude").loggedIn, false);
    assert.equal((await s.get("claude")).loggedIn, false);
  });
  test("a CLI that cannot run is unknown (null), and never erases a known answer", async () => {
    let r = null;
    const s = createCliStatus({ run: async () => r, now: clock(), waitMs: 20 });
    assert.equal((await s.get("claude")).loggedIn, null);
    r = { rc: 0, out: CLAUDE_PLAN };
    await s.refresh("claude");
    r = null;
    await s.refresh("claude");
    assert.equal(s.peek("claude").loggedIn, true);
  });
  test("the first ask waits a bounded time for a hung CLI, then reports unknown", async () => {
    const s = createCliStatus({ run: () => new Promise(() => {}), waitMs: 30 });
    const t = Date.now();
    assert.equal((await s.get("claude")).loggedIn, null);
    assert.ok(Date.now() - t < 1000);
  });
  test("concurrent asks share one process", async () => {
    let n = 0;
    const s = createCliStatus({ run: async () => { n++; return { rc: 0, out: CLAUDE_PLAN }; } });
    await Promise.all([s.get("claude"), s.get("claude"), s.refresh("claude")]);
    assert.equal(n, 1);
  });
});
