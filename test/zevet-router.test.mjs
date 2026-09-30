// The Zevet model: ladder, heuristic, handoff, limit detection, fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../desktop/zevet-router.js");
const { OPENCODE_FREE_MODELS } = await import("../board/src/lib/models.generated.mjs");
const { describeModel } = await import("../board/src/lib/models.mjs");

// Shaped like ~/.codex/models_cache.json after agent-catalogs.codexModels().
const CODEX = [
  { id: "gpt-6-astra", name: "GPT-6-Astra", note: "Frontier intelligence for the most demanding work." },
  { id: "gpt-6-sol", name: "GPT-6-Sol", note: "Previous generation workhorse model." },
  { id: "gpt-6-luna", name: "GPT-6-Luna", note: "Fast and affordable model for easier tasks." },
  { id: "gpt-5.6-luna", name: "GPT-5.6-Luna", note: "Older fast and efficient model." },
];
const CLAUDE = [
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5" },
];
const ALL = { has: { claude: true, codex: true, opencode: true }, claude: CLAUDE, codex: CODEX, opencode: [...OPENCODE_FREE_MODELS] };
const ids = (l) => l.map((r) => r.id);

test("ladder: haiku, codex's plainest, then open models; hard turns start on sonnet", () => {
  const l = R.buildLadder(ALL);
  assert.deepEqual(ids(l.easy).slice(0, 3), ["claude:claude-haiku-4-5-20251001", "codex:gpt-6-luna", `opencode:${R.OPEN_MODELS[0][0]}`]);
  assert.equal(l.hard[0].id, "claude:sonnet");
  assert.deepEqual(ids(l.hard).slice(1), ids(l.easy));
});

test("ladder: only rungs that exist on this machine", () => {
  assert.deepEqual(ids(R.buildLadder({ ...ALL, has: { codex: true } }).easy), ["codex:gpt-6-luna"]);
  // No claude: no sonnet escalation either.
  assert.deepEqual(R.buildLadder({ ...ALL, has: { codex: true } }).hard, R.buildLadder({ ...ALL, has: { codex: true } }).easy);
  // codex with no catalogue: its model is looked up, never guessed.
  assert.deepEqual(ids(R.buildLadder({ ...ALL, has: { codex: true }, codex: null }).easy), []);
  // An open model the CLI does not list is not a rung.
  const only = R.buildLadder({ ...ALL, has: { opencode: true }, opencode: ["opencode/nemotron-3-ultra-free"] });
  assert.deepEqual(ids(only.easy), ["opencode:opencode/nemotron-3-ultra-free"]);
  assert.deepEqual(ids(R.buildLadder({ has: {} }).easy), []);
});

test("open rungs are real, current, and do not train on prompts", () => {
  for (const [id] of R.OPEN_MODELS) {
    assert.ok(OPENCODE_FREE_MODELS.includes(id), `${id} is not in models.generated.mjs`);
    assert.equal(describeModel(id).trains, false, `${id} may train on prompts`);
  }
});

test("classifyTurn: short questions are easy; long, planning, multi-file are hard", () => {
  assert.equal(R.classifyTurn("what does this function return?"), "easy");
  assert.equal(R.classifyTurn("rename foo to bar in index.js"), "easy");
  assert.equal(R.classifyTurn("x".repeat(701)), "hard");
  assert.equal(R.classifyTurn("a\n".repeat(13)), "hard");
  assert.equal(R.classifyTurn("plan the auth change"), "hard");
  assert.equal(R.classifyTurn("make a.js, b.js and lib/c.ts agree"), "hard");
  assert.equal(R.classifyTurn("fix the typo in a.js"), "easy");
});

test("composeHandoff: no history is the bare prompt; history is delimited, then the request", () => {
  assert.equal(R.composeHandoff([], "hi"), "hi");
  const h = R.composeHandoff([{ user: "q1", answer: "a1" }, { user: "q2", answer: "a2" }], "now this");
  assert.match(h, /<<<earlier\nUser: q1\nAnswer: a1\n\nUser: q2\nAnswer: a2\n>>>\n\nnow this$/);
});

test("composeHandoff: each side is clipped and the oldest turns go first, newest kept", () => {
  const long = "z".repeat(5000);
  const one = R.composeHandoff([{ user: long, answer: long }], "p");
  assert.ok(one.length < 3400, "a side is capped");
  assert.match(one, / …/);
  const turns = Array.from({ length: 10 }, (_, i) => ({ user: `u${i}`, answer: "y".repeat(500) }));
  const h = R.composeHandoff(turns, "p", 1500);
  assert.match(h, /earlier turns? omitted/);
  assert.ok(h.includes("u9") && !h.includes("u0"), "newest kept, oldest dropped");
});

test("limitOf: claude", () => {
  const rej = { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1789972800 } };
  assert.deepEqual(R.limitOf("claude", rej), { resetAt: 1789972800 * 1000, wide: true });
  assert.equal(R.limitOf("claude", { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } }), null);
  assert.equal(R.limitOf("claude", { type: "rate_limit_event", rate_limit_info: { status: "allowed" } }), null);
  const r429 = { type: "result", is_error: true, result: 'API Error: 429 {"type":"rate_limit_error"}' };
  assert.ok(R.limitOf("claude", r429));
  assert.equal(R.limitOf("claude", { type: "result", is_error: true, result: "API Error: 500" }), null);
  // The model merely talking about limits is not a limit.
  assert.equal(R.limitOf("claude", { type: "assistant", message: { content: [{ type: "text", text: "rate limit 429" }] } }), null);
});

test("limitOf: codex", () => {
  assert.ok(R.limitOf("codex", { type: "error", error: { message: "usage limit reached" } }));
  assert.ok(R.limitOf("codex", { type: "turn.failed", error: { message: "usage limit reached" } }));
  // codex's non-fatal notice arrives as an item and is not a limit.
  assert.equal(R.limitOf("codex", { type: "item.completed", item: { type: "error", message: "rate limit notice" } }), null);
  assert.equal(R.limitOf("codex", { type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } }), null);
});

test("limitOf: opencode event and stderr", () => {
  const ev = {
    type: "error",
    error: { data: { message: "Rate limit exceeded: free-models-per-day", responseHeaders: { "x-ratelimit-reset": "1789972800000" } } },
  };
  assert.deepEqual(R.limitOf("opencode", ev), { resetAt: 1789972800000, wide: true });
  assert.deepEqual(R.limitOf("opencode", { type: "error", error: { data: { message: "Upstream request failed: [429]" } } }), { resetAt: null, wide: false });
  assert.equal(R.limitOf("opencode", { type: "error", error: { data: { message: "[404] not found" } } }), null);
  assert.ok(R.limitOfStderr("Error: Upstream request failed: [429]"));
  assert.ok(R.limitOfStderr("Rate limit exceeded: free-models-per-day"));
  assert.equal(R.limitOfStderr("Error: [Nvidia] Provider returned error"), null);
});

test("TurnReader: answer and session per backend", () => {
  const c = new R.TurnReader("claude");
  c.push({ type: "system", session_id: "S1" });
  c.push({ type: "assistant", message: { content: [{ type: "text", text: "draft" }] } });
  assert.equal(c.finished, false);
  c.push({ type: "result", result: "final", session_id: "S1" });
  assert.deepEqual([c.session, c.answer, c.finished], ["S1", "final", true]);
  const x = new R.TurnReader("codex");
  x.push({ type: "thread.started", thread_id: "T1" });
  assert.equal(x.push({ type: "item.completed", item: { type: "agent_message", text: "hello" } }), true);
  assert.deepEqual([x.session, x.answer], ["T1", "hello"]);
  const o = new R.TurnReader("opencode");
  o.push({ type: "step_start", sessionID: "O1" });
  o.push({ type: "text", part: { type: "text", text: "he" } });
  o.push({ type: "text", part: { type: "text", text: "llo" } });
  assert.deepEqual([o.session, o.answer], ["O1", "hello"]);
});

// --- the console -----------------------------------------------------------

/** A scripted backend. script(rung, prompt, n) -> array of events; the last may be {exit:true}. */
function harness(ladderIn, script, { clock = { t: 1_000_000 } } = {}) {
  const events = [];
  const starts = [];
  const prompts = [];
  const count = {};
  const start = (r, extra) => {
    starts.push({ rung: r.id, resumeFrom: extra.resumeFrom });
    if (script.refuse && script.refuse(r)) return { ok: false, error: "nope" };
    let dead = false;
    return {
      ok: true,
      send(prompt) {
        prompts.push({ rung: r.id, prompt });
        const n = (count[r.id] = (count[r.id] || 0) + 1);
        const evts = script.turn(r, prompt, n);
        setImmediate(() => {
          for (const e of evts) {
            if (dead) return;
            if (e.exit) {
              dead = true;
              extra.onEvent({ type: "exit", code: 0, signal: null });
            } else extra.onEvent(e);
          }
        });
        return { ok: true };
      },
      stop() {
        dead = true;
        return { ok: true };
      },
    };
  };
  const console_ = R.startRouted({ start, ladder: () => ladderIn, onEvent: (e) => events.push(e), now: () => clock.t });
  const done = async (sends) => {
    for (const s of sends) {
      const before = events.length;
      console_.send(s);
      // wait for the turn to settle: an event batch that ends the turn
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setImmediate(r));
        const seen = events.slice(before).map((e) => e.payload && e.payload.type);
        if (seen.some((t) => t === "result" || t === "turn.completed" || t === "error") || seen.includes("step_finish")) break;
      }
      await new Promise((r) => setImmediate(r));
    }
  };
  return { console: console_, events, starts, prompts, done, clock };
}

const claudeTurn = (text, sid = "CS") => [
  { type: "agent", payload: { type: "system", session_id: sid } },
  { type: "agent", payload: { type: "assistant", session_id: sid, message: { content: [{ type: "text", text }] } } },
  { type: "agent", payload: { type: "result", session_id: sid, result: text } },
];
const codexTurn = (text) => [
  { type: "agent", payload: { type: "thread.started", thread_id: "XT" } },
  { type: "agent", payload: { type: "item.completed", item: { type: "agent_message", text } } },
  { type: "agent", payload: { type: "turn.completed" } },
  { exit: true },
];
const ladder2 = R.buildLadder({ ...ALL, has: { claude: true, codex: true } });

test("routed: consecutive turns on one backend resume it and send no handoff", async () => {
  const h = harness(ladder2, { turn: (r, p, n) => claudeTurn(`a${n}`) });
  await h.done(["one?", "two?"]);
  assert.equal(h.starts.length, 1, "the warm claude process is reused");
  assert.deepEqual(h.prompts.map((p) => p.prompt), ["one?", "two?"]);
  assert.equal(h.events.filter((e) => e.payload?.type === "zevet_route").length, 2);
  assert.ok(h.events.filter((e) => e.type === "agent" && e.payload.type === "result").every((e) => e.agent === "claude"));
});

test("routed: a new backend gets the earlier turns as a handoff, and resumes its own session after", async () => {
  // claude answers easy turns; make the second turn hard -> sonnet is also claude, so limit claude first
  const script = { turn: (r, p, n) => (r.agent === "claude" ? claudeTurn(`c${n}`) : codexTurn(`x${n}`)) };
  const h = harness(ladder2, script);
  await h.done(["first?"]);
  h.console._state.limits.set("claude", h.clock.t + 60_000); // claude limited from here on
  await h.done(["second?", "third?"]);
  const codex = h.prompts.filter((p) => p.rung === "codex:gpt-6-luna");
  assert.match(codex[0].prompt, /<<<earlier\nUser: first\?\nAnswer: c1\n>>>\n\nsecond\?$/);
  // Third turn: codex resumes its own session; it has seen turn 2 itself and only lacks claude's turn 1.
  assert.match(codex[1].prompt, /User: first\?/);
  assert.ok(!codex[1].prompt.includes("User: second?"));
  assert.equal(h.starts.filter((s) => s.rung === "codex:gpt-6-luna")[1].resumeFrom, "XT");
});

test("routed: a rate-limited rung is skipped and the SAME turn re-runs on the next, invisibly", async () => {
  const reset = Math.floor((1_000_000 + 3_600_000) / 1000);
  const script = {
    turn: (r, p, n) =>
      r.agent === "claude"
        ? [
            { type: "agent", payload: { type: "system", session_id: "CS" } },
            { type: "agent", payload: { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: reset } } },
            { type: "agent", payload: { type: "result", is_error: true, result: 'API Error: 429 {"type":"rate_limit_error"}' } },
          ]
        : codexTurn("from codex"),
  };
  const h = harness(ladder2, script);
  await h.done(["what is 2+2?"]);
  assert.deepEqual(h.prompts.map((p) => p.rung), ["claude:claude-haiku-4-5-20251001", "codex:gpt-6-luna"]);
  assert.equal(h.prompts[1].prompt, "what is 2+2?", "no history yet, so nothing to hand off");
  const shown = h.events.filter((e) => e.type === "agent").map((e) => e.payload.type);
  assert.ok(!shown.includes("rate_limit_event") && !shown.includes("result"), "the failed attempt is not shown");
  assert.ok(shown.includes("turn.completed"));
  assert.equal(h.events.find((e) => e.payload?.type === "zevet_route").payload.label, "GPT-6-Luna");
  assert.equal(h.console._state.limits.get("claude"), reset * 1000);
  // and the next turn goes straight to codex
  await h.done(["again?"]);
  assert.equal(h.starts.filter((s) => s.rung.startsWith("claude")).length, 1);
});

test("routed: an unknown reset means 15 minutes, then the rung is back", async () => {
  const script = {
    turn: (r, p, n) =>
      r.agent === "claude" && n === 1
        ? [{ type: "agent", payload: { type: "result", is_error: true, result: "API Error: 429" } }]
        : r.agent === "claude" ? claudeTurn("back") : codexTurn("x"),
  };
  const clock = { t: 5_000_000 };
  const h = harness(ladder2, script, { clock });
  await h.done(["q1"]);
  assert.equal(h.console._state.limits.get("claude"), 5_000_000 + R.DEFAULT_RESET_MS);
  clock.t += R.DEFAULT_RESET_MS + 1;
  await h.done(["q2"]);
  assert.equal(h.prompts.at(-1).rung, "claude:claude-haiku-4-5-20251001");
});

test("routed: every rung limited says so in one line with the earliest reset", async () => {
  const at1 = 9_000_000;
  const at2 = 8_000_000;
  const script = {
    turn: (r) =>
      r.agent === "claude"
        ? [{ type: "agent", payload: { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: at1 / 1000 } } }, { type: "agent", payload: { type: "result", is_error: true, result: "429" } }]
        : [{ type: "agent", payload: { type: "error", error: { message: "usage limit reached" } } }, { exit: true }],
  };
  const clock = { t: 1_000_000 };
  const h = harness(ladder2, script, { clock });
  h.console._state.limits.set("codex", at2);
  await h.done(["hi"]);
  const last = h.events.at(-1);
  assert.equal(last.payload.type, "error");
  assert.match(last.payload.error.data.message, /Rate limit exceeded on every model/);
  assert.equal(last.payload.error.data.responseHeaders["x-ratelimit-reset"], String(at2));
});

test("routed: a rung that will not start falls through instead of failing the turn", async () => {
  const h = harness(ladder2, { refuse: (r) => r.agent === "claude", turn: () => codexTurn("ok") });
  await h.done(["hi"]);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].rung, "codex:gpt-6-luna");
});

test("routed: a hard turn starts on sonnet", async () => {
  const h = harness(ladder2, { turn: () => claudeTurn("done") });
  await h.done(["plan the whole migration"]);
  assert.equal(h.prompts[0].rung, "claude:sonnet");
});

test("routed: stop ends the console once", () => {
  const h = harness(ladder2, { turn: () => claudeTurn("x") });
  h.console.stop();
  assert.deepEqual(h.console.stop(), { ok: true, alreadyStopped: true });
  assert.equal(h.events.filter((e) => e.type === "exit").length, 1);
  assert.equal(h.console.send("x").ok, false);
});

test("main.js starts a routed console for agent zevet, and only claude rungs get claude's options", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../desktop/main.js", import.meta.url), "utf8");
  assert.match(src, /isZevet \? startZevetConsole\(spec, claudeOnly\) : instrumentedStartConsole\(spec\)/);
  assert.match(src, /\.\.\.\(isZevet \? \{\} : claudeOnly\)/);
  assert.match(src, /\.\.\.\(rung\.agent === "claude" \? claudeOnly : \{\}\)/);
});
