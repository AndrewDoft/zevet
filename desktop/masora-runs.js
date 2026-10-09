// Masora agent runs on this desktop (spec 06-agent-builder §3.6, contract C5, task T10).
//
// PULL model: with the person's Masora credential and the setting on, the poller asks Masora for one queued run,
// starts it as an ordinary agent console (main.js hands in the SAME start/send path the board and schedules use --
// there is no second spawner here), and reports the outcome back with the run-scoped token.
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
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { zevetHome, atomicWriteJson } = require("./zevet-home.js");

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

function readLedger(file = LEDGER_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      deviceId: typeof raw.deviceId === "string" && raw.deviceId ? raw.deviceId : crypto.randomUUID(),
      ids: Array.isArray(raw.ids) ? raw.ids.map(String) : [],
    };
  } catch {
    return { deviceId: crypto.randomUUID(), ids: [] };
  }
}

function writeLedger(ledger, file = LEDGER_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJson(file, { deviceId: ledger.deviceId, ids: ledger.ids.slice(-LEDGER_MAX) });
}

function createClient({ baseUrl, fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const f = typeof fetchImpl === "function" ? fetchImpl : (...a) => fetch(...a);
  async function post(route, token, body) {
    let res;
    try {
      res = await f(`${base}${API}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new MasoraRunsError(`could not reach Masora: ${err && err.message ? err.message : err}`);
    }
    return res;
  }
  return {
    /** The next queued run, or null (204). */
    async claim(credential, deviceId) {
      const res = await post("/v2/agent-runs/claim", credential, { device_id: deviceId });
      if (res.status === 204) return null;
      if (!res.ok) throw new MasoraRunsError(`claim refused: HTTP ${res.status}`);
      const b = await res.json().catch(() => null);
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
        payer: body.payer ?? "",
        result_text: body.result_text ?? "",
      });
      if (res.status === 401) throw new RunTokenExpired("Masora refused the run token");
      if (!res.ok) throw new MasoraRunsError(`report refused: HTTP ${res.status}`);
    },
  };
}

function deadlineMs(d) {
  if (d == null) return null;
  const n = typeof d === "number" ? (d < 1e12 ? d * 1000 : d) : Date.parse(d);
  return Number.isFinite(n) ? n : null;
}

/**
 * deps: enabled() credential() -> {baseUrl, token}|null, start(run) -> {ok,id,error},
 *       getConsole(id), stop(id), needsYou(id), summarize(entry), resultText(entry), payer(),
 *       setOutcome(id, text), fetchImpl, ledgerFile, now, sleep
 */
class MasoraRunPoller {
  constructor(deps) {
    this.d = deps;
    this.now = deps.now || Date.now;
    this.sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.ledger = readLedger(deps.ledgerFile);
    this.busy = false; // one run at a time; a claim is only asked for when free
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => console.error(`zevet: masora runs: ${e.message}`)), this.d.pollMs || POLL_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll. Returns {run, id, done} when a run was started (done settles when its report was attempted), else null. */
  async tick() {
    const d = this.d;
    if (this.busy || !d.enabled()) return null;
    const cred = d.credential();
    if (!cred) return null;
    const client = createClient({ baseUrl: cred.baseUrl, fetchImpl: d.fetchImpl });
    const claimedAt = this.now();
    const run = await client.claim(cred.token, this.ledger.deviceId);
    if (!run) return null;
    if (this.ledger.ids.includes(run.run_id)) return null; // already claimed here: never twice
    this.ledger.ids.push(run.run_id);
    writeLedger(this.ledger, d.ledgerFile);
    if (tokenExpired(run.run_token, claimedAt, this.now())) return null; // dead on arrival: nothing may use it
    this.busy = true;
    const started = await d.start(run).catch((e) => ({ ok: false, error: e.message }));
    if (!started || !started.ok) {
      this.busy = false;
      const done = this.#report(client, run, claimedAt, null, { status: "failed", result_text: `could not start: ${(started && started.error) || "unknown"}` });
      return { run, id: null, done };
    }
    d.setOutcome(started.id, "running");
    const done = this.#watch(client, run, claimedAt, started.id).finally(() => { this.busy = false; });
    return { run, id: started.id, done };
  }

  async #watch(client, run, claimedAt, id) {
    const d = this.d;
    const end = deadlineMs(run.deadline);
    for (;;) {
      const entry = d.getConsole(id);
      if (!entry) return this.#report(client, run, claimedAt, id, { status: "failed", result_text: "console vanished" });
      if (!entry.running || entry.state === "idle") {
        const s = d.summarize(entry);
        const status = entry.isError ? "failed" : "done";
        return this.#report(client, run, claimedAt, id, { status, ...this.#facts(s, entry) });
      }
      if (d.needsYou(id)) {
        return this.#report(client, run, claimedAt, id, { status: "needs_you", ...this.#facts(d.summarize(entry), entry), result_text: "waiting on a permission prompt" });
      }
      if (end != null && this.now() >= end) {
        d.stop(id);
        return this.#report(client, run, claimedAt, id, { status: "failed", ...this.#facts(d.summarize(entry), entry), result_text: "deadline passed" });
      }
      await this.sleep(this.d.watchMs || WATCH_MS);
    }
  }

  #facts(s, entry) {
    return {
      session_id: s.sessionId,
      usage: s.usage,
      cost_reported: s.costUsd,
      elapsed_ms: s.elapsedMs,
      payer: this.d.payer(),
      result_text: this.d.resultText(entry),
    };
  }

  async #report(client, run, claimedAt, id, body) {
    const label = { done: "done", failed: "failed", needs_you: "needs you" }[body.status];
    try {
      await client.report(run, claimedAt, body, this.now());
      if (id) this.d.setOutcome(id, `${label} · reported`);
    } catch (err) {
      const why = err instanceof RunTokenExpired ? "token expired, not reported" : `report failed: ${err.message}`;
      if (id) this.d.setOutcome(id, `${label} · ${why}`);
      else console.error(`zevet: masora run ${run.run_id}: ${why}`);
    }
  }
}

module.exports = { createClient, MasoraRunPoller, tokenExpired, tokenExp, RunTokenExpired, MasoraRunsError, LEDGER_PATH, readLedger };
