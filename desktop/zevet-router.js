// The "Zevet" model: one console that answers each turn with the backend best
// suited to it, keeps ONE conversation across all of them, and moves on by
// itself when one is rate limited.
//
// Pure pieces (buildLadder, classifyTurn, routeTurn, composeHandoff, limitOf,
// TurnReader) are exported and tested on their own; startRouted is the
// stateful console and takes its process starter as a parameter, so the suite
// drives it with fakes and never spends a token.
//
// Before a prompt reaches any model, classifyTurn (a pure function: no LLM, no
// network) puts it in one class, and routeTurn picks a rung from POLICY: the
// first tier with a usable rung, a small seeded weighted choice inside it. The
// seed is (console id, turn number), so one turn always routes the same way
// while load spreads across consoles. Rungs are the models this machine can
// run, each looked up in its CLI's own catalogue, never assumed:
//   claude    haiku / sonnet / opus            claude's catalogue
//   codex     cheap and frontier models        codex's catalogue
//   gemini    flash- and pro-class             through opencode (no gemini CLI adapter exists)
//   muse      Muse Spark                       through opencode (no muse CLI adapter exists)
//   open      OPEN_MODELS                      through opencode
const { randomUUID } = require("node:crypto");

const DEFAULT_RESET_MS = 15 * 60 * 1000;
/** Characters of earlier conversation a handoff may carry, and the cap on one side of one turn. */
const HANDOFF_BUDGET = 8000;
const HANDOFF_SIDE = 1500;
/** Past this many characters (prompt plus attachments) a turn is `long`. */
const LONG_CHARS = 60_000;

/** Free open models, best coding one first, each with the roles POLICY names.
 *  Muse Spark is NOT here: its contributor builds may train on prompts, so it
 *  is its own family. Test pins every id here against
 *  board/src/lib/models.generated.mjs so a retired model shows up. */
const OPEN_MODELS = [
  ["openrouter/poolside/laguna-s-2.1:free", "Laguna S 2.1", ["open", "coder", "open-coder"]],
  ["opencode/nemotron-3-ultra-free", "Nemotron 3 Ultra", ["open", "ultra"]],
  ["openrouter/thinkingmachines/inkling:free", "Inkling", ["open"]],
  ["openrouter/z-ai/glm-5.2:free", "GLM 5.2", ["open"]],
  ["openrouter/cohere/north-mini-code:free", "North Mini Code", ["open", "coder"]],
  ["openrouter/nvidia/nemotron-3-super-120b-a12b:free", "Nemotron 3 Super", ["open"]],
];

/** Families whose prompts leave the machine for a model Zevet cannot vouch for:
 *  never candidates in a private repo. */
const PUBLIC_ONLY = new Set(["open", "muse"]);

/** codex's own catalogue marks its cheap model in the description ("Fast and
 *  affordable model for easier tasks" on gpt-6-luna, 2026-09-30). Older
 *  generations say so and are skipped. */
function pickCodexModel(models) {
  if (!Array.isArray(models)) return null;
  return (
    models.find((m) => m && /affordable|efficient/i.test(m.note || "") && !/older|legacy/i.test(m.note || "")) || null
  );
}

/** ... and its frontier model ("Frontier intelligence for the most demanding work" on gpt-6-astra). */
function pickCodexFull(models) {
  if (!Array.isArray(models)) return null;
  return models.find((m) => m && /frontier|most demanding/i.test(m.note || "") && !/older|legacy/i.test(m.note || "")) || null;
}

/** The highest-versioned id matching `re` (capture 1 = version), or null. */
function newest(list, re, skip) {
  let best = null;
  let bestV = -1;
  for (const id of list) {
    const m = re.exec(id);
    if (!m || (skip && skip.test(id))) continue;
    const v = parseFloat(m[1]);
    if (v > bestV || (v === bestV && best && /preview/.test(best) && !/preview/.test(id))) {
      best = id;
      bestV = v;
    }
  }
  return best ? { id: best, version: String(bestV) } : null;
}

/** @typedef {{ id:string, agent:string, model:string, label:string, wideKey:string, family:string, roles:string[], trains:boolean }} Rung */
function rung(agent, model, label, wideKey, family, roles, trains = false) {
  return { id: `${agent}:${model}`, agent, model, label, wideKey, family, roles, trains };
}

/**
 * The rungs this machine can run. `agent` is the CLI that executes one (claude,
 * codex, opencode); `family` is whose model it is.
 * @param {{ has: {claude?:boolean, codex?:boolean, opencode?:boolean},
 *           claude?: Array<{id:string,name:string}>|null,
 *           codex?: Array<{id:string,name:string,note?:string}>|null,
 *           opencode?: string[]|null }} src
 * @returns {{ rungs: Rung[] }}
 */
function buildLadder(src) {
  const has = src.has || {};
  const rungs = [];
  if (has.claude) {
    const cat = src.claude || [];
    for (const [alias, label] of [["haiku", "Haiku"], ["sonnet", "Sonnet"], ["opus", "Opus"]]) {
      const m = cat.find((x) => x && new RegExp(alias, "i").test(x.id));
      // claude takes its own aliases, so a missing catalogue still has haiku
      // and sonnet; opus is only offered when a catalogue says it exists.
      if (!m && (alias === "opus" || cat.length)) continue;
      rungs.push(rung("claude", m ? m.id : alias, m ? m.name : label, "claude", "claude", [alias]));
    }
  }
  if (has.codex) {
    const cheap = pickCodexModel(src.codex);
    const full = pickCodexFull(src.codex);
    if (cheap) rungs.push(rung("codex", cheap.id, cheap.name, "codex", "codex", ["codex-cheap"]));
    if (full && (!cheap || full.id !== cheap.id)) rungs.push(rung("codex", full.id, full.name, "codex", "codex", ["codex-full"]));
  }
  if (has.opencode && Array.isArray(src.opencode)) {
    const list = src.opencode;
    for (const [id, name, roles] of OPEN_MODELS) {
      if (list.includes(id)) rungs.push(rung("opencode", id, name, id.split("/")[0], "open", roles));
    }
    const skip = /image|customtools|lite|tts|live|audio|latest/;
    const pro = newest(list, /^openrouter\/google\/gemini-(\d+(?:\.\d+)?)-pro/, skip);
    const flash = newest(list, /^openrouter\/google\/gemini-(\d+(?:\.\d+)?)-flash/, skip);
    if (flash) rungs.push(rung("opencode", flash.id, `Gemini ${flash.version} Flash`, "gemini", "gemini", ["gemini", "flash"]));
    if (pro) rungs.push(rung("opencode", pro.id, `Gemini ${pro.version} Pro`, "gemini", "gemini", ["gemini", "pro"]));
    const muse = newest(list, /^opencode\/muse-spark-(\d+(?:\.\d+)?)-contributor-free$/);
    if (muse) rungs.push(rung("opencode", muse.id, `Muse Spark ${muse.version}`, "opencode", "muse", ["muse"], true));
  }
  return { rungs };
}

// ---------------------------------------------------------------------------
// Classifying a turn, before any model sees it. Pure, no network, microseconds.
// ---------------------------------------------------------------------------
const REASON_WORDS =
  /\b(plan|design|architect\w*|review|audit|investigat\w*|root cause|trade-?offs?|debug\w*|diagnos\w*|compare|pros and cons|why (?:is|does|did|are|isn'?t|doesn'?t|won'?t|can'?t)\b[^.?\n]{0,80}\b(?:fail\w*|break\w*|broken|crash\w*|error\w*|slow|hang\w*|leak\w*|wrong|not work\w*))\b/i;
const BUILD_WORDS =
  /\b(implement\w*|refactor\w*|migrat\w*|rewrite|build (?:a|an|the|out|me|this|us)|scaffold|across|multi-?file|every file|all files|whole (?:repo|codebase|project)|entire (?:repo|codebase|project)|end[- ]to[- ]end|from scratch)\b/i;
const EDIT_WORDS = /\b(fix|rename|change|update|tweak|replace|remove|delete|add|insert|typo|bump|patch)\b/i;
const PATHISH = /[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|md|json|css|html|ya?ml|toml|cs|cpp|c|h)\b/g;

/**
 * One class for a prompt, plus the features that decided it.
 *   long    more than LONG_CHARS of prompt and attachments
 *   build   multi-file, agentic, implementation, refactor (wins over reason:
 *           "design and implement X" is a request to build)
 *   reason  plan, design, debug-why, review, architecture
 *   edit    a small change: a code fence, one or two paths, or an edit verb
 *   quick   short question or chat, no code or paths
 * @param {string} prompt
 * @param {{ attachmentChars?: number }} [ctx]
 * @returns {{ class: "quick"|"edit"|"build"|"reason"|"long", features: object }}
 */
function classifyTurn(prompt, ctx) {
  const p = String(prompt || "");
  const chars = p.length;
  const attachChars = Math.max(0, Number(ctx && ctx.attachmentChars) || 0);
  const features = { chars, attachChars };
  if (chars + attachChars > LONG_CHARS) return { class: "long", features };
  const lines = p.split("\n").length;
  const fences = Math.floor((p.match(/```/g) || []).length / 2);
  const paths = new Set(p.match(PATHISH) || []).size;
  const reason = REASON_WORDS.test(p);
  const build = BUILD_WORDS.test(p);
  const edit = EDIT_WORDS.test(p);
  Object.assign(features, { lines, fences, paths, reason, build, edit });
  let cls;
  if (build || paths >= 3) cls = "build";
  else if (reason) cls = "reason";
  else if (fences || paths || edit) cls = chars > 4000 || lines > 80 ? "build" : "edit";
  else cls = chars > 700 || lines > 12 ? "reason" : "quick";
  return { class: cls, features };
}

/**
 * Class -> ordered tiers -> [role, weight]. The order is code, not config.
 * Within a tier the weight of an entry is split evenly over its rungs.
 */
const POLICY = {
  quick: [[["open", 2], ["flash", 1], ["muse", 1]], [["haiku", 1], ["codex-cheap", 1]]],
  edit: [[["codex-cheap", 1], ["haiku", 1], ["coder", 1]], [["gemini", 1], ["sonnet", 1]]],
  build: [[["sonnet", 1], ["codex-full", 1]], [["pro", 1], ["opus", 1]], [["open-coder", 1]]],
  reason: [[["sonnet", 1], ["codex-full", 1], ["pro", 1]], [["opus", 1]]],
  long: [[["gemini", 1], ["muse", 1], ["ultra", 1]], [["sonnet", 1]]],
};

/** FNV-1a, then a murmur-style finaliser: a stable float in [0,1) from a string. */
function unitHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Which rung answers a turn. Deterministic: the same inputs give the same rung.
 * @param {object} o
 * @param {{ rungs: Rung[] }} o.ladder
 * @param {string} o.cls
 * @param {string} o.seed          console id + turn number
 * @param {(r: Rung) => boolean} [o.limited]
 * @param {boolean} [o.private]    true (the default): open and muse rungs are not candidates
 * @param {{ rung: Rung, cls: string } | null} [o.prev]   the last turn's route, for stickiness
 * @returns {{ rung: Rung, tier: number, index: number, count: number, sticky: boolean, reason: string } | null}
 */
function routeTurn(o) {
  const priv = o.private !== false;
  const rungs = o.ladder.rungs.filter((r) => !(priv && PUBLIC_ONLY.has(r.family)) && !(o.limited && o.limited(r)));
  const tiers = POLICY[o.cls] || [];
  const made = (r, tier, index, count, sticky) => ({
    rung: r,
    tier,
    index,
    count,
    sticky,
    reason: sticky ? `${o.cls} → ${r.label} (sticky)` : `${o.cls} → ${r.label} (tier ${tier}, seed ${index}/${count})`,
  });
  // Stickiness: the same class keeps the rung it had, so no handoff is paid
  // for nothing. It lapses when the class changes or the rung is limited (or,
  // in a private repo, no longer allowed): `rungs` has already dropped those.
  if (o.prev && o.prev.cls === o.cls && rungs.some((r) => r.id === o.prev.rung.id)) {
    const t = tiers.findIndex((tier) => tier.some(([role]) => o.prev.rung.roles.includes(role)));
    if (t >= 0) return made(o.prev.rung, t + 1, 1, 1, true);
  }
  for (let t = 0; t < tiers.length; t++) {
    const cand = [];
    for (const [role, weight] of tiers[t]) {
      const have = rungs.filter((r) => r.roles.includes(role) && !cand.some((c) => c.rung.id === r.id));
      for (const r of have) cand.push({ rung: r, w: weight / have.length });
    }
    if (!cand.length) continue;
    let x = unitHash(o.seed) * cand.reduce((a, c) => a + c.w, 0);
    let i = 0;
    while (i < cand.length - 1 && x >= cand[i].w) x -= cand[i++].w;
    return made(cand[i].rung, t + 1, i + 1, cand.length, false);
  }
  // Nothing the policy names is usable: any rung that is, in ladder order.
  return rungs.length ? made(rungs[0], tiers.length + 1, 1, rungs.length, false) : null;
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
const LIMIT_RE = /free-models-per-day|rate.?limit|\b429\b|too many requests|usage limit|quota|key limit exceeded|insufficient (?:credits|funds)|\b402\b/i;

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
  return { resetAt: Number.isFinite(reset) && reset > 0 ? reset : null, wide: /free-models-per-day|key limit/i.test(text) };
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
 * @param {() => {rungs: Rung[]} | Promise<{rungs: Rung[]}>} o.ladder   read per turn: a CLI may sign in mid-session
 * @param {() => boolean | Promise<boolean>} [o.isPrivate]   whether this console's folder is private. Unset or throwing means private: open and muse rungs are then never candidates.
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
  let turnNo = history.length; // the seed's second half: a respawned Chat thread carries on from its turns
  let prev = null; // { rung, cls } of the last answered turn, for stickiness
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
  function attempt(r, text, extra, d) {
    // A model that may train on prompts never gets Chat's Masora brief.
    if (r.trains && extra && extra.brief) extra = { ...extra, brief: undefined };
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
        emit({ type: "agent", agent: "zevet", payload: { type: "zevet_route", agent: r.agent, model: r.model, label: r.label, class: d.cls, tier: d.tier, reason: d.reason } });
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
    const { class: cls } = classifyTurn(text, { attachmentChars: extra && extra.attachmentChars });
    const seed = `${id}:${turnNo++}`;
    let priv = true;
    try {
      if (o.isPrivate) priv = (await o.isPrivate()) !== false;
    } catch {
      // Unknown is private.
    }
    for (;;) {
      if (stopped) return;
      const lad = await o.ladder();
      const d = routeTurn({ ladder: lad, cls, seed, limited: limitedUntil, private: priv, prev });
      if (!d) return allLimited(lad);
      const out = await attempt(d.rung, text, extra, { ...d, cls });
      if (out === "done") prev = { rung: d.rung, cls };
      if (out === "done" || out === "stopped") return;
      // limited / unavailable: the next pass skips it and takes the following rung.
      if (out === "unavailable") limits.set(d.rung.id, now() + DEFAULT_RESET_MS);
    }
  }

  function allLimited(lad) {
    const all = lad.rungs || [];
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

module.exports = { startRouted, buildLadder, classifyTurn, routeTurn, POLICY, LONG_CHARS, pickCodexFull, composeHandoff, limitOf, limitOfStderr, TurnReader, pickCodexModel, OPEN_MODELS, DEFAULT_RESET_MS };
