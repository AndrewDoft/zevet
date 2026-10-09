// Masora `browser.task` on this desktop (contract: docs/contracts/browser-task.md; Masora half:
// masora2 docs/contracts/browser-task.md). Same PULL shape and the same guarantees as masora-runs.js:
//
//   POST /api/v2/browser-tasks/claim          Bearer <person credential>  {device_id}
//     -> 200 {task_id, action_id, start_url, instruction, allowed_domains, max_steps, max_usd, payload_sha256,
//             allowed_providers, deadline, task_token} | 204
//   POST /api/v2/browser-tasks/{id}/report    Bearer <task_token>  {status, steps, final_url, screenshot_sha256, reason, cost_usd}
//
// GUARANTEES
//   * A claim never runs twice: the task id is in the ledger BEFORE the runner starts; a re-offered id is dropped.
//   * The report is rebuilt here from the runner's JSON, field by field, against the closed vocabulary. A key the
//     contract does not name never leaves this process, and neither does page text (the runner has none to give).
//   * Masora's own re-check is repeated here: an off-fence URL, more steps than approved or a cost over max_usd
//     turns the report into `failed` before it is sent.
//   * A crash, a timeout or garbage from the runner is a `failed` / `error` report, never silence.
//   * A task claimed but never reported (restart mid-task) is reported `failed` / `error` at the next start; a finished
//     task whose report could not be delivered is re-sent as it was, not turned into a failure.
//   * An expired task_token is never presented (tokenExpired); a 401 counts as expiry.
//   * One task at a time. Off unless the person switched `browserTasks` on.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { zevetHome, atomicWriteJson } = require("./zevet-home.js");
const { postJson } = require("./masora.js");
const { tokenExpired, tokenExp, parseDeadline } = require("./masora-runs.js");

const LEDGER_PATH = path.join(zevetHome(), "masora-browser-tasks.json");
const API = "/api";
const POLL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const LEDGER_MAX = 500;
const LEASE_MS = 3600 * 1000; // Masora's lease; the runner gets less
const RUN_BUDGET_MS = 45 * 60 * 1000;
const KILL_GRACE_MS = 30_000;
const STDOUT_MAX = 1 << 20;
const VERBS = new Set(["navigate", "click", "type", "select", "scroll", "wait", "extract", "upload", "other"]);
const REASONS = new Set(["off_domain", "max_steps", "cost_cap", "model_not_allowed", "login_required", "error"]);
const EMPTY_SHA256 = crypto.createHash("sha256").update("").digest("hex"); // "no screenshot": the hash of nothing
const SHA256 = /^[0-9a-f]{64}$/;

class TaskTokenExpired extends Error {}
class BrowserTasksError extends Error {}

const UNSAFE = /[\x00-\x20\x7f\x5c]/; // control chars, space, tab/newline/CR and backslash (\x5c): WHATWG reads a backslash as "/", the runner parser does not
const DNS_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const NUMBER_LABEL = /^(?:\d+|0x[0-9a-f]*)$/; // WHATWG "ends in a number"

/** A plain DNS name: ASCII labels, not a number or IP literal, not localhost. Same rules as runner.py `clean_host`. */
function cleanHost(host) {
  if (!host || host.length > 253 || !DNS_NAME.test(host) || NUMBER_LABEL.test(host.slice(host.lastIndexOf(".") + 1))) return false;
  return host !== "localhost" && !host.endsWith(".localhost");
}

/** The lowercase host of a URL we are willing to judge, else null. Same rules as runner.py `judge_url` (fail closed); the
 *  authority is read from the raw string because `new URL` rewrites exactly what must be refused (backslash, %, 127.1, IDNA). */
function judgeUrl(url) {
  if (typeof url !== "string" || UNSAFE.test(url)) return null;
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)/.exec(url);
  if (!m) return null;
  const a = /^([^:]*)(?::(\d{0,5}))?$/.exec(m[2]);
  if (!a || /[^\x00-\x7f]|[@%]/.test(m[2])) return null;
  try {
    new URL(url);
  } catch {
    return null;
  }
  const host = a[1].toLowerCase().replace(/\.+$/, "");
  return cleanHost(host) ? { scheme: m[1].toLowerCase(), host } : null;
}

const normDomain = (d) => String(d).toLowerCase().replace(/^\.+|\.+$/g, "");
const cleanDomains = (domains) => Array.isArray(domains) && domains.length > 0 && domains.every((d) => cleanHost(normDomain(d)));

/** host == domain or a subdomain of it on a label boundary; https only; no userinfo, backslash, numeric host. */
function inFence(url, domains) {
  const j = judgeUrl(url);
  if (!j || j.scheme !== "https" || !cleanDomains(domains)) return false;
  return domains.map(normDomain).some((d) => j.host === d || j.host.endsWith(`.${d}`));
}

/** sha256 hex of canonical JSON: sorted keys, no whitespace, non-ASCII raw (= Python json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)). */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const payloadHash = (b) => crypto.createHash("sha256").update(canonical({
  start_url: b.start_url, instruction: b.instruction, allowed_domains: b.allowed_domains, max_steps: b.max_steps,
}), "utf8").digest("hex");

/** scheme://host/path -- no query, no fragment. */
function stripUrl(url) {
  try {
    const u = new URL(String(url));
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 2000);
  } catch {
    return "";
  }
}

/**
 * The runner's JSON -> exactly the contract's report. `task` supplies the fence and the approved limits.
 * Anything missing, malformed or out of bounds degrades to failed; it never degrades to done.
 */
function buildReport(raw, task) {
  const domains = task.allowed_domains.map((d) => String(d).toLowerCase());
  const startUrl = stripUrl(task.start_url);
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  let reason = r && REASONS.has(r.reason) ? r.reason : null;
  let status = r && r.status === "done" ? "done" : "failed";
  if (!r) reason = "error";

  const steps = [];
  for (const s of r && Array.isArray(r.steps) ? r.steps : []) {
    if (!s || !VERBS.has(s.verb) || typeof s.ok !== "boolean" || typeof s.url !== "string") continue;
    const url = stripUrl(s.url);
    if (!inFence(url, domains)) {
      status = "failed";
      reason = "off_domain";
      continue; // the URL itself is not forwarded
    }
    steps.push({ verb: s.verb, url, ok: s.ok });
  }
  if (steps.length > task.max_steps) {
    steps.length = task.max_steps;
    status = "failed";
    reason = reason || "max_steps";
  }

  let finalUrl = r && typeof r.final_url === "string" ? stripUrl(r.final_url) : "";
  if (!finalUrl || !inFence(finalUrl, domains)) {
    if (finalUrl) {
      status = "failed";
      reason = "off_domain";
    }
    finalUrl = (steps.length && steps[steps.length - 1].url) || startUrl;
  }

  const measured = r && Number.isFinite(r.cost_usd) && r.cost_usd >= 0; // the cap is only as good as the number: no number = failed
  let cost = measured ? r.cost_usd : 0;
  if (!measured) {
    status = "failed";
    reason = "error";
  } else if (cost > task.max_usd) {
    status = "failed";
    reason = "cost_cap";
  }
  if (status === "done" && reason) status = "failed"; // a reason code is only ever a failure's
  if (status === "failed" && !reason) reason = "error";
  const sha = r && typeof r.screenshot_sha256 === "string" && SHA256.test(r.screenshot_sha256) ? r.screenshot_sha256 : EMPTY_SHA256;
  return { status, steps, final_url: finalUrl, screenshot_sha256: sha, reason: status === "done" ? null : reason, cost_usd: cost };
}

/** The report for a task that never got an answer from the runner. */
const failedReport = (startUrl, reason = "error") => ({
  status: "failed", steps: [], final_url: stripUrl(startUrl) || startUrl, screenshot_sha256: EMPTY_SHA256, reason, cost_usd: 0,
});

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
      if (o && typeof o.task_token === "string" && Number.isFinite(o.claimedAt) && typeof o.start_url === "string") {
        open[id] = { task_token: o.task_token, claimedAt: o.claimedAt, start_url: o.start_url, ...(o.pending && typeof o.pending === "object" ? { pending: o.pending } : {}) };
      }
    }
    const hasId = typeof raw.deviceId === "string" && raw.deviceId;
    return { deviceId: hasId ? raw.deviceId : crypto.randomUUID(), ids: Array.isArray(raw.ids) ? raw.ids.map(String) : [], open, fresh: !hasId, corrupt: false };
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
  console.error(`zevet: browser tasks: ledger ${file} is unreadable (${err && err.message}); not claiming until it is fixed or removed`);
  return { deviceId: "", ids: [], open: {}, fresh: false, corrupt: true };
}

function writeLedger(ledger, file = LEDGER_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 0600: `open` holds task tokens
  atomicWriteJson(file, { deviceId: ledger.deviceId, ids: ledger.ids.slice(-LEDGER_MAX), open: ledger.open }, { mode: 0o600 });
}

function createClient({ baseUrl, fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  async function post(route, token, body) {
    try {
      return await postJson(baseUrl, `${API}${route}`, token, body, timeoutMs, fetchImpl);
    } catch (err) {
      throw new BrowserTasksError(`could not reach Masora: ${err && err.message ? err.message : err}`);
    }
  }
  return {
    /** The next queued task, or null (204). */
    async claim(credential, deviceId) {
      const res = await post("/v2/browser-tasks/claim", credential, { device_id: deviceId });
      if (res.status === 204) return null;
      if (!res.ok) throw new BrowserTasksError(`claim refused: HTTP ${res.status}`);
      const b = res.body;
      const str = (v) => typeof v === "string" && v;
      if (!b || !str(b.task_id) || !str(b.task_token) || !str(b.start_url) || typeof b.instruction !== "string" ||
          !Array.isArray(b.allowed_domains) || !b.allowed_domains.length || !b.allowed_domains.every(str) ||
          !Number.isInteger(b.max_steps) || b.max_steps < 1 || !Number.isFinite(b.max_usd) || b.max_usd < 0) {
        throw new BrowserTasksError("claim answered without the fields of the contract");
      }
      return {
        task_id: b.task_id, action_id: typeof b.action_id === "string" ? b.action_id : "", start_url: b.start_url, instruction: b.instruction,
        allowed_domains: b.allowed_domains.map((d) => d.toLowerCase()), max_steps: b.max_steps, max_usd: b.max_usd,
        payload_ok: b.payload_sha256 === payloadHash(b), // what we run is what Masora approved; a mismatch is refused in #execute
        allowed_providers: Array.isArray(b.allowed_providers) ? b.allowed_providers.map(String) : null,
        deadline: b.deadline ?? null, task_token: b.task_token,
      };
    },
    async report(taskId, token, claimedAt, body, now = Date.now()) {
      if (tokenExpired(token, claimedAt, now)) throw new TaskTokenExpired("task token expired");
      if (!Number.isFinite(body.cost_usd) || body.cost_usd < 0) throw new BrowserTasksError("report has no numeric cost_usd"); // Masora answers 422 to null
      const res = await post(`/v2/browser-tasks/${encodeURIComponent(taskId)}/report`, token, {
        status: body.status, steps: body.steps, final_url: body.final_url,
        screenshot_sha256: body.screenshot_sha256, reason: body.reason, cost_usd: body.cost_usd,
      });
      if (res.status === 401) throw new TaskTokenExpired("Masora refused the task token");
      if (res.status === 409) return; // already closed on Masora's side (a second report): nothing owed
      if (!res.ok) throw new BrowserTasksError(`report refused: HTTP ${res.status}`);
    },
  };
}

/**
 * Runs the Python runner: JSON on stdin, ONE JSON line on stdout. Resolves the parsed object, or rejects (crash,
 * timeout, no JSON). The child's whole tree is killed at `timeoutMs`.
 */
function spawnRunner({ python, script, input, timeoutMs, env, pyArgs = ["-I", "-B"] }) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [...pyArgs, script, "run"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env: env || process.env });
    let out = "";
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(v);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish(reject, new Error("runner timed out"));
    }, timeoutMs);
    child.stdout.on("data", (c) => {
      if (out.length < STDOUT_MAX) out += c;
    });
    child.on("error", (e) => finish(reject, e));
    child.on("close", (code) => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop();
      try {
        finish(resolve, JSON.parse(line));
      } catch {
        finish(reject, new Error(`runner exited ${code} without a JSON result`));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

function killTree(child) {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
    else child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * deps: enabled(), credential() -> {baseUrl, token}|null, runnerConfig() -> {python, script, config}|null,
 *       run({python, script, input, timeoutMs}) -> result (default spawnRunner), setOutcome(taskId, text),
 *       fetchImpl, ledgerFile, now, pollMs
 */
class BrowserTaskPoller {
  constructor(deps) {
    this.d = deps;
    this.now = deps.now || Date.now;
    this.ledger = readLedger(deps.ledgerFile);
    this.busy = false;
    this.claiming = false;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    const tick = () => void this.tick().catch((e) => console.error(`zevet: browser tasks: ${e.message}`));
    this.timer = setInterval(tick, this.d.pollMs || POLL_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
    tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll. Returns {task, done} when a task was started (done settles when its report was attempted), else null. */
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
    // Before the enabled check: an unreported task is owed its report even if polling was switched off since.
    for (const [id, o] of Object.entries(this.ledger.open)) await this.#abandon(client, id, o);
    if (!d.enabled()) return null;
    if (this.ledger.fresh) {
      writeLedger(this.ledger, d.ledgerFile);
      this.ledger.fresh = false;
    }
    const claimedAt = this.now();
    const task = await client.claim(cred.token, this.ledger.deviceId);
    if (!task) return null;
    if (this.ledger.ids.includes(task.task_id)) {
      const o = this.ledger.open[task.task_id];
      if (o) await this.#abandon(client, task.task_id, { ...o, task_token: task.task_token }); // offered again: the process that held it is gone
      return null; // already claimed here: never twice
    }
    this.ledger.ids.push(task.task_id);
    this.ledger.open[task.task_id] = { task_token: task.task_token, claimedAt, start_url: stripUrl(task.start_url) };
    writeLedger(this.ledger, d.ledgerFile);
    if (tokenExpired(task.task_token, claimedAt, this.now())) {
      this.#close(task.task_id); // dead on arrival: nothing may use it
      return null;
    }
    this.busy = true;
    const done = this.#execute(client, task, claimedAt).catch((e) => console.error(`zevet: browser task ${task.task_id}: ${e.message}`)).finally(() => {
      this.busy = false;
    });
    return { task, done };
  }

  async #execute(client, task, claimedAt) {
    const d = this.d;
    const out = (text) => d.setOutcome && d.setOutcome(task.task_id, text);
    let body;
    const cfg = d.runnerConfig();
    if (!task.payload_ok) {
      body = failedReport(task.start_url);
      out("failed · claim does not match its payload_sha256, not run");
    } else if (!cleanDomains(task.allowed_domains)) {
      body = failedReport(task.start_url);
      out("failed · allowed_domains has an entry that is not a plain domain name, not run");
    } else if (!inFence(task.start_url, task.allowed_domains)) {
      body = failedReport(task.start_url, "off_domain");
      out("failed · start_url is outside allowed_domains, not run");
    } else if (!cfg) {
      body = failedReport(task.start_url);
      out("failed · browser runner not set up");
    } else {
      const bound = this.#bound(task, claimedAt);
      const timeoutMs = Math.max(1000, bound - this.now());
      out("running");
      try {
        const raw = await (d.run || spawnRunner)({
          python: cfg.python, script: cfg.script, timeoutMs: timeoutMs + KILL_GRACE_MS, env: cfg.env,
          input: { task: taskForRunner(task), config: { ...cfg.config, timeout_s: Math.floor(timeoutMs / 1000) } },
        });
        body = buildReport(raw, task);
      } catch (err) {
        console.error(`zevet: browser task ${task.task_id}: runner failed (${err.message})`);
        body = failedReport(task.start_url);
      }
    }
    await this.#report(client, task.task_id, this.ledger.open[task.task_id], body, out);
  }

  /** When the runner must be done: the earliest of the deadline, token expiry, claim + 45 min (lease is 1 h). */
  #bound(task, claimedAt) {
    return Math.min(parseDeadline(task.deadline) ?? Infinity, (tokenExp(task.task_token) ?? Infinity) - 60_000, claimedAt + Math.min(RUN_BUDGET_MS, LEASE_MS));
  }

  /** Report a claimed-but-unreported task: the finished answer if we hold one, else `failed` / `error`. */
  async #abandon(client, id, o) {
    await this.#report(client, id, o, o.pending || failedReport(o.start_url), null);
  }

  async #report(client, id, o, body, out) {
    try {
      await client.report(id, o.task_token, o.claimedAt, body, this.now());
      if (out) out(`${body.status} · reported`);
    } catch (err) {
      if (!(err instanceof TaskTokenExpired)) {
        console.error(`zevet: browser task ${id}: report failed (${err.message}); will retry`);
        if (out) out(`${body.status} · report failed: ${err.message}`);
        if (!o.pending && body.status) {
          o.pending = body; // keep the finished answer for the retry
          try {
            writeLedger(this.ledger, this.d.ledgerFile);
          } catch (e) {
            console.error(`zevet: browser task ${id}: ledger not updated (${e.message})`);
          }
        }
        return; // stays open; the token's own expiry ends the retries
      }
      if (out) out(`${body.status} · token expired, not reported`);
    }
    try {
      this.#close(id);
    } catch (err) {
      console.error(`zevet: browser task ${id}: ledger not updated (${err.message})`);
    }
  }

  #close(id) {
    delete this.ledger.open[id];
    writeLedger(this.ledger, this.d.ledgerFile);
  }
}

/** What the runner is told: the claim, minus the tokens (it never sees task_token). */
function taskForRunner(t) {
  return { task_id: t.task_id, start_url: t.start_url, instruction: t.instruction, allowed_domains: t.allowed_domains,
    max_steps: t.max_steps, max_usd: t.max_usd, allowed_providers: t.allowed_providers };
}

/**
 * Wiring: ctx {masora, safeStorage, setOutcome?}. The runner is configured by `<zevetHome>/browser-task.json`
 * (person-controlled): {python, models:[{provider, client, model, base_url?, api_key_env?}], chrome_path?, secrets_file?}.
 * Missing file or python => runnerConfig() is null and a claimed task is reported failed, visibly.
 */
function startMasoraBrowserTasks(ctx) {
  try {
    const { masora, safeStorage } = ctx;
    const home = zevetHome();
    const poller = new BrowserTaskPoller({
      ledgerFile: ctx.ledgerFile,
      enabled: () => masora.readConfig().browserTasks,
      credential: () => {
        const cfg = masora.readConfig();
        if (!cfg.paired || !safeStorage.isEncryptionAvailable()) return null;
        const token = masora.loadToken((buf) => safeStorage.decryptString(buf));
        return token ? { baseUrl: cfg.url, token } : null;
      },
      runnerConfig: () => {
        let c;
        try {
          c = JSON.parse(fs.readFileSync(path.join(home, "browser-task.json"), "utf8"));
        } catch {
          return null;
        }
        if (!c || typeof c.python !== "string" || !Array.isArray(c.models) || !c.models.length) return null;
        return {
          python: c.python, script: path.join(__dirname, "browser-task", "runner.py"),
          config: { profile_dir: path.join(home, "browser-profile"), secrets_file: c.secrets_file || path.join(home, "browser-secrets.json"),
            chrome_path: c.chrome_path || null, models: c.models },
        };
      },
      setOutcome: ctx.setOutcome,
    });
    poller.start();
    return poller;
  } catch (err) {
    console.error(`zevet: browser tasks did not start: ${err.message}`); // never stops the window or the updater
    return null;
  }
}

module.exports = {
  BrowserTaskPoller, createClient, buildReport, failedReport, inFence, stripUrl, spawnRunner, startMasoraBrowserTasks,
  judgeUrl, cleanHost, payloadHash, readLedger, LEDGER_PATH, TaskTokenExpired, BrowserTasksError, EMPTY_SHA256,
};
