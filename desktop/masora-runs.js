// Masora agent runs on this desktop (spec 06-agent-builder §3.6, contract C5, task T10).
//
// PULL model: with the person's Masora credential and the setting on, the poller asks Masora for one queued run,
// starts it as an ordinary agent console (masora-runs-wire.js hands in the SAME start/send path the board and
// schedules use -- there is no second spawner here), and reports the outcome back with the run-scoped token.
//
// Wire shapes below are copied from the spec; Masora's endpoints (T9) did not exist when this was written, so
// nothing here has met a real server:
//   POST /v2/agent-runs/claim        Bearer <person credential>  {device_id}
//     -> 200 {run_id, run_token, brief, repo_hint, allowed_actions, deadline} | 204
//   POST /v2/agent-runs/{id}/report  Bearer <run_token>  {status, session_id, usage, cost_reported, elapsed_ms, payer, result_text}
//
// GUARANTEES
//   * A claim never runs twice: the run id is written to a ledger BEFORE the console starts, and a claim whose
//     id is already in it is dropped.
//   * An expired run_token is never presented: `tokenExpired` refuses locally, and a 401 from Masora counts as expiry.
//   * Every outcome lands on the subagent row (`setOutcome`), including a report that could not be delivered.
//   * A run claimed but never reported (the app restarted mid-run) is reported `failed` "desktop restarted" at the
//     next start, from the ledger's `open` list, and cleared.
//   * A corrupt ledger is copied aside and nothing is claimed until it is fixed: resetting it would void "never twice".
//   * A run with `allowed_actions` is refused (failed, visibly): this desktop does not submit /actions yet.
//   * Only one run at a time, and it stays ours until its console has finished or the run is reported terminal.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { zevetHome, atomicWriteJson } = require("./zevet-home.js");
const { postJson } = require("./masora.js");

const LEDGER_PATH = path.join(zevetHome(), "masora-runs.json");
const API = "/api"; // the other Masora calls in this app (briefFor, pairing) sit under /api
const POLL_MS = 30_000;
const WATCH_MS = 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const LEDGER_MAX = 500;
const TOKEN_TTL_MS = 4 * 3600 * 1000; // spec: jwts.mint(..., ttl=4h); used only when the token carries no exp

class RunTokenExpired extends Error {}
class MasoraRunsError extends Error {}

/** exp (ms) from a JWT-shaped token, else null. */
function tokenExp(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const exp = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** `claimedAt` backs the 4 h TTL when the token does not say. */
function tokenExpired(token, claimedAt, now) {
  const exp = tokenExp(token);
  return (exp ?? claimedAt + TOKEN_TTL_MS) <= now;
}

/**
 * {deviceId, ids, open, fresh, corrupt}. `open` = run_id -> {run_token, claimedAt}: claimed, not yet reported.
 * A missing file is a first launch; an unreadable or malformed one is `corrupt` (copied aside, left in place).
 */
function readLedger(file = LEDGER_PATH) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { deviceId: crypto.randomUUID(), ids: [], open: {}, fresh: true, corrupt: false };
    return corruptLedger(file, err);
  }
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
    const open = {};
    for (const [id, o] of Object.entries(raw.open && typeof raw.open === "object" ? raw.open : {})) {
      if (o && typeof o.run_token === "string" && Number.isFinite(o.claimedAt)) open[id] = { run_token: o.run_token, claimedAt: o.claimedAt };
    }
    const hasId = typeof raw.deviceId === "string" && raw.deviceId;
    return {
      deviceId: hasId ? raw.deviceId : crypto.randomUUID(),
      ids: Array.isArray(raw.ids) ? raw.ids.map(String) : [],
      open,
      fresh: !hasId,
      corrupt: false,
    };
  } catch (err) {
    try {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* the original stays in place regardless */
    }
    return corruptLedger(file, err);
  }
}

function corruptLedger(file, err) {
  console.error(`zevet: masora runs: ledger ${file} is unreadable (${err && err.message}); not claiming runs until it is fixed or removed`);
  return { deviceId: "", ids: [], open: {}, fresh: false, corrupt: true };
}

function writeLedger(ledger, file = LEDGER_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJson(file, { deviceId: ledger.deviceId, ids: ledger.ids.slice(-LEDGER_MAX), open: ledger.open });
}

function createClient({ baseUrl, fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  async function post(route, token, body) {
    try {
      return await postJson(baseUrl, `${API}${route}`, token, body, timeoutMs, fetchImpl);
    } catch (err) {
      throw new MasoraRunsError(`could not reach Masora: ${err && err.message ? err.message : err}`);
    }
  }
  return {
    /** The next queued run, or null (204). */
    async claim(credential, deviceId) {
      const res = await post("/v2/agent-runs/claim", credential, { device_id: deviceId });
      if (res.status === 204) return null;
      if (!res.ok) throw new MasoraRunsError(`claim refused: HTTP ${res.status}`);
      const b = res.body;
      if (!b || typeof b.run_id !== "string" || !b.run_id || typeof b.run_token !== "string" || !b.run_token || typeof b.brief !== "string") {
        throw new MasoraRunsError("claim answered without run_id, run_token and brief");
      }
      return {
        run_id: b.run_id,
        run_token: b.run_token,
        brief: b.brief,
        repo_hint: typeof b.repo_hint === "string" ? b.repo_hint : "",
        allowed_actions: Array.isArray(b.allowed_actions) ? b.allowed_actions : [],
        deadline: b.deadline ?? null,
      };
    },
    async report(run, claimedAt, body, now = Date.now()) {
      if (tokenExpired(run.run_token, claimedAt, now)) throw new RunTokenExpired("run token expired");
      const res = await post(`/v2/agent-runs/${encodeURIComponent(run.run_id)}/report`, run.run_token, {
        status: body.status,
        session_id: body.session_id ?? "",
        usage: body.usage ?? null,
        cost_reported: body.cost_reported ?? null,
        elapsed_ms: body.elapsed_ms ?? 0,
        payer: body.payer || "unknown", // never "": a report that cannot name its payer says so
        result_text: body.result_text ?? "",
      });
      if (res.status === 401) throw new RunTokenExpired("Masora refused the run token");
      if (!res.ok) throw new MasoraRunsError(`report refused: HTTP ${res.status}`);
    },
  };
}

/**
 * A deadline as epoch ms, or null. ISO without a zone is UTC (Date.parse alone would read it as local time);
 * numbers and digit strings are epoch seconds (milliseconds past 1e12).
 */
function parseDeadline(d) {
  if (d == null || d === "") return null;
  if (typeof d === "number" || /^\d+(\.\d+)?$/.test(String(d).trim())) {
    const n = Number(d);
    return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : null;
  }
  const t = String(d).trim();
  const n = Date.parse(/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(t) ? `${t.replace(" ", "T")}Z` : t);
  return Number.isFinite(n) ? n : null;
}

/** When a run must end: the deadline it names if usable, else the earlier of the token's expiry and claim + 4 h. */
function runBound(run, claimedAt) {
  const named = parseDeadline(run.deadline);
  if (named != null) return named;
  return Math.min(tokenExp(run.run_token) ?? Infinity, claimedAt + TOKEN_TTL_MS);
}

/**
 * deps: enabled() credential() -> {baseUrl, token}|null, start(run) -> {ok,id,error}, getConsole(id), stop(id),
 *       needsYou(id), summarize(entry), resultText(entry), payer() -> label|"", isRelaunching(),
 *       setOutcome(id, text), fetchImpl, ledgerFile, now, sleep
 */
class MasoraRunPoller {
  constructor(deps) {
    this.d = deps;
    this.now = deps.now || Date.now;
    this.sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.ledger = readLedger(deps.ledgerFile);
    // The device id belongs to this install, not to its first claim.
    if (this.ledger.fresh && !this.ledger.corrupt) writeLedger(this.ledger, deps.ledgerFile);
    this.busy = false; // one run at a time, until its console has finished or the run is reported terminal
    this.claiming = false; // set at the top of tick: overlapping ticks must not both reach the claim
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    const tick = () => void this.tick().catch((e) => console.error(`zevet: masora runs: ${e.message}`));
    this.timer = setInterval(tick, this.d.pollMs || POLL_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
    tick(); // startup: report whatever the last process left unreported
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll. Returns {run, id, done} when a run was started (done settles when its report was attempted), else null. */
  async tick() {
    if (this.busy || this.claiming || this.ledger.corrupt) return null;
    this.claiming = true;
    try {
      return await this.#claimOne();
    } finally {
      this.claiming = false;
    }
  }

  async #claimOne() {
    const d = this.d;
    const cred = d.credential();
    if (!cred) return null;
    const client = createClient({ baseUrl: cred.baseUrl, fetchImpl: d.fetchImpl });
    // Before the enabled check: an unreported run is owed its report even if polling was switched off since.
    for (const [id, o] of Object.entries(this.ledger.open)) await this.#abandon(client, id, o.run_token, o.claimedAt);
    if (!d.enabled()) return null;
    const claimedAt = this.now();
    const run = await client.claim(cred.token, this.ledger.deviceId);
    if (!run) return null;
    if (this.ledger.ids.includes(run.run_id)) {
      // Offered again: if we never reported it, the process that held it is gone.
      const o = this.ledger.open[run.run_id];
      if (o) await this.#abandon(client, run.run_id, run.run_token, o.claimedAt);
      return null; // already claimed here: never twice
    }
    this.ledger.ids.push(run.run_id);
    this.ledger.open[run.run_id] = { run_token: run.run_token, claimedAt };
    writeLedger(this.ledger, d.ledgerFile);
    if (tokenExpired(run.run_token, claimedAt, this.now())) {
      this.#close(run.run_id); // dead on arrival: nothing may use it
      return null;
    }
    const refuse = this.#refusal(run);
    if (refuse) return { run, id: null, done: this.#report(client, run, claimedAt, null, { status: "failed", result_text: refuse }) };
    const payer = d.payer();
    this.busy = true;
    const started = await d.start(run).catch((e) => ({ ok: false, error: e.message }));
    if (!started || !started.ok) {
      this.busy = false;
      const done = this.#report(client, run, claimedAt, null, { status: "failed", result_text: `could not start: ${(started && started.error) || "unknown"}` });
      return { run, id: null, done };
    }
    d.setOutcome(started.id, "running");
    const done = this.#watch(client, run, claimedAt, started.id, payer).finally(() => {
      this.busy = false;
    });
    return { run, id: started.id, done };
  }

  /** Why this run must not start here, or "". */
  #refusal(run) {
    // ponytail: /actions submission is not built; a run that may act would silently not, so it is refused until it is.
    if (run.allowed_actions.length) return "actions not supported by this Zevet";
    if (!this.d.payer()) return "could not tell who pays for this run (no Claude account label)";
    return "";
  }

  /** Report a claimed-but-unreported run `failed` ("desktop restarted"), then forget it. */
  async #abandon(client, id, token, claimedAt) {
    try {
      await client.report({ run_id: id, run_token: token }, claimedAt, { status: "failed", result_text: "desktop restarted", payer: this.d.payer() }, this.now());
    } catch (err) {
      if (!(err instanceof RunTokenExpired)) {
        console.error(`zevet: masora run ${id}: could not report the restart (${err.message}); will retry`);
        return; // stays open; the token's own expiry ends the retries
      }
    }
    this.#close(id);
  }

  #close(id) {
    delete this.ledger.open[id];
    writeLedger(this.ledger, this.d.ledgerFile);
  }

  async #watch(client, run, claimedAt, id, payer) {
    const d = this.d;
    const end = runBound(run, claimedAt);
    let needsReported = false;
    const finish = async (status, entry, text) => {
      await this.#report(client, run, claimedAt, id, { status, ...this.#facts(entry, payer), ...(text ? { result_text: text } : {}) });
      d.stop(id); // a finished run's console has nothing left to say (needs_you is the one that stays up)
    };
    for (;;) {
      const entry = d.getConsole(id);
      if (!entry) return this.#report(client, run, claimedAt, id, { status: "failed", result_text: "console vanished", payer });
      // Not while the app is relaunching: its consoles are stopped and restored under the same id, so that exit is not the run's end.
      if (!(d.isRelaunching && d.isRelaunching())) {
        const waiting = d.needsYou(id);
        if (!entry.running) return finish(entry.isError || !entry.turns ? "failed" : "done", entry, entry.turns ? "" : "agent exited before answering");
        // A new console starts idle, before its brief is even sent: idle only means finished once a turn has happened.
        if (entry.state === "idle" && entry.turns > 0 && !waiting) return finish(entry.isError ? "failed" : "done", entry);
        if (waiting && !needsReported) {
          needsReported = true; // reported once; the console stays up for the answer and the run stays ours until it ends
          await this.#report(client, run, claimedAt, id, { status: "needs_you", ...this.#facts(entry, payer), result_text: "waiting on a permission prompt" });
        } else if (!waiting) needsReported = false;
        if (this.now() >= end) {
          d.stop(id);
          return this.#report(client, run, claimedAt, id, { status: "failed", ...this.#facts(entry, payer), result_text: "deadline passed" });
        }
      }
      await this.sleep(d.watchMs || WATCH_MS);
    }
  }

  #facts(entry, payer) {
    const s = this.d.summarize(entry);
    return {
      session_id: s.sessionId,
      usage: s.usage,
      cost_reported: s.costUsd,
      elapsed_ms: s.elapsedMs,
      payer,
      result_text: this.d.resultText(entry),
    };
  }

  async #report(client, run, claimedAt, id, body) {
    const label = { done: "done", failed: "failed", needs_you: "needs you" }[body.status] || String(body.status);
    try {
      await client.report(run, claimedAt, body, this.now());
      if (id) this.d.setOutcome(id, `${label} · reported`);
    } catch (err) {
      const why = err instanceof RunTokenExpired ? "token expired, not reported" : `report failed: ${err.message}`;
      if (id) this.d.setOutcome(id, `${label} · ${why}`);
      else console.error(`zevet: masora run ${run.run_id}: ${why}`);
    }
    if (body.status !== "needs_you") this.#close(run.run_id);
  }
}

module.exports = { createClient, MasoraRunPoller, tokenExpired, tokenExp, parseDeadline, runBound, RunTokenExpired, MasoraRunsError, LEDGER_PATH, readLedger };
