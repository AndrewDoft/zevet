"use strict";
// Starting an agent on a teammate's machine (D-060) — the sibling of
// agent-steer.js, desktop side. No Electron in here, so node --test drives it
// all; main.js supplies workspaces, the start, the approval card, the hub.
//
// SENDER: seal {prompt} with the document key, the AAD binding every choice
// the sender made (id, person, repo, agent, model), and POST /api/spawn.
//
// OWNER: the hub pushes `spawn` on this person's private channel. This opens
// it, reports `delivered`, resolves the repo NAME against this app's own open
// workspaces (never a path), enforces the cap on running remote-started
// agents, asks the person when the policy says `ask` — the card names the
// agent, the folder and the whole prompt — and only then starts it, in the
// owner's own SAFE mode, and reports `started` with the new session id.
//
// ⚠️ HIGHER RISK THAN A STEER: a new process with the owner's credentials.
// Nothing the sender sends decides how it runs. Mode, flags, permissions,
// engine, extra directories, a system prompt: none is read from the message
// (the hub refuses a body carrying them, and this ignores them anyway).

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { loadDocCrypto, TEXT_MAX } = require("./agent-steer.js");

const AGENTS = new Set(["claude", "codex", "opencode"]);
/** A folder NAME: no separator, no drive, no leading dot, no "..". */
const REPO_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,79}$/;
const MAX_RUNNING = 3;
const ASK_TIMEOUT_MS = 10 * 60 * 1000;
const SESSION_WAIT_MS = 30 * 1000;
const SAFE_MODES = new Set(["plan", "ask"]);
const SEEN_MAX = 1000;

const validRepo = (r) => typeof r === "string" && REPO_RE.test(r) && !r.includes("..");

function aadFor({ id, to, repo, agent, model }) {
  return ["spawn", id, String(to || "").toLowerCase().replace(/^@/, ""), repo, agent, model || ""].join("\u0000");
}

function seal(docCrypto, key, meta, text) {
  return docCrypto.seal(key, aadFor(meta), Buffer.from(text, "utf8")).toString("base64");
}

function open(docCrypto, key, meta, sealed) {
  return docCrypto.open(key, aadFor(meta), Buffer.from(String(sealed || ""), "base64")).toString("utf8");
}

function cleanText(text) {
  return String(text || "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
}

/** The first turn the new agent receives: who asked for it, always first. */
function startedPrompt(from, text) {
  const who = String(from || "a teammate").replace(/[\u0000-\u001f\u007f\[\]]/g, "").trim().slice(0, 40) || "a teammate";
  return `[started by ${who}] ${text}`;
}

/** The mode a remote-started agent runs in: the owner's own default when it
 *  is a safe one (plan, ask), otherwise ask. Never auto, never skip. */
function safeMode(stored) {
  return SAFE_MODES.has(stored) ? stored : "ask";
}

/** A repo name -> one of THIS machine's open workspace folders, by folder
 *  name (what the hook reports as `repo`). Ambiguity is a refusal, not a pick. */
function resolveRepo(name, workspaces) {
  if (!validRepo(name)) return { error: "that is not a folder name" };
  const want = name.toLowerCase();
  const hits = [...new Set((workspaces || []).map((d) => path.resolve(d)))].filter((d) => path.basename(d).toLowerCase() === want);
  if (hits.length === 1) return { dir: hits[0] };
  if (hits.length > 1) return { error: `${hits.length} open folders here are named ${name}` };
  return { error: `no open folder named ${name} on their machine` };
}

async function sendSpawn({ fetchImpl = fetch, hub, token, key, docCrypto = loadDocCrypto(), to, repo, agent, model = "", text }) {
  const body = cleanText(text);
  if (!body) return { ok: false, error: "Say what the new agent should do." };
  if (body.length > TEXT_MAX) return { ok: false, error: `A first prompt is at most ${TEXT_MAX} characters.` };
  if (!AGENTS.has(agent)) return { ok: false, error: "Pick claude, codex or opencode." };
  if (!validRepo(repo)) return { ok: false, error: "The repo is a folder name, like zevet — not a path." };
  if (model && !MODEL_RE.test(model)) return { ok: false, error: "That is not a model name." };
  if (!hub || !token) return { ok: false, error: "This app is not signed in to a team." };
  if (!key || !docCrypto) return { ok: false, error: "This machine has no team secret, so it cannot seal a prompt. Re-run setup." };
  if (!to) return { ok: false, error: "Pick a teammate." };
  const id = randomUUID();
  const meta = { id, to, repo, agent, model };
  let sealed;
  try {
    sealed = seal(docCrypto, key, meta, body);
  } catch (err) {
    return { ok: false, error: `Could not seal the prompt: ${err.message}` };
  }
  try {
    const res = await fetchImpl(`${String(hub).replace(/\/+$/, "")}/api/spawn`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": token },
      body: JSON.stringify({ id, to, repo, agent, ...(model ? { model } : {}), sealed }),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    let out = {};
    try {
      out = await res.json();
    } catch {
      out = {};
    }
    const status = typeof out.status === "string" ? out.status : "";
    if (res.ok) return { ok: true, id, status: status || "queued", approval: Boolean(out.approval) };
    return { ok: false, id, ...(status ? { status } : {}), error: out.error || `the team server answered ${res.status}` };
  } catch (err) {
    return { ok: false, id, error: `Could not reach your team: ${err.message}` };
  }
}

const OUTCOME_WINDOW_MS = 90 * 1000;

/** A short plain reason from what a failed console left behind; never raw output, env or paths. */
function failureReason(c) {
  const text = [c && c.lastResult, ...((c && c.events) || []).flatMap((e) => [e && e.error, e && e.payload && e.payload.result])]
    .filter((v) => typeof v === "string")
    .join(" ");
  if (/not logged in|\/login|not signed in|invalid api key|authentication|unauthori[sz]ed|\b401\b/i.test(text)) return "not signed in";
  if (/ENOENT|not found|not recognized|could not (find|start)|spawn /i.test(text)) return "the agent program is missing";
  if (c && c.state === "exited" && !(c.turns > 0)) return "it stopped right away";
  return "its first turn failed";
}

/**
 * After `started`: poll the new console until its first turn lands or it
 * fails. Resolves { ok:true } on a clean first result (or at the window's end
 * with the agent still working), else { ok:false, reason }.
 */
async function watchOutcome(get, id, { windowMs = OUTCOME_WINDOW_MS, pollMs = 500 } = {}) {
  const end = Date.now() + windowMs;
  for (;;) {
    const c = get(id);
    if (!c) return { ok: false, reason: "it stopped right away" };
    if (c.turns > 0) return c.isError ? { ok: false, reason: failureReason(c) } : { ok: true };
    if (!c.running) return { ok: false, reason: failureReason(c) };
    if (Date.now() >= end) return { ok: true };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * The owner's side. `deps`:
 *   open(msg) -> prompt plaintext (throws when it does not open)
 *   resolveRepo(name) -> { dir } | { error }      (this app's workspaces only)
 *   runningRemote() -> number of remote-started agents still running here
 *   askOwner({ id, from, agent, repo, dir, model, prompt }) -> Promise<boolean|null>
 *   start({ agent, dir, model, from, prompt }) -> Promise<{ ok, id?, error? }>   (prompt already prefixed)
 *   sessionOf(consoleId) -> the agent's session id once it has one, else ""
 *   outcome(consoleId) -> Promise<{ ok, reason? }>   (optional; see watchOutcome. A failure is reported as `start-failed`)
 *   report(id, status, reason, extra?) -> Promise                        (POST /api/steer/status)
 */
function createSpawnInbox(deps, { askTimeoutMs = ASK_TIMEOUT_MS, maxRunning = MAX_RUNNING, sessionWaitMs = SESSION_WAIT_MS } = {}) {
  const seen = new Set();
  const watching = new Set(); // settled follow-ups, so a caller (or test) can wait for them
  const report = (id, status, reason = "", extra) => Promise.resolve(deps.report(id, status, reason, extra)).catch(() => {});
  const full = () => Number(deps.runningRemote()) >= maxRunning;
  const fullReason = () => `they already have ${maxRunning} agents running that teammates started`;

  async function handle(msg) {
    const m = msg && typeof msg === "object" ? msg : {};
    const id = typeof m.id === "string" ? m.id : "";
    if (!id || typeof m.sealed !== "string") return "ignored";
    if (seen.has(id)) return "replay";
    seen.add(id);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);

    const agent = String(m.agent || "");
    const repo = String(m.repo || "");
    const model = typeof m.model === "string" && MODEL_RE.test(m.model) ? m.model : "";
    if (!AGENTS.has(agent) || !validRepo(repo)) {
      await report(id, "declined", "not a valid agent or folder name");
      return "declined";
    }
    let prompt;
    try {
      prompt = cleanText(deps.open({ id: m.id, to: m.to, repo, agent, model: m.model || "", sealed: m.sealed }));
    } catch {
      await report(id, "declined", "it could not be opened here (a different team secret?)");
      return "declined";
    }
    await report(id, "delivered");
    if (!prompt || prompt.length > TEXT_MAX) {
      await report(id, "declined", prompt ? `longer than ${TEXT_MAX} characters` : "it had no prompt");
      return "declined";
    }
    const where = deps.resolveRepo(repo);
    if (!where || !where.dir) {
      await report(id, "no-such-repo", (where && where.error) || `no open folder named ${repo}`);
      return "no-such-repo";
    }
    if (full()) {
      await report(id, "declined", fullReason());
      return "declined";
    }
    if (m.approval !== false) {
      let timer;
      const answer = await Promise.race([
        Promise.resolve(deps.askOwner({ id, from: String(m.from || ""), agent, repo, dir: where.dir, model, prompt })).catch(() => null),
        new Promise((resolve) => (timer = setTimeout(() => resolve(undefined), askTimeoutMs))),
      ]);
      clearTimeout(timer);
      if (answer !== true) {
        await report(id, "declined", answer === undefined ? "not answered in time" : answer === null ? "nobody was at the app to approve it" : "the owner declined it");
        return "declined";
      }
      // The cap again: others may have started while the card was open.
      if (full()) {
        await report(id, "declined", fullReason());
        return "declined";
      }
    }
    await report(id, "accepted");
    let r;
    try {
      r = await deps.start({ agent, dir: where.dir, model, from: String(m.from || ""), prompt: startedPrompt(m.from, prompt) });
    } catch (err) {
      r = { ok: false, error: err.message };
    }
    if (!r || !r.ok || !r.id) {
      await report(id, "declined", (r && r.error) || "it could not be started");
      return "declined";
    }
    let session = "";
    const end = Date.now() + sessionWaitMs;
    while (!(session = String(deps.sessionOf(r.id) || "")) && Date.now() < end) await new Promise((res) => setTimeout(res, 200));
    await report(id, "started", "", { session });
    if (deps.outcome) {
      const w = Promise.resolve(deps.outcome(r.id))
        .then((o) => (o && o.ok === false ? report(id, "start-failed", String(o.reason || "it stopped").slice(0, 100), { session }) : undefined))
        .catch(() => {})
        .finally(() => watching.delete(w));
      watching.add(w);
    }
    return "started";
  }

  return { handle, settled: () => Promise.all([...watching]) };
}

module.exports = { watchOutcome, failureReason, sendSpawn, createSpawnInbox, resolveRepo, safeMode, startedPrompt, MAX_RUNNING, _internals: { aadFor, seal, open, validRepo } };
