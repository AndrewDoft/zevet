"use strict";
// Steering a teammate's agent, desktop side (D-058). No Electron in here, so
// node --test can drive all of it; main.js supplies the console lookup, the
// injection, the approval card and the hub calls.
//
// SENDER: the board hands main {to, session, repo, text}; this seals the text
// with the document key and POSTs it. The hub relays ciphertext only.
//
// OWNER: the hub pushes `steer` on this person's private channel
// (`/events?steer=1`). This opens it, reports `delivered`, finds the target
// agent among THIS app's consoles, asks the person when the team policy says
// `ask` (the hub sets `approval`), and only then injects it as an ordinary
// user turn, prefixed with who sent it. Every ending is reported back:
// accepted, or declined with the reason. Nothing is dropped silently.
//
// ⚠️ A STEER IS TEXT AND NOTHING ELSE. It cannot carry a mode, a model, a
// permission grant or an answer to a pending permit — none of those fields are
// read — and the injected turn always starts with "[from …]", so it can never
// be a slash command the CLI would run itself.

const path = require("node:path");
const { randomUUID } = require("node:crypto");

const TEXT_MAX = 4000;
const ASK_TIMEOUT_MS = 10 * 60 * 1000;
const SEEN_MAX = 1000;
const STATUSES = ["queued", "delivered", "accepted", "declined", "refused-by-policy", "offline", "unknown-agent"];

/** The app's OWN copy of doc-crypto.mjs, never ~/.zevet/client — same rule
 *  and same order as desktop/doc-sync.js's cryptoModulePaths. */
let docCryptoModule;
function loadDocCrypto() {
  if (docCryptoModule !== undefined) return docCryptoModule;
  docCryptoModule = null;
  const out = [path.join(__dirname, "client", "doc-crypto.mjs")];
  if (process.resourcesPath) out.push(path.join(process.resourcesPath, "client", "doc-crypto.mjs"));
  out.push(path.join(__dirname, "..", "client", "doc-crypto.mjs"));
  for (const p of out) {
    try {
      docCryptoModule = require(p);
      break;
    } catch {
      // next
    }
  }
  return docCryptoModule;
}

/** GCM additional data: a sealed steer opens only for the id, person and
 *  agent it was written for, so the hub cannot re-aim or re-number it. */
function aadFor({ id, to, session }) {
  return `steer\u0000${id}\u0000${String(to || "").toLowerCase().replace(/^@/, "")}\u0000${session}`;
}

function seal(docCrypto, key, meta, text) {
  return docCrypto.seal(key, aadFor(meta), Buffer.from(text, "utf8")).toString("base64");
}

function open(docCrypto, key, meta, sealed) {
  return docCrypto.open(key, aadFor(meta), Buffer.from(String(sealed || ""), "base64")).toString("utf8");
}

/** Plain text: control characters other than newline and tab removed. */
function cleanText(text) {
  return String(text || "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
}

/** The turn the target agent actually receives. Always starts with "[", so
 *  never a slash command. */
function steerPrompt(from, text) {
  const who = String(from || "a teammate").replace(/[\u0000-\u001f\u007f\[\]]/g, "").trim().slice(0, 40) || "a teammate";
  return `[from ${who}] ${text}`;
}

/**
 * Seal and send one steer. Never throws; always answers with a status the
 * sender can be shown.
 */
async function sendSteer({ fetchImpl = fetch, hub, token, key, docCrypto = loadDocCrypto(), to, session, repo = "", text }) {
  const body = cleanText(text);
  if (!body) return { ok: false, error: "Nothing to send." };
  if (body.length > TEXT_MAX) return { ok: false, error: `A steer is at most ${TEXT_MAX} characters.` };
  if (!hub || !token) return { ok: false, error: "This app is not signed in to a hub." };
  if (!key || !docCrypto) return { ok: false, error: "This machine has no team secret, so it cannot seal a steer. Re-run setup." };
  if (!to || !session) return { ok: false, error: "No agent to steer." };
  const id = randomUUID();
  let sealed;
  try {
    sealed = seal(docCrypto, key, { id, to, session }, body);
  } catch (err) {
    return { ok: false, error: `Could not seal the steer: ${err.message}` };
  }
  try {
    const res = await fetchImpl(`${String(hub).replace(/\/+$/, "")}/api/steer`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": token },
      body: JSON.stringify({ id, to, session, repo, sealed }),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    let out = {};
    try {
      out = await res.json();
    } catch {
      out = {};
    }
    const status = STATUSES.includes(out.status) ? out.status : "";
    if (res.ok) return { ok: true, id, status: status || "queued", approval: Boolean(out.approval) };
    return { ok: false, id, ...(status ? { status } : {}), error: out.error || `hub answered ${res.status}` };
  } catch (err) {
    return { ok: false, id, error: `Could not reach the hub: ${err.message}` };
  }
}

/**
 * The owner's side. `deps`:
 *   open(msg) -> plaintext (throws when it does not open)
 *   findConsole(session) -> { id, agent } | null   (THIS app's consoles only)
 *   askOwner({ id, from, text, agent, repo, consoleId }) -> Promise<boolean|null>
 *   inject(consoleId, prompt) -> Promise<{ ok, error? }>
 *   report(id, status, reason) -> Promise<unknown>   (POST /api/steer/status)
 * `handle(msg)` resolves to the final status, for tests and logs.
 */
function createSteerInbox(deps, { askTimeoutMs = ASK_TIMEOUT_MS } = {}) {
  const seen = new Set();
  const report = (id, status, reason = "") => Promise.resolve(deps.report(id, status, reason)).catch(() => {});

  async function handle(msg) {
    const m = msg && typeof msg === "object" ? msg : {};
    const id = typeof m.id === "string" ? m.id : "";
    if (!id || typeof m.session !== "string" || typeof m.sealed !== "string") return "ignored";
    // A hub relaying the same steer twice is either a bug or an attack; the
    // first copy was already handled and reported.
    if (seen.has(id)) return "replay";
    seen.add(id);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);

    let text;
    try {
      text = cleanText(deps.open(m));
    } catch {
      await report(id, "declined", "it could not be opened here (a different team secret?)");
      return "declined";
    }
    await report(id, "delivered");
    if (!text) {
      await report(id, "declined", "it was empty");
      return "declined";
    }
    if (text.length > TEXT_MAX) {
      await report(id, "declined", `longer than ${TEXT_MAX} characters`);
      return "declined";
    }
    const c = deps.findConsole(m.session);
    if (!c) {
      await report(id, "declined", "that agent is not running in their Zevet app");
      return "declined";
    }
    if (m.approval !== false) {
      // Anything but an explicit `false` asks: a message missing the flag is
      // treated as the safe policy, not the permissive one.
      let timer;
      const answer = await Promise.race([
        Promise.resolve(deps.askOwner({ id, from: String(m.from || ""), text, agent: String(m.agent || c.agent || ""), repo: String(m.repo || ""), consoleId: c.id })).catch(() => null),
        new Promise((resolve) => (timer = setTimeout(() => resolve(undefined), askTimeoutMs))),
      ]);
      clearTimeout(timer);
      if (answer !== true) {
        await report(id, "declined", answer === undefined ? "not answered in time" : answer === null ? "nobody was at the app to approve it" : "the owner declined it");
        return "declined";
      }
    }
    let r;
    try {
      r = await deps.inject(c.id, steerPrompt(m.from, text));
    } catch (err) {
      r = { ok: false, error: err.message };
    }
    if (!r || r.ok === false) {
      await report(id, "declined", (r && r.error) || "the agent did not take it");
      return "declined";
    }
    await report(id, "accepted");
    return "accepted";
  }

  return { handle };
}

/** Split an SSE byte stream into (event, data) pairs. */
function makeSseParser(onFrame) {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let cut;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const evt = /^event:\s*(.+)$/m.exec(frame);
      const data = /^data:\s*(.+)$/m.exec(frame);
      if (!evt || !data) continue;
      let payload;
      try {
        payload = JSON.parse(data[1]);
      } catch {
        continue;
      }
      onFrame(evt[1].trim(), payload);
    }
  };
}

/**
 * Hold this person's steer channel open until `signal` aborts, reconnecting
 * after a dropped connection. `onFrame(name, data)` gets `steer` and
 * `steer-status`.
 */
async function streamSteers({ fetchImpl = fetch, hub, token, onFrame, signal, retryMs = 5000 }) {
  const base = String(hub || "").replace(/\/+$/, "");
  while (!signal.aborted) {
    try {
      const res = await fetchImpl(`${base}/events?steer=1`, { signal, headers: { accept: "text/event-stream", "x-zevet-token": token } });
      if (!res.ok || !res.body) throw new Error(`hub answered ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const push = makeSseParser(onFrame);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        push(decoder.decode(value, { stream: true }));
      }
    } catch {
      if (signal.aborted) return;
    }
    await new Promise((r) => setTimeout(r, retryMs));
  }
}

module.exports = { sendSteer, createSteerInbox, streamSteers, steerPrompt, loadDocCrypto, TEXT_MAX, _internals: { aadFor, seal, open, cleanText, makeSseParser } };
