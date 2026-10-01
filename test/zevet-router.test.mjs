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

const OPEN_LIST = [...OPENCODE_FREE_MODELS];
const GEMINI_LIST = [
  "openrouter/google/gemini-2.5-pro",
  "openrouter/google/gemini-3.1-pro-preview",
  "openrouter/google/gemini-3.1-pro-preview-customtools",
  "openrouter/google/gemini-3.5-flash",
  "openrouter/google/gemini-3.5-flash-lite",
  "openrouter/google/gemini-3.1-flash-image",
  "openrouter/~google/gemini-pro-latest",
  "opencode/muse-spark-1.2-contributor-free",
  "opencode/muse-spark-1.3-contributor-free",
];
const FULL = { has: { claude: true, codex: true, opencode: true }, claude: [...CLAUDE, { id: "claude-opus-5-5", name: "Opus 5.5" }], codex: CODEX, opencode: [...OPEN_LIST, ...GEMINI_LIST] };
const byFamily = (l) => Object.fromEntries([...new Set(l.rungs.map((r) => r.family))].map((f) => [f, l.rungs.filter((r) => r.family === f).map((r) => r.model)]));

test("ladder: every backend's rungs are looked up in its own catalogue", () => {
  const l = R.buildLadder(FULL);
  const f = byFamily(l);
  assert.deepEqual(f.claude, ["claude-haiku-4-5-20251001", "claude-sonnet-5-5", "claude-opus-5-5"]);
  assert.deepEqual(f.codex, ["gpt-6-luna", "gpt-6-astra"]);
  assert.deepEqual(f.gemini, ["openrouter/google/gemini-3.5-flash", "openrouter/google/gemini-3.1-pro-preview"], "newest flash and pro; no image, lite, customtools, latest alias");
  assert.deepEqual(f.muse, ["opencode/muse-spark-1.3-contributor-free"]);
  assert.equal(l.rungs.find((r) => r.family === "muse").trains, true);
  assert.deepEqual(f.open, R.OPEN_MODELS.map((m) => m[0]).filter((id) => OPEN_LIST.includes(id)));
});

test("ladder: a backend that is absent or has no models is simply not a candidate", () => {
  assert.deepEqual(ids(R.buildLadder({ ...FULL, has: { codex: true } }).rungs), ["codex:gpt-6-luna", "codex:gpt-6-astra"]);
  // codex with no catalogue: its model is looked up, never guessed.
  assert.deepEqual(ids(R.buildLadder({ ...FULL, has: { codex: true }, codex: null }).rungs), []);
  // opus only when the catalogue lists it; a missing catalogue still has claude's own aliases for haiku and sonnet.
  assert.ok(!ids(R.buildLadder({ ...FULL, has: { claude: true }, claude: CLAUDE }).rungs).some((i) => /opus/.test(i)));
  assert.deepEqual(ids(R.buildLadder({ has: { claude: true }, claude: null }).rungs), ["claude:haiku", "claude:sonnet"]);
  // An open model the CLI does not list is not a rung; no gemini or muse without their ids.
  const only = R.buildLadder({ ...FULL, has: { opencode: true }, opencode: ["opencode/nemotron-3-ultra-free"] });
  assert.deepEqual(ids(only.rungs), ["opencode:opencode/nemotron-3-ultra-free"]);
  assert.deepEqual(R.buildLadder({ has: {} }).rungs, []);
});

test("open rungs are real, current, and do not train on prompts", () => {
  for (const [id] of R.OPEN_MODELS) {
    assert.ok(OPENCODE_FREE_MODELS.includes(id), `${id} is not in models.generated.mjs`);
    assert.equal(describeModel(id).trains, false, `${id} may train on prompts`);
  }
});

const cls = (p, ctx) => R.classifyTurn(p, ctx).class;

test("classifyTurn: each class", () => {
  assert.equal(cls("what does this function return?"), "quick");
  assert.equal(cls("hello there"), "quick");
  assert.equal(cls("rename foo to bar in index.js"), "edit");
  assert.equal(cls("fix the typo in a.js"), "edit");
  assert.equal(cls("what does this do?\n```js\nconst x = 1;\n```"), "edit");
  assert.equal(cls("implement oauth login across the app"), "build");
  assert.equal(cls("make a.js, b.js and lib/c.ts agree"), "build");
  assert.equal(cls("plan the auth change"), "reason");
  assert.equal(cls("review this design and say what is wrong"), "reason");
  assert.equal(cls("why does the build fail on windows?"), "reason", "build as a noun is not a build verb");
  assert.equal(cls("why does the login crash on windows?"), "reason");
  assert.equal(cls("design and implement a cache"), "build", "a build verb wins over a reason verb");
  assert.equal(cls("x".repeat(60_001)), "long");
});

test("classifyTurn: boundaries", () => {
  assert.equal(cls("x".repeat(60_000)), "reason", "60000 chars is not long (and 700+ plain chars read as reason)");
  assert.equal(cls("x".repeat(60_001)), "long");
  assert.equal(cls("hi", { attachmentChars: 59_997 }), "quick");
  assert.equal(cls("hi", { attachmentChars: 59_998 }), "quick", "2 + 59998 = 60000 is not over");
  assert.equal(cls("hi", { attachmentChars: 59_999 }), "long", "attachments count toward long");
  assert.equal(cls("x".repeat(700)), "quick");
  assert.equal(cls("x".repeat(701)), "reason");
  assert.equal(cls("a\n".repeat(11)), "quick");
  assert.equal(cls("a\n".repeat(13)), "reason");
  assert.equal(cls("touch a.js and b.js"), "edit", "two paths is still an edit");
  assert.equal(cls("touch a.js, b.js and c.js"), "build", "three is a build");
  assert.equal(cls("a.js a.js a.js"), "edit", "the same path three times is one path");
  assert.equal(cls("fix a.js " + "y ".repeat(2100)), "build", "a very long edit request is a build");
});

test("classifyTurn: says which features decided it, and is fast", () => {
  const r = R.classifyTurn("fix a.js and lib/b.ts\n```js\nx\n```");
  assert.equal(r.class, "edit");
  assert.deepEqual([r.features.paths, r.features.fences, r.features.lines, r.features.edit], [2, 1, 4, true]);
  const big = ("fix the thing in src/app.ts because " + "lorem ipsum dolor ".repeat(20)).repeat(150).slice(0, 59_999);
  R.classifyTurn(big);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) R.classifyTurn(big);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  assert.ok(ms < 5, `classifyTurn took ${ms.toFixed(2)} ms on 60k chars`);
  assert.equal(R.classifyTurn("x".repeat(5_000_000)).class, "long", "a huge paste is decided by length alone");
});

// --- the policy ------------------------------------------------------------
const FULLL = R.buildLadder(FULL);
const pick = (c, seed, o = {}) => R.routeTurn({ ladder: FULLL, cls: c, seed, private: false, ...o });
const family = (d) => d.rung.family;

test("policy: the same seed always routes the same way; the reason says why", () => {
  for (const c of Object.keys(R.POLICY)) for (const s of ["a:0", "a:1", "zz:42"]) assert.equal(pick(c, s).rung.id, pick(c, s).rung.id);
  const d = pick("edit", "c1:3");
  assert.match(d.reason, /^edit → .+ \(tier 1, seed \d\/\d\)$/);
  assert.equal(d.tier, 1);
});

test("policy: 1000 seeds spread across tier 1 and stay inside it", () => {
  const tier1 = { quick: ["open", "gemini", "muse"], edit: ["codex", "claude", "open"], build: ["claude", "codex"], reason: ["claude", "codex", "gemini"], long: ["gemini", "muse", "open"] };
  for (const [c, allowed] of Object.entries(tier1)) {
    const seen = new Map();
    for (let i = 0; i < 1000; i++) {
      const d = pick(c, `console:${i}`);
      assert.equal(d.tier, 1, `${c} stays in tier 1 while tier 1 has rungs`);
      seen.set(family(d), (seen.get(family(d)) || 0) + 1);
    }
    assert.deepEqual([...seen.keys()].filter((f) => !allowed.includes(f)), [], `${c} left tier 1: ${[...seen.keys()]}`);
    assert.ok(seen.size >= Math.min(2, allowed.length), `${c} used ${[...seen.keys()]}`);
    for (const n of seen.values()) assert.ok(n > 40, `${c}: a family got only ${n}/1000`);
  }
  // build tier 1 is [sonnet, codex-full]: both used, neither starved.
  const b = new Set(Array.from({ length: 200 }, (_, i) => pick("build", `k:${i}`).rung.id));
  assert.deepEqual([...b].sort(), ["claude:claude-sonnet-5-5", "codex:gpt-6-astra"]);
});

test("policy: limited rungs are skipped, then later tiers are used", () => {
  const lim = (set) => (r) => set.has(r.id) || set.has(r.wideKey);
  // quick: knock out open models, gemini and muse (tier 1): tier 2 answers.
  const t1 = lim(new Set(["openrouter", "opencode", "gemini"]));
  for (let i = 0; i < 50; i++) {
    const d = pick("quick", `s:${i}`, { limited: t1 });
    assert.equal(d.tier, 2);
    assert.ok(["claude:claude-haiku-4-5-20251001", "codex:gpt-6-luna"].includes(d.rung.id), d.rung.id);
  }
  // build: sonnet and codex both limited -> tier 2 (gemini pro, opus).
  const noT1 = lim(new Set(["claude:claude-sonnet-5-5", "codex"]));
  const d2 = pick("build", "x:1", { limited: noT1 });
  assert.equal(d2.tier, 2);
  assert.ok(["gemini", "claude"].includes(family(d2)));
  // and tier 3 is the best open coder once those are gone too.
  const d3 = pick("build", "x:1", { limited: lim(new Set(["claude", "codex", "gemini"])) });
  assert.deepEqual([d3.tier, d3.rung.model], [3, "openrouter/poolside/laguna-s-2.1:free"]);
  // Everything the policy names is gone: whatever else is usable still answers; nothing usable is null.
  const left = R.routeTurn({ ladder: FULLL, cls: "reason", seed: "q", private: false, limited: (r) => r.model !== "openrouter/z-ai/glm-5.2:free" });
  assert.equal(left.rung.model, "openrouter/z-ai/glm-5.2:free");
  assert.equal(R.routeTurn({ ladder: FULLL, cls: "quick", seed: "q", limited: () => true }), null);
});

test("policy: a turn stays on its rung while the class holds, and moves when the class changes or the rung is limited", () => {
  const first = pick("edit", "c:0");
  const prev = { rung: first.rung, cls: "edit" };
  for (let i = 1; i < 50; i++) {
    const d = pick("edit", `c:${i}`, { prev });
    assert.equal(d.rung.id, first.rung.id);
    assert.equal(d.sticky, true);
  }
  assert.notEqual(pick("build", "c:1", { prev }).sticky, true, "a different class re-routes");
  const lim = pick("edit", "c:1", { prev, limited: (r) => r.id === first.rung.id });
  assert.notEqual(lim.rung.id, first.rung.id, "a limited rung is dropped");
  assert.equal(lim.sticky, false);
});

test("privacy: open models and muse are never candidates in a private folder, in any class, at any seed", () => {
  for (const c of Object.keys(R.POLICY)) {
    for (let i = 0; i < 300; i++) {
      for (const priv of [undefined, true]) {
        const d = R.routeTurn({ ladder: FULLL, cls: c, seed: `masora2:${i}`, private: priv });
        assert.ok(d && !["open", "muse"].includes(d.rung.family), `${c}/${i}: ${d && d.rung.id}`);
      }
    }
  }
  // Even when nothing else is left, a private folder gets no answer rather than an open model.
  const onlyOpen = R.buildLadder({ ...FULL, has: { opencode: true }, opencode: OPEN_LIST });
  assert.equal(R.routeTurn({ ladder: onlyOpen, cls: "quick", seed: "s" }), null);
  assert.ok(R.routeTurn({ ladder: onlyOpen, cls: "quick", seed: "s", private: false }));
});

test("privacy: what makes a folder private", async () => {
  const P = require("../desktop/repo-privacy.js");
  const no = () => assert.fail("must not ask GitHub");
  const git = (url) => ({ remote: async () => url, fetch: no });
  // masora2 anywhere in the path: private without asking git or GitHub.
  assert.equal(await P.isPrivate("C:/dev/GitHub/masora2/app", git("https://github.com/o/public.git")), true);
  assert.equal(await P.isPrivate("/home/x/Masora2", git("")), true);
  // no remote, a non-GitHub remote, no dir: private.
  assert.equal(await P.isPrivate("/tmp/a", git("")), true);
  assert.equal(await P.isPrivate("/tmp/b", git("https://gitlab.com/o/r.git")), true);
  assert.equal(await P.isPrivate(null), true);
  // github.com: public only if anonymous GitHub says private:false.
  const api = (status, body) => async (url) => {
    assert.match(url, /^https:\/\/api\.github\.com\/repos\/o\/pub$/);
    return { ok: status === 200, status, json: async () => body };
  };
  assert.equal(await P.isPrivate("/tmp/c", { remote: async () => "git@github.com:o/pub.git", fetch: api(200, { private: false }) }), false);
  assert.equal(await P.isPrivate("/tmp/d", { remote: async () => "https://github.com/o/pub", fetch: api(404, {}) }), true, "an anonymous 404 is how GitHub says private");
  assert.equal(await P.isPrivate("/tmp/e", { remote: async () => "https://github.com/o/pub.git", fetch: async () => { throw new Error("offline"); } }), true, "unknown is private");
  assert.equal(P.githubRepo("https://github.com/AndrewDoft/zevet.git"), "AndrewDoft/zevet");
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
function harness(ladderIn, script, { clock = { t: 1_000_000 }, id = "t", isPrivate } = {}) {
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
  const console_ = R.startRouted({ id, isPrivate, start, ladder: () => ladderIn, onEvent: (e) => events.push(e), now: () => clock.t });
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
const HAIKU = "claude:claude-haiku-4-5-20251001";
/** A console id whose first turn of class `c` routes to `want`: the pick is seeded, so a scripted test can steer it. */
function idPicking(ladder, c, want) {
  for (let i = 0; i < 500; i++) if (R.routeTurn({ ladder, cls: c, seed: `t${i}:0`, private: true }).rung.id === want) return `t${i}`;
  throw new Error("no seed picks " + want);
}

test("routed: consecutive turns on one backend resume it and send no handoff", async () => {
  const h = harness(R.buildLadder({ ...ALL, has: { claude: true } }), { turn: (r, p, n) => claudeTurn(`a${n}`) });
  await h.done(["one?", "two?"]);
  assert.equal(h.starts.length, 1, "the warm claude process is reused");
  assert.deepEqual(h.prompts.map((p) => p.prompt), ["one?", "two?"]);
  assert.equal(h.events.filter((e) => e.payload?.type === "zevet_route").length, 2);
  assert.ok(h.events.filter((e) => e.type === "agent" && e.payload.type === "result").every((e) => e.agent === "claude"));
});

test("routed: a new backend gets the earlier turns as a handoff, and resumes its own session after", async () => {
  // claude answers easy turns; make the second turn hard -> sonnet is also claude, so limit claude first
  const script = { turn: (r, p, n) => (r.agent === "claude" ? claudeTurn(`c${n}`) : codexTurn(`x${n}`)) };
  const h = harness(ladder2, script, { id: idPicking(ladder2, "quick", HAIKU) });
  await h.done(["first?"]);
  assert.equal(h.prompts[0].rung, HAIKU);
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
  const h = harness(ladder2, script, { id: idPicking(ladder2, "quick", HAIKU) });
  await h.done(["what is 2+2?"]);
  assert.deepEqual(h.prompts.map((p) => p.rung), [HAIKU, "codex:gpt-6-luna"]);
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
  const h = harness(ladder2, script, { clock, id: idPicking(ladder2, "quick", HAIKU) });
  await h.done(["q1"]);
  assert.equal(h.console._state.limits.get("claude"), 5_000_000 + R.DEFAULT_RESET_MS);
  clock.t += R.DEFAULT_RESET_MS + 1;
  h.console._state.limits.set("codex", clock.t + 60_000); // q1 settled on codex; take it out so claude, back from its limit, answers
  await h.done(["q2"]);
  assert.equal(h.prompts.at(-1).rung, HAIKU);
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
  const last = h.events.at(-2);
  assert.equal(h.events.at(-1).type, "turn_end", "and the turn ends, so Chat stops waiting");
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

test("routed: a build turn starts on sonnet", async () => {
  const h = harness(R.buildLadder({ ...ALL, has: { claude: true } }), { turn: () => claudeTurn("done") });
  await h.done(["plan the whole migration"]);
  assert.equal(h.prompts[0].rung, "claude:claude-sonnet-5-5");
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

test("routed: a turn that ends on codex emits turn_end with its answer; a claude turn does not (its result already ends it)", async () => {
  const codexOnly = R.buildLadder({ ...ALL, has: { codex: true } });
  const h = harness(codexOnly, { turn: () => codexTurn("pineapple") });
  await h.done(["which fruit?"]);
  for (let i = 0; i < 50 && !h.events.some((e) => e.type === "turn_end"); i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.events.filter((e) => e.type === "turn_end").map((e) => e.result), ["pineapple"]);

  const c = harness(ladder2, { turn: (r, p, n) => claudeTurn(`a${n}`) });
  await c.done(["one?"]);
  assert.equal(c.events.filter((e) => e.type === "turn_end").length, 0);
});

test("routed: the route event says class, tier and why; the same console and turn route the same way", async () => {
  const run = async () => {
    const h = harness(ladder2, { turn: (r) => (r.agent === "claude" ? claudeTurn("c") : codexTurn("x")) }, { id: "fixed" });
    await h.done(["what is 2+2?"]);
    return h.events.find((e) => e.payload?.type === "zevet_route").payload;
  };
  const a = await run();
  assert.deepEqual(await run(), a);
  assert.equal(a.class, "quick");
  assert.equal(a.tier, 2);
  assert.match(a.reason, /^quick → (Haiku 4\.5|GPT-6-Luna) \(tier 2, seed [12]\/2\)$/);
});

test("routed: later turns of one class stay on the rung (no handoff), a new class may move", async () => {
  const h = harness(ladder2, { turn: (r, p, n) => (r.agent === "claude" ? claudeTurn(`c${n}`) : codexTurn(`x${n}`)) }, { id: "sticky" });
  await h.done(["what is 2+2?", "and 3+3?", "and 4+4?"]);
  assert.equal(new Set(h.prompts.map((p) => p.rung)).size, 1);
  const routes = h.events.filter((e) => e.payload?.type === "zevet_route").map((e) => e.payload.reason);
  assert.match(routes[1], /\(sticky\)$/);
  assert.ok(h.prompts.every((p) => !p.prompt.includes("[Zevet handoff")), "a sticky rung is never handed anything");
});

test("routed: a private console never reaches an open model or muse; a public one can", async () => {
  const open = R.buildLadder({ ...FULL, has: { opencode: true }, opencode: [...OPEN_LIST, "opencode/muse-spark-1.3-contributor-free"] });
  const turn = () => [
    { type: "agent", payload: { type: "text", sessionID: "O", part: { type: "text", sessionID: "O", text: "ok" } } },
    { type: "agent", payload: { type: "step_finish", part: {} } },
    { exit: true },
  ];
  const hit = new Set();
  for (const priv of [undefined, async () => true, () => { throw new Error("no git"); }]) {
    const h = harness(open, { turn }, { isPrivate: priv, id: "masora2-chat" });
    await h.done(["what is 2+2?"]);
    for (const p of h.prompts) hit.add(p.rung);
    assert.ok(h.events.some((e) => e.payload?.type === "error"), "nothing to route to says so rather than leaking");
  }
  assert.deepEqual([...hit], [], "no open/muse rung was ever started");
  const pub = harness(open, { turn }, { isPrivate: async () => false, id: "z" });
  await pub.done(["what is 2+2?"]);
  assert.equal(pub.prompts.length, 1);
});

test("routed: Chat's Masora brief never reaches a model that may train on prompts", async () => {
  const open = R.buildLadder({ ...FULL, has: { opencode: true }, opencode: ["opencode/muse-spark-1.3-contributor-free"] });
  const sent = [];
  const c = R.startRouted({
    id: "m", isPrivate: () => false, ladder: () => open, onEvent: () => {},
    start: (r, x) => ({ ok: true, send: (_p, extra) => { sent.push(extra); setImmediate(() => x.onEvent({ type: "exit", code: 0 })); return { ok: true }; }, stop: () => ({ ok: true }) }),
  });
  c.send("what is 2+2?", { brief: "SECRET BRIEF" });
  for (let i = 0; i < 50 && !sent.length; i++) await new Promise((r) => setImmediate(r));
  assert.equal(sent[0].brief, undefined);
});

test("board: the model-switch divider fires when the routed model changes between turns, not when it stays", async () => {
  const { appendUserText, appendAgentPayload, emptyTranscript } = await import("../board/src/lib/transcript.mjs");
  const route = (label) => ({ type: "zevet_route", agent: "codex", model: label, label });
  let t = emptyTranscript();
  const say = (text, label) => {
    t = appendUserText(t, text, "Zevet");
    t = appendAgentPayload(t, route(label), { agent: "zevet" });
    t = { ...t, openIndex: -1 }; // the turn closes
  };
  say("one", "Haiku");
  say("two", "Haiku");
  say("three", "GPT-6-Luna");
  const users = t.messages.filter((m) => m.role === "user");
  assert.deepEqual(users.map((m) => m.metadata?.custom?.switched), [undefined, undefined, { from: "Haiku", to: "GPT-6-Luna" }]);
});
