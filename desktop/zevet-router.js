// The "Zevet" model: one console that answers each turn with the cheapest
// backend able to, keeps ONE conversation across all of them, and moves to the
// next backend by itself when one is rate limited.
//
// Pure pieces (buildLadder, classifyTurn, composeHandoff, limitOf, TurnReader)
// are exported and tested on their own; startRouted is the stateful console
// and takes its process starter as a parameter, so the suite drives it with
// fakes and never spends a token.
//
// Ladder (the order is code, not config):
//   easy turn   claude haiku -> codex's plainest model -> free open models
//   hard turn   claude sonnet first, then the easy ladder
// A rung exists only when its CLI is here and (for codex/opencode) its model
// is in that CLI's own catalogue -- an id is looked up, never assumed.
const { randomUUID } = require("node:crypto");

const DEFAULT_RESET_MS = 15 * 60 * 1000;
/** Characters of earlier conversation a handoff may carry, and the cap on one side of one turn. */
const HANDOFF_BUDGET = 8000;
const HANDOFF_SIDE = 1500;

/** Free open models, best coding one first. Muse Spark's contributor builds
 *  are left out on purpose: they may train on prompts. Test pins every id here
 *  against board/src/lib/models.generated.mjs so a retired model shows up. */
const OPEN_MODELS = [
  ["openrouter/poolside/laguna-s-2.1:free", "Laguna S 2.1"],
  ["opencode/nemotron-3-ultra-free", "Nemotron 3 Ultra"],
  ["openrouter/thinkingmachines/inkling:free", "Inkling"],
  ["openrouter/z-ai/glm-5.2:free", "GLM 5.2"],
  ["openrouter/cohere/north-mini-code:free", "North Mini Code"],
  ["openrouter/nvidia/nemotron-3-super-120b-a12b:free", "Nemotron 3 Super"],
];

/** codex's own catalogue marks its cheap model in the description ("Fast and
 *  affordable model for easier tasks" on gpt-6-luna, 2026-09-30). Older
 *  generations say so and are skipped. */
function pickCodexModel(models) {
  if (!Array.isArray(models)) return null;
  return (
    models.find((m) => m && /affordable|efficient/i.test(m.note || "") && !/older|legacy/i.test(m.note || "")) || null
  );
}

/**
 * The rungs this machine can run, in the order to try them.
 * @param {{ has: {claude?:boolean, codex?:boolean, opencode?:boolean},
 *           claude?: Array<{id:string,name:string}>|null,
 *           codex?: Array<{id:string,name:string,note?:string}>|null,
 *           opencode?: string[]|null }} src
 * @returns {{ easy: Rung[], hard: Rung[] }}
 */
function buildLadder(src) {
  const has = src.has || {};
  const easy = [];
  let sonnet = null;
  if (has.claude) {
    const haiku = (src.claude || []).find((m) => /haiku/i.test(m.id));
    easy.push(rung("claude", haiku ? haiku.id : "haiku", haiku ? haiku.name : "Haiku", "claude"));
    sonnet = rung("claude", "sonnet", "Sonnet", "claude");
  }
  if (has.codex) {
    const m = pickCodexModel(src.codex);
    if (m) easy.push(rung("codex", m.id, m.name, "codex"));
  }
  if (has.opencode && Array.isArray(src.opencode)) {
    for (const [id, name] of OPEN_MODELS) {
      if (src.opencode.includes(id)) easy.push(rung("opencode", id, name, id.split("/")[0]));
    }
  }
  return { easy, hard: sonnet ? [sonnet, ...easy] : easy };
}

/** @typedef {{ id:string, agent:string, model:string, label:string, wideKey:string }} Rung */
function rung(agent, model, label, wideKey) {
  return { id: `${agent}:${model}`, agent, model, label, wideKey };
}

const HARD_WORDS =
  /\b(plan|design|architect\w*|refactor\w*|migrat\w*|investigat\w*|implement\w*|rewrite|audit|review|debug\w*|across|multi-?file|every file|whole (repo|codebase)|entire (repo|codebase))\b/i;
const PATHISH = /[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|md|json|css|html|ya?ml|toml|cs|cpp|c|h)\b/g;

/** "hard" (long, planning-shaped, or touching several files) or "easy". */
function classifyTurn(prompt) {
  const p = String(prompt || "");
  if (p.length > 700 || p.split("\n").length > 12) return "hard";
  if (HARD_WORDS.test(p)) return "hard";
  if (new Set(p.match(PATHISH) || []).size >= 3) return "hard";
  return "easy";
}

function clip(s, n) {
  s = String(s || "").trim();
  return s.length > n ? s.slice(0, n).trimEnd() + " …" : s;
}

/**
 * The prompt for a backend that has not seen the earlier turns: those turns
 * (prompts and final answers), delimited, then the request. Newest turns win
 * the budget; a dropped run of old turns is said so.
 * @param {Array<{user:string, answer:string}>} turns
 */
function composeHandoff(turns, prompt, budget = HANDOFF_BUDGET) {
  if (!turns.length) return prompt;
  const blocks = turns.map((t) => `User: ${clip(t.user, HANDOFF_SIDE)}\nAnswer: ${clip(t.answer, HANDOFF_SIDE)}`);
  const kept = [];
  let used = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (kept.length && used + blocks[i].length > budget) break;
    kept.unshift(blocks[i]);
    used += blocks[i].length;
  }
  const dropped = blocks.length - kept.length;
  return [
    "[Zevet handoff: this conversation was already under way with other models. Earlier turns follow; the request after them is the one to answer.]",
    "<<<earlier",
    ...(dropped ? [`(${dropped} earlier turn${dropped === 1 ? "" : "s"} omitted)`] : []),
    kept.join("\n\n"),
    ">>>",
    "",
    prompt,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Rate limits, from each backend's real stream.
//
//  claude   {"type":"rate_limit_event","rate_limit_info":{"status":"rejected",
//            "resetsAt":<seconds>}}     ("allowed_warning" still ran: not a limit)
//           {"type":"result","is_error":true,"result":"API Error: 429 {\"type\":\"rate_limit_error\"}"}
//           (both shapes are the ones board/src/lib/transcript.mjs reads and
//           test/transcript.test.mjs pins; not reproducible on demand here)
//  codex    {"type":"error"|"turn.failed","error":{"message":"usage limit reached"}}
//           NOT item.completed/error: that one is a non-fatal notice.
//  opencode {"type":"error","error":{"data":{"message":"Rate limit exceeded: free-models-per-day…",
//            "responseHeaders":{"x-ratelimit-reset":<ms>}}}}   (measured 2026-09-22)
//           stderr: "Error: Upstream request failed: [429]"        (measured 2026-09-23)
// ---------------------------------------------------------------------------
const LIMIT_RE = /free-models-per-day|rate.?limit|\b429\b|too many requests|usage limit|quota/i;

/**
 * @param {"claude"|"codex"|"opencode"} agent
 * @param {object} payload   an `agent` event's payload
 * @returns {{ resetAt: number|null, wide: boolean } | null}
 */
function limitOf(agent, payload) {
  if (!payload || typeof payload !== "object") return null;
  if (agent === "claude") {
    if (payload.type === "rate_limit_event") {
      const info = payload.rate_limit_info || {};
      if (info.status !== "rejected") return null;
      return { resetAt: typeof info.resetsAt === "number" ? info.resetsAt * 1000 : null, wide: true };
    }
    if (payload.type === "result" && payload.is_error && LIMIT_RE.test(String(payload.result || ""))) {
      return { resetAt: null, wide: true };
    }
    if (payload.isApiErrorMessage === true && LIMIT_RE.test(textOf(payload))) return { resetAt: null, wide: true };
    return null;
  }
  if (agent === "codex") {
    if (payload.type !== "error" && payload.type !== "turn.failed") return null;
    const e = payload.error || {};
    return LIMIT_RE.test(String(e.message || payload.message || "")) ? { resetAt: null, wide: true } : null;
  }
  if (payload.type !== "error") return null;
  const e = payload.error || {};
  const text = String((e.data && e.data.message) || e.message || e.name || "");
  if (!LIMIT_RE.test(text)) return null;
  const h = e.data && e.data.responseHeaders;
  const reset = Number(h && (h["x-ratelimit-reset"] ?? h["X-RateLimit-Reset"]));
  return { resetAt: Number.isFinite(reset) && reset > 0 ? reset : null, wide: /free-models-per-day/i.test(text) };
}

/** opencode prints its own CLI-level failures to stderr, one line each. */
function limitOfStderr(text) {
  return LIMIT_RE.test(String(text || "")) && /\b429\b|rate.?limit|free-models-per-day/i.test(text)
    ? { resetAt: null, wide: /free-models-per-day/i.test(text) }
    : null;
}

function textOf(payload) {
  const c = payload && payload.message && payload.message.content;
  return Array.isArray(c) ? c.map((b) => (b && b.text) || "").join("") : "";
}

// ---------------------------------------------------------------------------
// Reading a turn's stream: the answer, the session id, whether it is finished.
// ---------------------------------------------------------------------------
class TurnReader {
  constructor(agent) {
    this.agent = agent;
    this.session = null;
    this.answer = "";
    this.finished = false; // claude only: its process outlives the turn
    this._opencode = [];
  }
  /** Whether this payload is the model saying something (vs. plumbing or an error). */
  push(p) {
    if (!p || typeof p !== "object") return false;
    if (this.agent === "claude") {
      if (p.session_id) this.session = p.session_id;
      if (p.type === "assistant" && !p.isApiErrorMessage) {
        const t = textOf(p);
        if (t) this.answer = t;
        return true;
      }
      if (p.type === "result") {
        this.finished = true;
        if (!p.is_error && typeof p.result === "string" && p.result) this.answer = p.result;
      }
      return false;
    }
    if (this.agent === "codex") {
      if (p.type === "thread.started" && p.thread_id) this.session = p.thread_id;
      const item = p.item;
      if (p.type === "item.completed" && item && item.type === "agent_message") {
        this.answer = String(item.text || "");
        return true;
      }
      return p.type === "item.started" || (p.type === "item.completed" && item && item.type !== "error");
    }
    const sid = p.sessionID || (p.part && p.part.sessionID);
    if (sid) this.session = sid;
    if (p.type === "text" && p.part && p.part.type === "text") {
      this._opencode.push(String(p.part.text || ""));
      this.answer = this._opencode.join("");
      return true;
    }
    return p.type === "tool_use";
  }
}

// ---------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {(rung: Rung, extra: {resumeFrom?: string, onEvent: Function}) => {ok:boolean, error?:string, send?:Function, stop?:Function}} o.start
 * @param {() => {easy: Rung[], hard: Rung[]} | Promise<{easy: Rung[], hard: Rung[]}>} o.ladder   read per turn: a CLI may sign in mid-session
 * @param {(evt: object) => void} o.onEvent
 */
function startRouted(o) {
  const now = o.now || Date.now;
  const id = o.id || randomUUID();
  const emit = typeof o.onEvent === "function" ? o.onEvent : () => {};
  const limits = new Map(); // key -> resetAt ms
  const sessions = new Map(); // rung.id -> session id
  // { user, answer, rung }. `o.history` seeds a conversation that began before
  // this console (a Chat thread respawned): rung "" matches no backend, so
  // every one is handed all of it on first use.
  const history = (o.history || []).map((t) => ({ user: t.user, answer: t.answer, rung: "" }));
  const queue = [];
  let busy = false;
  let stopped = false;
  let live = null; // { rung, handle }: the process of the turn in flight, or claude's idle one
  // Events reach the attempt in flight through `sink`; `liveGen` mutes a
  // process that was closed, so its late exit cannot end the next attempt.
  let sink = null;
  let liveGen = 0;
  let genSeq = 0;

  const limitedUntil = (r) => {
    const t = Math.max(limits.get(r.id) || 0, limits.get(r.wideKey) || 0);
    return t > now() ? t : 0;
  };

  function markLimited(r, lim) {
    limits.set(lim.wide ? r.wideKey : r.id, lim.resetAt && lim.resetAt > now() ? lim.resetAt : now() + DEFAULT_RESET_MS);
  }

  function closeLive() {
    if (!live) return;
    liveGen = 0;
    try {
      live.handle.stop();
    } catch {
      // Already gone.
    }
    live = null;
  }

  /** One try of `text` on `r`. Resolves "done" | "limited" | "unavailable" | "stopped". */
  function attempt(r, text, extra) {
    return new Promise((resolve) => {
      const sid = sessions.get(r.id);
      // The turns this backend never saw: all of them on a fresh session, the
      // other backends' turns on a resumed one.
      const missed = history.filter((t) => !(sid && t.rung === r.id));
      const prompt = composeHandoff(missed, text);
      const reader = new TurnReader(r.agent);
      let limit = null;
      let committed = false;
      let settled = false;
      const pending = [];
      const tag = (evt) => ({ ...evt, agent: r.agent, model: r.model });
      const route = () =>
        emit({ type: "agent", agent: "zevet", payload: { type: "zevet_route", agent: r.agent, model: r.model, label: r.label } });
      const commit = () => {
        if (committed) return;
        committed = true;
        route();
        for (const e of pending.splice(0)) emit(tag(e));
      };
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        if (outcome === "done") {
          commit();
          if (reader.session) sessions.set(r.id, reader.session);
          history.push({ user: text, answer: reader.answer, rung: r.id });
          if (r.agent !== "claude") {
            live = null;
            // claude's own `result` ends its turn for console-log (and so for the
            // agent API's /wait); codex and opencode have no such event, so a
            // routed turn that finished on one of them says so itself. Top-level,
            // so the board's transcript never renders it.
            emit({ type: "turn_end", result: reader.answer });
          }
        } else if (outcome === "limited" || outcome === "unavailable") {
          if (outcome === "limited") markLimited(r, limit);
          if (live && live.rung === r) closeLive();
        }
        resolve(outcome);
      };

      const onEvent = (evt) => {
        if (settled || stopped) return;
        if (evt.type === "agent") {
          const lim = limitOf(r.agent, evt.payload);
          if (lim) {
            // The reset time and the closing error can arrive on different events.
            limit = { ...lim, resetAt: lim.resetAt || (limit && limit.resetAt) || null };
            // claude's process outlives the turn, so its result is the end.
            if (r.agent === "claude" && evt.payload.type === "result") finish("limited");
            return;
          }
          const content = reader.push(evt.payload);
          if (committed) emit(tag(evt));
          else {
            pending.push(evt);
            if (content) commit();
          }
          if (r.agent === "claude" && reader.finished) finish(limit ? "limited" : "done");
        } else if (evt.type === "stderr") {
          const lim = r.agent === "opencode" ? limitOfStderr(evt.text) : null;
          if (lim) limit = lim;
          else emit(tag(evt));
        } else if (evt.type === "exit") {
          if (live && live.rung === r) live = null;
          if (limit) finish("limited");
          else if (evt.error && !committed && !pending.length) finish("unavailable");
          else finish(evt.stopped ? "stopped" : "done");
        } else emit(tag(evt));
      };

      let handle;
      if (live && live.rung === r) handle = live.handle;
      else {
        closeLive();
        const gen = ++genSeq;
        liveGen = gen;
        const started = o.start(r, {
          ...(sid ? { resumeFrom: sid } : {}),
          onEvent: (e) => {
            if (gen === liveGen && sink) sink(e);
          },
        });
        if (!started || started.ok === false) return finish("unavailable");
        handle = started;
        live = { rung: r, handle };
      }
      sink = onEvent;
      const sent = handle.send(prompt, extra);
      if (sent && sent.ok === false) finish("unavailable");
    });
  }

  async function runTurn({ text, extra }) {
    const tier = classifyTurn(text);
    for (;;) {
      if (stopped) return;
      const order = ((await o.ladder())[tier] || []).filter((r) => !limitedUntil(r));
      const next = order[0];
      if (!next) return allLimited(await o.ladder());
      const out = await attempt(next, text, extra);
      if (out === "done" || out === "stopped") return;
      // limited / unavailable: the next pass skips it and takes the following rung.
      if (out === "unavailable") limits.set(next.id, now() + DEFAULT_RESET_MS);
    }
  }

  function allLimited(lad) {
    const all = [...new Set([...(lad.hard || []), ...(lad.easy || [])])];
    const untils = all.map(limitedUntil).filter(Boolean);
    const at = untils.length ? Math.min(...untils) : 0;
    emit({
      type: "agent",
      agent: "opencode",
      payload: {
        type: "error",
        error: { message: all.length ? "Rate limit exceeded on every model" : "No model available", data: { message: all.length ? "Rate limit exceeded on every model" : "No model available", responseHeaders: at ? { "x-ratelimit-reset": String(at) } : {} } },
      },
    });
    // Nothing answered: the turn is over all the same (Chat waits on this).
    emit({ type: "turn_end", result: "", error: true });
  }

  async function drain() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length && !stopped) await runTurn(queue.shift());
    } finally {
      busy = false;
    }
  }

  return {
    ok: true,
    id,
    /** `extra` rides to the backend's own send (Chat's Masora brief). */
    send(text, extra) {
      if (stopped) return { ok: false, error: "That agent has already exited." };
      if (typeof text !== "string" || !text.length) return { ok: false, error: "Nothing to send." };
      queue.push({ text, extra });
      void drain();
      return { ok: true };
    },
    stop() {
      if (stopped) return { ok: true, alreadyStopped: true };
      stopped = true;
      const l = live;
      live = null;
      liveGen = 0;
      let killed = { ok: true };
      if (l) {
        try {
          killed = l.handle.stop();
        } catch (err) {
          killed = { ok: false, error: err.message };
        }
      }
      emit({ type: "exit", code: null, signal: null, stopped: true });
      return killed;
    },
    // For the suite.
    _state: { limits, sessions, history },
  };
}

module.exports = { startRouted, buildLadder, classifyTurn, composeHandoff, limitOf, limitOfStderr, TurnReader, pickCodexModel, OPEN_MODELS, DEFAULT_RESET_MS };
