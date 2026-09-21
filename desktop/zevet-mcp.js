#!/usr/bin/env node
"use strict";

// zevet-mcp — a stdio MCP server that hands a spawned agent a screen and a
// mouse. Speaks JSON-RPC 2.0, newline-delimited, over stdin/stdout, per the
// MCP stdio transport. Implemented against protocol revision "2025-06-18" —
// the latest this was written against, NOT re-verified live against the spec
// at build time, so treat that string as best-effort rather than a checked
// fact (see the report for this file).
//
// This file is NOT the thing that decides whether an action is a good idea.
// Every tool call — including screenshot — is gated by POSTing to
// `${ZEVET_MCP_URL}/permit` (see ask-server.js, started by main.js) and
// acting only on `{"ok":true}`. If ZEVET_MCP_URL/ZEVET_MCP_TOKEN are not
// set, every tool is refused, unconditionally, before anything is attempted.
// That refusal exists because a stray copy of this file — checked into a
// fork, shipped in a zip, run by someone who skipped the setup — must not be
// an unguarded remote control for anybody's desktop.

const fs = require("node:fs");
const { execFile } = require("node:child_process");

const { makeLineSplitter } = require("./agent-console.js")._internals;
const computer = require("./computer.js");

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "zevet-computer-use", version: "0.1.0" };

/**
 * The one tool EVERY agent gets.
 *
 * ⚠️ IT IS NOT BEHIND THE COMPUTER-USE GATE, and the four tools below still
 * are. Andrew asked for questions from any agent he starts — "rather than
 * needing me to write out responses in chat all the time" — but handing every
 * agent the mouse to get there would be a capability nobody asked for. So this
 * server now exposes two sets, and main.js decides which by setting
 * ZEVET_MCP_COMPUTER. Asking a person to choose between options somebody wrote
 * down is not in the same class of power as moving their cursor.
 */
const ASK_TOOLS = [
  {
    name: "ask_user",
    description:
      "Ask the person a multiple-choice question and wait for their answer. Use this " +
      "instead of asking in prose when the decision is yours to hand over and the " +
      "options are known. Blocks until they choose or the question times out.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The whole question, ending in a question mark." },
        header: { type: "string", description: "Two or three words naming the decision, for the chip above it." },
        multi: { type: "boolean", description: "True when more than one option may be chosen.", default: false },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "The choice itself, in a few words." },
              description: { type: "string", description: "What picking it means or costs." },
            },
            required: ["label"],
            additionalProperties: false,
          },
        },
      },
      required: ["question", "options"],
      additionalProperties: false,
    },
  },
];

const COMPUTER_TOOLS = [
  {
    name: "screenshot",
    description: "Capture the full screen as a PNG image, plus the screen size.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "click",
    description: "Click the mouse at screen coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "integer", description: "X coordinate, in the same space screenshot reports." },
        y: { type: "integer", description: "Y coordinate, in the same space screenshot reports." },
        button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "type_text",
    description: "Type literal text at the current keyboard focus. No control characters — use press_key for Enter/Tab/etc.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "press_key",
    description: 'Press a named key or modifier combo, e.g. "enter", "f4", "ctrl+c".',
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    // What --permission-prompt-tool calls for EVERY tool use claude would
    // otherwise prompt about — Bash, Edit, all of them, not just this
    // server's own four. This is what makes the loopback gate answer for
    // the whole run rather than just for computer use.
    //
    // Request/response shape verified against the installed
    // @anthropic-ai/claude-agent-sdk's own bundled source (the zod schema
    // the CLI parses our reply with), not assumed from docs:
    //   request:  { tool_name, input, tool_use_id }
    //   allow:    { behavior: "allow", updatedInput: <object> }
    //   deny:     { behavior: "deny", message: <string> }
    name: "permission_prompt",
    description: "Internal: called by Claude Code itself to ask permission before any tool call.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string" },
        input: { type: "object" },
        tool_use_id: { type: "string" },
      },
      required: ["tool_name", "input"],
      // Unlike our own four tools, the caller here is Claude Code's own CLI,
      // whose exact argument set is not ours to pin down — additive fields
      // it adds later must not break discovery.
      additionalProperties: true,
    },
  },
];

/** What this server offers this run. See ASK_TOOLS on why it is two sets. */
function toolsFor(env = process.env) {
  return env.ZEVET_MCP_COMPUTER === "1" ? ASK_TOOLS.concat(COMPUTER_TOOLS) : ASK_TOOLS.slice();
}

/**
 * A question, checked before a person is ever shown it.
 *
 * ⚠️ THE AGENT WROTE THIS, so it is input at a trust boundary even though the
 * agent is one we started. Everything is bounded and coerced to a string here
 * rather than in the renderer, so the board is never handed a shape it has to
 * defend against — and the caps are what stop a question from being a wall of
 * text in a card that blocks until it is answered.
 */
function cleanQuestion(args) {
  const a = args && typeof args === "object" ? args : {};
  const text = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const question = text(a.question, 400);
  if (!question) return { error: "question is required and must be a non-empty string" };
  const raw = Array.isArray(a.options) ? a.options : [];
  const options = [];
  for (const o of raw) {
    const label = text(o && o.label, 60);
    if (!label) continue;
    // One label, one option: a picker with two identical buttons cannot be
    // answered unambiguously, and the answer goes back as the LABEL.
    if (options.some((p) => p.label === label)) continue;
    options.push({ label, description: text(o && o.description, 160) });
    if (options.length === 4) break;
  }
  if (options.length < 2) return { error: "options must contain at least 2 entries with distinct labels" };
  return { question, header: text(a.header, 24), multi: a.multi === true, options };
}

/** Put a question to the person and wait. Same gate, different route. */
async function askUser(args) {
  const url = process.env.ZEVET_MCP_URL;
  const token = process.env.ZEVET_MCP_TOKEN;
  if (!url || !token) return textResult("the desktop app is not reachable, so there is nobody to ask", true);
  const clean = cleanQuestion(args);
  if (clean.error) return textResult(clean.error, true);
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(clean),
      signal: AbortSignal.timeout(150_000),
    });
    if (!res.ok) return textResult(`could not ask: HTTP ${res.status}`, true);
    const data = await res.json();
    if (data && data.ok === true && Array.isArray(data.picked) && data.picked.length) {
      return textResult(`They chose: ${data.picked.join(", ")}`);
    }
    /* ⚠️ NOT AN ERROR. Nobody answered, which is an answer about their
       attention rather than a fault in the run — tell it plainly and let the
       agent decide for itself rather than making it handle a tool failure. */
    return textResult(`No answer: ${(data && data.reason) || "the question was not answered"}. Decide without it, and say what you assumed.`);
  } catch (err) {
    return textResult(`could not ask: ${err.message}`, true);
  }
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

/** The gate. Every tool call goes through this before doing anything. */
async function requestPermit(tool, args) {
  const url = process.env.ZEVET_MCP_URL;
  const token = process.env.ZEVET_MCP_TOKEN;
  if (!url || !token) {
    return {
      ok: false,
      reason:
        "ZEVET_MCP_URL / ZEVET_MCP_TOKEN are not set — this server refuses every " +
        "action without the desktop app's permission gate configured.",
    };
  }
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/permit`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ tool, arguments: args }),
      signal: AbortSignal.timeout(150_000),
    });
    if (!res.ok) return { ok: false, reason: `permission gate returned HTTP ${res.status}` };
    const data = await res.json();
    if (data && data.ok === true) return { ok: true };
    return { ok: false, reason: (data && data.reason) || "denied by the permission gate" };
  } catch (err) {
    return { ok: false, reason: `could not reach the permission gate: ${err.message}` };
  }
}

function run(command, args, { timeout = 15_000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, error: err ? String(err.message || err) : null, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

async function doScreenshot() {
  const cap = computer.captureCommand();
  if (!cap.ok) return textResult(cap.error, true);

  const res = await run(cap.command, cap.args, { timeout: 15_000 });
  if (!res.ok) return textResult(`screenshot failed: ${res.error}\n${res.stderr}`, true);

  let png;
  try {
    png = fs.readFileSync(cap.outputPath);
  } catch (err) {
    return textResult(`screenshot command succeeded but produced no file: ${err.message}`, true);
  }
  fs.unlink(cap.outputPath, () => {});

  let sizeText = "";
  const sizeCmd = computer.screenSizeCommand();
  if (sizeCmd.ok) {
    const sizeRes = await run(sizeCmd.command, sizeCmd.args, { timeout: 10_000 });
    if (sizeRes.ok) {
      const parsed = computer.parseScreenSize(sizeRes.stdout);
      if (parsed.ok) sizeText = ` (screen ${parsed.width}x${parsed.height})`;
    }
  }

  return {
    content: [
      { type: "image", data: png.toString("base64"), mimeType: "image/png" },
      { type: "text", text: `captured full screen${sizeText}` },
    ],
  };
}

async function doClick(args) {
  const built = computer.clickCommand(args);
  if (!built.ok) return textResult(built.error, true);
  const res = await run(built.command, built.args, { timeout: 10_000 });
  if (!res.ok) return textResult(`click failed: ${res.error}\n${res.stderr}`, true);
  return textResult(`clicked (${args.button || "left"}) at ${args.x}, ${args.y}`);
}

async function doType(args) {
  const built = computer.typeCommand(args);
  if (!built.ok) return textResult(built.error, true);
  const res = await run(built.command, built.args, { timeout: 10_000 });
  if (!res.ok) return textResult(`type failed: ${res.error}\n${res.stderr}`, true);
  return textResult(`typed ${args.text.length} characters`);
}

async function doKey(args) {
  const built = computer.keyCommand(args);
  if (!built.ok) return textResult(built.error, true);
  const res = await run(built.command, built.args, { timeout: 10_000 });
  if (!res.ok) return textResult(`press_key failed: ${res.error}\n${res.stderr}`, true);
  return textResult(`pressed ${args.key}`);
}

/**
 * --permission-prompt-tool's handler. Deliberately NOT routed through the
 * ordinary refuse-with-isError path the other four tools use below: this
 * reply is parsed by Claude Code as a strict allow/deny decision (see the
 * TOOLS entry above), and an isError result that is not that shape reads to
 * it as a broken tool, not as a "no". So every exit here — permitted,
 * denied, gate unreachable, no env configured, even an internal exception —
 * is a well-formed `{behavior:"deny",...}` (or allow) text block, never an
 * MCP-level error.
 */
async function doPermissionPrompt(args) {
  try {
    const toolName = typeof args.tool_name === "string" ? args.tool_name : "";
    const input = args.input && typeof args.input === "object" ? args.input : {};

    const permit = await requestPermit(toolName, input);
    const decision = permit.ok
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: String(permit.reason || "denied") };
    return { content: [{ type: "text", text: JSON.stringify(decision) }] };
  } catch (err) {
    const decision = { behavior: "deny", message: `permission_prompt failed: ${err.message}` };
    return { content: [{ type: "text", text: JSON.stringify(decision) }] };
  }
}

const HANDLERS = { screenshot: doScreenshot, click: doClick, type_text: doType, press_key: doKey };

async function callTool(name, rawArgs) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};

  /* ⚠️ ASKING IS NOT PERMITTED, IT IS THE PERMISSION. Every other tool here
     goes through requestPermit first because it is about to DO something; a
     question does nothing but wait for a person, and putting it behind a
     second approval would mean approving a dialog in order to be shown a
     dialog. Its own route is the gate. */
  if (name === "ask_user") return askUser(args);

  if (name === "permission_prompt") return doPermissionPrompt(args);

  /* ⚠️ THE COMPUTER TOOLS REFUSE BY NAME when this run did not get them.
     tools/list already leaves them out, but a model that remembers them from
     another run would otherwise reach a handler the gate never approved. */
  if (!toolsFor().some((t) => t.name === name)) {
    return textResult(`"${name}" is not available in this run`, true);
  }

  const handler = HANDLERS[name];
  if (!handler) return textResult(`unknown tool "${name}"`, true);

  const permit = await requestPermit(name, args);
  if (!permit.ok) return textResult(`denied: ${permit.reason}`, true);

  return handler(args);
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 over stdio
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  if (id === undefined) return; // a notification carries no id and gets no response
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  if (id === undefined) return;
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return;
  const { id, method, params } = msg;

  if (method === "initialize") {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }

  if (method === "notifications/initialized") return; // notification: no response

  if (method === "tools/list") {
    reply(id, { tools: toolsFor() });
    return;
  }

  if (method === "tools/call") {
    try {
      const result = await callTool(params && params.name, params && params.arguments);
      reply(id, result);
    } catch (err) {
      replyError(id, -32000, `tool call failed: ${err.message}`);
    }
    return;
  }

  replyError(id, -32601, `method not found: ${method}`);
}

function startStdioLoop() {
  const splitter = makeLineSplitter((line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // MCP stdio is newline-delimited JSON only; anything else is noise
    }
    handleMessage(msg).catch(() => {});
  });

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => splitter.push(chunk));
  process.stdin.on("end", () => splitter.flush());
}

if (require.main === module) {
  startStdioLoop();
}

module.exports = { PROTOCOL_VERSION, SERVER_INFO, ASK_TOOLS, COMPUTER_TOOLS, toolsFor, cleanQuestion, handleMessage, callTool, startStdioLoop };
