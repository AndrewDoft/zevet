"use strict";

// agent-api — a loopback-only HTTP control surface for starting and watching
// agents from a terminal, so an orchestrating Claude session can spawn and
// supervise its own subagents the same way the board does. Everything it
// does goes through the SAME functions the board's IPC handlers call
// (startAgentCore, sendToAgentCore, stopAgentCore, consoleLog) -- injected
// rather than required, so this module has no dependency on Electron and a
// spawned agent shows up on the board exactly like one the UI started.
//
// Trust model, same shape as ask-server.js's permit gate: bound to
// 127.0.0.1, one bearer secret per app run, written to a user-only file
// (~/.zevet/agent-api.json) nothing else on the machine can read. Unlike the
// renderer, a caller who holds that file is trusted at the same level as
// someone who already has a shell on this machine -- see `trustedDir` in
// main.js for what that buys `spawn` (any existing directory, not only an
// opened workspace).

const http = require("node:http");
const { randomBytes, timingSafeEqual } = require("node:crypto");

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes: long enough for a real
  // subagent turn, short enough that a caller who forgot to poll does not hang forever.
const WAIT_POLL_MS = 300;

function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== "string") return false;
  const host = hostHeader.split(":")[0].toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

function isLoopbackOrigin(originHeader) {
  if (typeof originHeader !== "string") return true;
  try {
    return isLoopbackHost(new URL(originHeader).hostname);
  } catch {
    return false;
  }
}

function tokenMatches(given, expected) {
  if (typeof given !== "string" || !given.length) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** The last tool call an agent's own stream announced, claude's content-part
 *  shape (`message.content[].type === "tool_use"`). codex/opencode report
 *  tool use in their own shapes this does not read -- absent there, not
 *  wrong; a caller sees no `lastTool` rather than a guessed one.
 *  ponytail: claude-shaped only; teach it opencode/codex's tool-call fields
 *  if this ever needs to cover them too. */
function lastToolFrom(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.type !== "agent" || !e.payload) continue;
    const content = e.payload.message && e.payload.message.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      if (content[j] && content[j].type === "tool_use") return content[j].name || null;
    }
  }
  return null;
}

/** The result text a `wait` should print: claude's own `result` line when
 *  there is one, else the text of the last assistant message -- covers
 *  codex/opencode too, since both fold their output through the same
 *  content-part shape by the time it reaches consoleLog (agent-console.js
 *  § makeLineSplitter / onEvent). Empty string, never null, when nothing
 *  usable is found -- a caller prints it as-is. */
function resultTextFrom(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.type === "agent" && e.payload && e.payload.type === "result" && typeof e.payload.result === "string") {
      return e.payload.result;
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.type !== "agent" || !e.payload) continue;
    const content = e.payload.message && e.payload.message.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    if (text) return text;
  }
  return "";
}

/** working | idle | exited. consoleLog tracks it per turn (claude stays alive
 *  between turns, so `running` alone never says one is done); an entry
 *  without it falls back to running-or-not. */
function stateOf(entry) {
  return entry.state || (entry.running ? "working" : "exited");
}

function summarize(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    agent: entry.agent,
    root: entry.root,
    model: entry.model,
    mode: entry.mode,
    engine: entry.engine,
    label: entry.label,
    running: entry.running,
    state: stateOf(entry),
    turns: entry.turns ?? 0,
    lastResult: entry.lastResult || "",
    isError: Boolean(entry.isError),
    costUsd: entry.costUsd ?? null,
    usage: entry.usage ?? null,
    startedAt: entry.startedAt,
    elapsedMs: Date.now() - entry.startedAt,
    title: entry.title || entry.autoTitle || "",
    lastTool: lastToolFrom(entry.events),
  };
}

/**
 * Start the API. Returns a Promise of `{url, token, close}` once bound --
 * one server per app run, same lifetime as ask-server.js's permit gate.
 *
 * `deps` are the pieces of main.js this needs, injected rather than
 * required so the module stays Electron-free and testable on its own:
 *   - startAgentCore({agent, cwd, opts, trusted}) -> {ok, id, engine, error}
 *   - sendToAgentCore(id, text) -> {ok, error}
 *   - stopAgentCore(id) -> {ok, error}
 *   - setOnce(id) -> marks a console to end after its first result (optional; `spawn --once`)
 *   - getConsole(id) -> the consoleLog entry, or undefined
 *   - listConsoles() -> every consoleLog entry
 */
async function start(deps = {}) {
  const { startAgentCore, sendToAgentCore, stopAgentCore, setOnce, getConsole, listConsoles } = deps;
  for (const name of ["startAgentCore", "sendToAgentCore", "stopAgentCore", "getConsole", "listConsoles"]) {
    if (typeof deps[name] !== "function") throw new Error(`agent-api: start() requires a ${name}() function`);
  }
  const token = randomBytes(24).toString("hex");

  async function handleSpawn(body) {
    const opts = {
      model: typeof body.model === "string" ? body.model : "",
      mode: typeof body.mode === "string" ? body.mode : "auto",
      ...(typeof body.engine === "string" && body.engine ? { engine: body.engine } : {}),
      ...(typeof body.label === "string" && body.label ? { label: body.label } : {}),
    };
    const agent = typeof body.agent === "string" && body.agent ? body.agent : "claude";
    const started = await startAgentCore({ agent, cwd: body.cwd, opts, trusted: true });
    if (!started.ok) return { status: 400, body: started };
    if (body.once === true && setOnce) setOnce(started.id);
    if (typeof body.prompt === "string" && body.prompt) {
      const sent = sendToAgentCore(started.id, body.prompt);
      if (!sent || sent.ok === false) {
        return { status: 200, body: { ...started, promptError: (sent && sent.error) || "could not send the prompt" } };
      }
    }
    return { status: 200, body: started };
  }

  function handleSend(id, body) {
    if (typeof body.prompt !== "string" || !body.prompt) return { status: 400, body: { ok: false, error: "send needs a prompt" } };
    const entry = getConsole(id);
    if (!entry) return { status: 404, body: { ok: false, error: "no such console" } };
    if (!entry.running) return { status: 409, body: { ok: false, error: "agent has exited" } };
    const sent = sendToAgentCore(id, body.prompt);
    if (!sent || sent.ok === false) return { status: 400, body: { ok: false, error: (sent && sent.error) || "could not send the prompt" } };
    return { status: 200, body: { ok: true, id } };
  }

  function handleStatus(id) {
    const entry = getConsole(id);
    if (!entry) return { status: 404, body: { ok: false, error: "no such console" } };
    return { status: 200, body: { ok: true, ...summarize(entry) } };
  }

  function handleOutput(id, tail) {
    const entry = getConsole(id);
    if (!entry) return { status: 404, body: { ok: false, error: "no such console" } };
    const n = Number.isFinite(tail) && tail > 0 ? tail : entry.events.length;
    return { status: 200, body: { ok: true, id, running: entry.running, events: entry.events.slice(-n) } };
  }

  function handleList() {
    return { status: 200, body: { ok: true, consoles: listConsoles().map(summarize) } };
  }

  function handleStop(id) {
    const r = stopAgentCore(id);
    return { status: r.ok ? 200 : 404, body: r };
  }

  async function handleWait(id, timeoutMs) {
    const deadline = Date.now() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_WAIT_TIMEOUT_MS);
    for (;;) {
      const entry = getConsole(id);
      if (!entry) return { status: 404, body: { ok: false, error: "no such console" } };
      // The turn is over when its `result` arrived (idle) or the process
      // died (exited) -- not only on exit, or a follow-up-capable console
      // would never finish.
      if (!entry.running) {
        return { status: 200, body: { ok: true, ...summarize(entry), resultText: entry.lastResult || resultTextFrom(entry.events) } };
      }
      if (Date.now() >= deadline) return { status: 200, body: { ok: false, error: "timed out waiting", ...summarize(entry) } };
      // ponytail: poll rather than an exit-event subscription; a subagent
      // turn is seconds to minutes long, so 300ms latency costs nothing a
      // caller would notice. Wire onEvent's "exit" straight through if this
      // ever needs sub-100ms wakeups.
      await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    }
  }

  const server = http.createServer((req, res) => {
    Promise.resolve()
      .then(async () => {
        if (!isLoopbackHost(req.headers.host) || !isLoopbackOrigin(req.headers.origin)) {
          json(res, 403, { ok: false, error: "not loopback" });
          return;
        }
        const auth = req.headers.authorization || "";
        const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!tokenMatches(given, token)) {
          json(res, 401, { ok: false, error: "bad token" });
          return;
        }

        const url = new URL(req.url, "http://127.0.0.1");
        const id = url.searchParams.get("id") || "";

        let result;
        if (req.method === "POST" && url.pathname === "/spawn") {
          let body;
          try {
            body = JSON.parse((await readBody(req)) || "{}");
          } catch {
            json(res, 400, { ok: false, error: "invalid JSON body" });
            return;
          }
          result = await handleSpawn(body || {});
        } else if (req.method === "GET" && url.pathname === "/status") {
          result = handleStatus(id);
        } else if (req.method === "GET" && url.pathname === "/output") {
          result = handleOutput(id, Number(url.searchParams.get("tail")));
        } else if (req.method === "GET" && url.pathname === "/list") {
          result = handleList();
        } else if (req.method === "POST" && url.pathname === "/send") {
          let body;
          try {
            body = JSON.parse((await readBody(req)) || "{}");
          } catch {
            json(res, 400, { ok: false, error: "invalid JSON body" });
            return;
          }
          result = handleSend(id, body || {});
        } else if (req.method === "POST" && url.pathname === "/stop") {
          result = handleStop(id);
        } else if (req.method === "POST" && url.pathname === "/wait") {
          result = await handleWait(id, Number(url.searchParams.get("timeoutMs")));
        } else {
          result = { status: 404, body: { ok: false, error: "not found" } };
        }
        json(res, result.status, result.body);
      })
      .catch((err) => {
        try {
          json(res, 500, { ok: false, error: err.message });
        } catch {
          // response already sent/closed
        }
      });
  });

  return new Promise((resolveStart) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveStart({
        url: `http://127.0.0.1:${port}`,
        token,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

module.exports = { start, _internals: { summarize, lastToolFrom, resultTextFrom } };
