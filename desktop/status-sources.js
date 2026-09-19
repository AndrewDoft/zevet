// The status strip's data: what zevet can know about a running agent, and about
// the two services Andrew's own status line watches.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE THIS CAME FROM
//
// Andrew asked for "all of the elements in my statusline, but built into the
// zevet UI" (2026-09-18). That status line is ~/.claude/statusline.py and it
// has nine segments. They divide cleanly into three groups, and the division is
// the whole design of this file:
//
//   SOURCEABLE FROM WHAT ZEVET ALREADY RECEIVES — model, context tokens, cache
//   hit rate, cost. zevet spawns agents with `--output-format stream-json` and
//   throws the usage away today. It is all in there.
//
//   SOURCEABLE FROM THE MACHINE — the vault graph's health file, and whether
//   the code index is listening. Both are a few lines, below.
//
//   NOT SOURCEABLE AT ALL — the 5h and 7d rate-limit windows. Those reach
//   statusline.py because Claude Code hands them to the status line command in
//   its payload. A headless agent's stream-json does NOT carry them; there is
//   no `five_hour` in that stream. So this file does NOT report Anthropic's
//   rate-limit windows, and must not start pretending to: a number labelled
//   "5h 42%" that is not the 5h window is worse than a blank space.
//
//   What it offers instead is `BurnWindows`, which is zevet's OWN rolling
//   accounting of what the agents it launched have spent. That is a different
//   measurement of a related thing and it is named differently on purpose.
//   ⚠️ IT IS NOT THE RATE LIMIT. It counts only agents zevet started, on this
//   machine, since the app opened. Anything run in a terminal is invisible to
//   it. Label it "spent", never "limit", wherever it is drawn.
//
// ⚠️ NOT VERIFIED: the usage parsing below is written against the stream-json
// shapes documented for Claude Code and against `desktop/agent-console.js`'s
// existing handling. No field here has been read off a live `--output-format
// stream-json` run and compared. The first thing to do with a real stream is
// check `usage` really is where this expects it; every getter is written to
// return null rather than throw when it is not.
"use strict";

const fs = require("node:fs");
const net = require("node:net");

/* ========================================================================
 * The vault graph
 * ===================================================================== */

/**
 * The graph has no port to poll, so freshness, cleanliness and sync are its
 * "up" — the same reasoning statusline.py's `graph_stat` uses, and the same
 * precedence, deliberately: errors beat open reports beat staleness beat sync
 * beat the happy case. Two status readouts of one system that disagree about
 * which problem matters most are worse than one.
 *
 * ⚠️ THE COUNT IS `shared`, NOT `notes`. The raw count includes machine-local
 * log and repo nodes, so two machines in sync show different numbers and look
 * broken. statusline.py learned this; the comment there says so and this
 * follows it rather than rediscovering it.
 *
 * Returns `{ state, count, head, detail }` where `state` is one of
 * "missing" | "errors" | "reported" | "stale" | "unsynced" | "ok".
 */
const STALE_AFTER_DAYS = 3;

function vaultHealth(healthPath, now) {
  const t = typeof now === "number" ? now : Date.now();
  let h;
  try {
    // Small, and read on a timer, so sync is right: an async read here would
    // buy nothing and add a race with the caller's render.
    h = JSON.parse(fs.readFileSync(healthPath, "utf8"));
  } catch {
    // No file is the normal state on a machine that has no vault. It is not an
    // error and must not be drawn as one; the caller shows nothing.
    return { state: "missing", count: null, head: null, detail: "" };
  }
  if (!h || typeof h !== "object") {
    return { state: "missing", count: null, head: null, detail: "unreadable" };
  }

  const count = typeof h.shared === "number" ? h.shared : (typeof h.notes === "number" ? h.notes : null);
  const head = typeof h.head === "string" ? h.head : null;

  if (h.errors) return { state: "errors", count, head, detail: `${h.errors} err` };
  if (h.reported) return { state: "reported", count, head, detail: `${h.reported} open` };

  const days = ageInDays(h.auto, t);
  if (days != null && days > STALE_AFTER_DAYS) {
    return { state: "stale", count, head, detail: `${Math.floor(days)}d stale` };
  }
  if (h.sync === "diverged" || h.sync === "unsynced") {
    return { state: "unsynced", count, head, detail: String(h.sync) };
  }
  return {
    state: "ok",
    count,
    head,
    detail: h.sync === "offline" ? "offline" : "",
  };
}

/**
 * `auto` is an ISO-8601 UTC timestamp. Parsed by trimming to seconds and
 * appending Z rather than handed whole to `Date.parse`, because a bare
 * `2026-09-18T07:30:10.289` with no zone is parsed as LOCAL time by the spec,
 * which on a machine six hours off UTC makes a fresh vault look six hours old
 * — or, worse, makes a stale one look fresh.
 */
function ageInDays(iso, now) {
  if (typeof iso !== "string" || iso.length < 19) return null;
  const ms = Date.parse(iso.slice(0, 19) + "Z");
  if (!Number.isFinite(ms)) return null;
  return (now - ms) / 86400000;
}

/* ========================================================================
 * The code index
 * ===================================================================== */

/**
 * Is something listening?
 *
 * ⚠️ THIS IS A LIVENESS PROBE AND NOTHING MORE. It reports that a TCP port
 * accepts a connection, which is exactly what statusline.py's `port_up` reports
 * and exactly as much as it is honest to claim. It does not speak the index's
 * protocol, does not know whether the model is loaded, and does not know
 * whether the thing listening is the index at all rather than some other
 * process that took the port.
 *
 * Andrew asked for the index to be "built into the app" if the machine can
 * carry the embedding model. That is a real subsystem — a model to fetch, a
 * vector store, incremental reindexing on file change — and it is NOT started
 * here. Starting it halfway would leave the app shipping a probe pretending to
 * be an index. This is the probe, labelled as one.
 *
 * The timeout is short and deliberate: this runs on a timer behind a UI, and a
 * probe that blocks for a second is a UI that stutters once a second.
 */
function probePort(port, host, timeoutMs) {
  const p = Number(port) || 8080;
  const h = host || "127.0.0.1";
  const t = Number(timeoutMs) || 250;
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (up) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(up);
    };
    sock.setTimeout(t);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    try {
      sock.connect(p, h);
    } catch {
      finish(false);
    }
  });
}

/* ========================================================================
 * Usage, off the agent stream
 * ===================================================================== */

/**
 * Pull the usage numbers out of one stream-json line.
 *
 * Returns null for a line that carries none, which is most of them. Every field
 * is checked rather than assumed: this parses another program's output, that
 * program is not versioned against this one, and the failure mode for a
 * confident `payload.message.usage.input_tokens` is a crash inside the console
 * that is displaying an agent's work.
 *
 * ⚠️ CONTEXT SIZE IS `input` + BOTH CACHE FIELDS, AND NOT OUTPUT. statusline.py
 * carries a comment about getting this wrong: it used to add output tokens on
 * top, which double-counts, because this turn's output is already inside next
 * turn's input. A long session then overstated its own context by every token
 * it had ever emitted. Same mistake available here; same answer.
 */
function usageFrom(payload) {
  if (!payload || typeof payload !== "object") return null;

  const u =
    (payload.message && payload.message.usage) ||
    payload.usage ||
    // opencode `--format json` reports per-step tokens at part.tokens
    // (MEASURED 2026-09-19: {input, output, ...}, no cache fields).
    // Shaped as usage so the context rule below applies unchanged.
    (payload.part && payload.part.tokens
      ? { input_tokens: payload.part.tokens.input, output_tokens: payload.part.tokens.output }
      : null) ||
    null;
  if (!u || typeof u !== "object") return null;

  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const input = n(u.input_tokens);
  const cacheRead = n(u.cache_read_input_tokens);
  const cacheWrite = n(u.cache_creation_input_tokens);
  const output = n(u.output_tokens);
  const context = input + cacheRead + cacheWrite;
  if (context === 0 && output === 0) return null;

  return {
    context,
    output,
    input,
    cacheRead,
    cacheWrite,
    // The share of this call's input that was served from cache. Normally high
    // and boring; when it DROPS the prefix was invalidated and this turn is
    // being paid for at full rate, which is the only time it is worth a glance.
    // Null rather than 0 when there was no input at all — "no data" and "0%
    // cached" are opposite readings and must not share a value.
    cacheHit: context > 0 ? (cacheRead / context) * 100 : null,
    model: typeof payload.model === "string"
      ? payload.model
      : (payload.message && typeof payload.message.model === "string" ? payload.message.model : null),
  };
}

/** The cost off a `result` line, or null. Claude Code reports it once, at the
 *  end of a turn, as a running total for the session — so it REPLACES rather
 *  than accumulates, and treating it as a delta would multiply the bill.
 *
 *  opencode is the opposite: `step_finish` carries `part.cost` PER STEP
 *  (MEASURED 2026-09-19; 0 on `:free` models), so each one ACCUMULATES — see
 *  costAccumulates() and the `accumulateCost` branch of BurnWindows.add().
 *  Returning it here keeps one cost path; the replace-vs-sum decision is made
 *  where the session key is known, not here. */
function costFrom(payload) {
  if (!payload || typeof payload !== "object") return null;
  const c = payload.total_cost_usd;
  if (typeof c === "number" && Number.isFinite(c)) return c;
  const part = payload.part;
  const step = part && part.cost;
  return typeof step === "number" && Number.isFinite(step) ? step : null;
}

/** True when costFrom()'s answer for this payload is a per-step delta that
 *  must be summed, not a running total that replaces. opencode only. */
function costAccumulates(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.total_cost_usd !== undefined) return false;
  const part = payload.part;
  return Boolean(part && typeof part.cost === "number" && Number.isFinite(part.cost));
}

/** The model off an `init` line. */
function modelFrom(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.type === "system" && typeof payload.model === "string") return payload.model;
  return null;
}

/* ========================================================================
 * Rolling spend
 * ===================================================================== */

const HOUR = 3600000;

/**
 * What the agents zevet launched have spent, over rolling windows.
 *
 * ⚠️ READ THE HEADER. This is NOT Anthropic's 5h/7d rate limit and cannot be:
 * it counts only what this copy of zevet started, on this machine, since it
 * opened, and it has no idea what the account's actual allowance is. It is
 * offered because the real windows are genuinely unavailable here and a
 * truthful smaller number beats a fabricated larger one.
 *
 * Samples are kept as a flat array and trimmed on write. A ring buffer would be
 * tidier; a week of turns is a few thousand entries and this is simpler to be
 * sure is correct.
 */
class BurnWindows {
  constructor(windows) {
    this.windows = windows || [
      { key: "5h", ms: 5 * HOUR },
      { key: "7d", ms: 7 * 24 * HOUR },
    ];
    this.longest = this.windows.reduce((m, w) => Math.max(m, w.ms), 0);
    /** @type {Array<{t:number, tokens:number, cost:number}>} */
    this.samples = [];
    /** Costs are running totals per session, so the last one seen for a session
     *  is what that session has cost; summing them would multiply it. */
    this.costBySession = new Map();
  }

  /** One turn's usage. `sessionId` may be null; it only affects cost.
   *
   *  `sample.accumulateCost` sums into the session entry instead of replacing
   *  it — for per-step costs (opencode), where replacing would keep only the
   *  last step. Running totals (Claude Code) still replace. */
  add(sample, now) {
    const t = typeof now === "number" ? now : Date.now();
    const tokens = Number(sample && sample.tokens) || 0;
    if (tokens > 0) this.samples.push({ t, tokens });
    if (sample && typeof sample.cost === "number" && Number.isFinite(sample.cost)) {
      const key = sample.sessionId || "-";
      if (sample.accumulateCost) {
        const prev = this.costBySession.get(key);
        this.costBySession.set(key, { t, cost: (prev ? prev.cost : 0) + sample.cost });
      } else {
        this.costBySession.set(key, { t, cost: sample.cost });
      }
    }
    this.trim(t);
  }

  trim(now) {
    const cutoff = now - this.longest;
    if (this.samples.length && this.samples[0].t >= cutoff) return;
    // Samples arrive in time order, so a single findIndex beats a filter.
    let i = 0;
    while (i < this.samples.length && this.samples[i].t < cutoff) i++;
    if (i) this.samples.splice(0, i);
  }

  /** `{ "5h": {tokens}, "7d": {tokens}, cost }` */
  read(now) {
    const t = typeof now === "number" ? now : Date.now();
    const out = { cost: 0 };
    for (const w of this.windows) {
      const from = t - w.ms;
      let tokens = 0;
      for (let i = this.samples.length - 1; i >= 0; i--) {
        if (this.samples[i].t < from) break;
        tokens += this.samples[i].tokens;
      }
      out[w.key] = { tokens };
    }
    for (const v of this.costBySession.values()) out.cost += v.cost;
    return out;
  }
}

/* ========================================================================
 * Finding the two things on this machine
 * ===================================================================== */

/**
 * Where the vault's health file and the hook error log live.
 *
 * ⚠️ THE PATHS ARE TAKEN FROM statusline.py ITSELF, not guessed and not
 * hardcoded. Both are personal to a machine — Andrew's vault is at
 * C:\dev\knowledge and nobody else's will be — so baking either path into the
 * product would be shipping one person's filesystem to everybody. Asking the
 * user to configure it twice, once for their status line and once for zevet, is
 * how the two come to disagree about which vault they are describing.
 *
 * So: an environment variable wins, and failing that this reads the assignment
 * out of ~/.claude/statusline.py. That file already names both paths, it is the
 * source of truth for the readout being copied, and a machine with no status
 * line simply has no vault segment — which is correct, not a gap.
 *
 * Read once at startup and not watched: a person who moves their vault can
 * restart the app.
 *
 * ⚠️ NOT VERIFIED beyond this machine's own statusline.py. The regexes below
 * match `VAULT_HEALTH = r"..."` and `ERRLOG = os.path.join(HOME, ...)` as that
 * file spells them today. A reformat there silently returns null here, which
 * shows nothing rather than showing something wrong.
 */
function discoverStatusPaths(home, env) {
  const e = env || process.env;
  const out = { vaultHealth: null, errorLog: null, cindexPort: Number(e.ZEVET_CINDEX_PORT) || 8080 };

  if (e.ZEVET_VAULT_HEALTH) out.vaultHealth = e.ZEVET_VAULT_HEALTH;
  if (e.ZEVET_HOOK_ERRORLOG) out.errorLog = e.ZEVET_HOOK_ERRORLOG;
  if (out.vaultHealth && out.errorLog) return out;

  let src = "";
  try {
    src = fs.readFileSync(require("node:path").join(home, ".claude", "statusline.py"), "utf8");
  } catch {
    return out;   // no status line on this machine; nothing to copy
  }

  if (!out.vaultHealth) {
    // `VAULT_HEALTH = r"C:\dev\knowledge\.vault\health.json"` — a raw string,
    // so backslashes are literal and must not be unescaped here.
    const m = /^\s*VAULT_HEALTH\s*=\s*r?["']([^"']+)["']/m.exec(src);
    if (m) out.vaultHealth = m[1];
  }
  if (!out.errorLog) {
    // `ERRLOG = os.path.join(HOME, ".claude", "hooks", "errors.log")`
    const m = /^\s*ERRLOG\s*=\s*os\.path\.join\(\s*HOME\s*,\s*(.+?)\)/m.exec(src);
    if (m) {
      const parts = [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
      if (parts.length) out.errorLog = require("node:path").join(home, ...parts);
    }
  }
  return out;
}

/**
 * How long ago a hook last failed, in seconds, or null.
 *
 * A hook that throws exits 0 and writes to stderr, which nothing displays — so
 * a broken hook silently does nothing, indefinitely. One stat turns that into
 * something visible. Only RECENT failures count: an old log is history, not a
 * problem, and a permanent red mark is one you stop seeing.
 */
const HOOK_FAIL_WINDOW_S = 6 * 3600;

function hookFailure(errorLogPath, now) {
  if (!errorLogPath) return null;
  try {
    const st = fs.statSync(errorLogPath);
    const ageS = ((typeof now === "number" ? now : Date.now()) - st.mtimeMs) / 1000;
    if (ageS < 0 || ageS > HOOK_FAIL_WINDOW_S) return null;
    return Math.floor(ageS);
  } catch {
    return null;   // no log is the healthy case
  }
}

module.exports = {
  discoverStatusPaths,
  hookFailure,
  HOOK_FAIL_WINDOW_S,
  vaultHealth,
  ageInDays,
  probePort,
  usageFrom,
  costFrom,
  costAccumulates,
  modelFrom,
  BurnWindows,
  STALE_AFTER_DAYS,
};
