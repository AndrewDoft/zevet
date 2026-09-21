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

const TOOLS = [
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

  if (name === "permission_prompt") return doPermissionPrompt(args);

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
    reply(id, { tools: TOOLS });
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

module.exports = { PROTOCOL_VERSION, SERVER_INFO, TOOLS, handleMessage, callTool, startStdioLoop };
