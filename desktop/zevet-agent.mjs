#!/usr/bin/env node
// zevet-agent — a terminal client for the local control API (desktop/
// agent-api.js), so an orchestrating Claude session can spawn and watch its
// own subagents the same way the board does, from a plain shell.
//
//   node desktop/zevet-agent.mjs spawn --cwd <dir> [--prompt "..." | --prompt-file <path> | < stdin]
//                                       [--model <model>] [--engine engine1|engine2|auto]
//                                       [--mode auto|plan|ask|dangerous] [--label <name>] [--agent claude]
//   node desktop/zevet-agent.mjs status --id <id>
//   node desktop/zevet-agent.mjs wait   --id <id> [--timeout-ms <n>]
//   node desktop/zevet-agent.mjs output --id <id> [--tail <n>]
//   node desktop/zevet-agent.mjs stop   --id <id>
//   node desktop/zevet-agent.mjs list
//
// Everything below the dispatch in main() is pure -- parseArgs, the
// formatters, loadDiscovery -- so the suite covers argv parsing and output
// formatting without a real agent-api server or a real zevet install.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zevetHome } from "../client/zevet-home.mjs";

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a || !a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      opts[key] = true;
    } else {
      opts[key] = next;
      i++;
    }
  }
  return { command: command || "", opts };
}

export function discoveryFile(home = zevetHome()) {
  return path.join(home, "agent-api.json");
}

/** `{url, token}` from the discovery file the desktop app writes on
 *  startup, or a throw with a message that says what to do about it --
 *  every command surfaces this as its whole error, so it should not need a
 *  second look at agent-api.json to understand. */
export function loadDiscovery({ file = discoveryFile(), readFileSyncImpl = readFileSync } = {}) {
  let raw;
  try {
    raw = readFileSyncImpl(file, "utf8");
  } catch {
    throw new Error(`zevet is not running (no ${file}). Start the zevet desktop app first.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON.`);
  }
  if (!parsed || typeof parsed.url !== "string" || typeof parsed.token !== "string") {
    throw new Error(`${file} is missing url/token.`);
  }
  return { url: parsed.url, token: parsed.token };
}

export async function request(disc, method, route, { query, body, fetchImpl = fetch } = {}) {
  const url = new URL(route, disc.url);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetchImpl(url, {
    method,
    headers: { authorization: `Bearer ${disc.token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = await res.json().catch(() => ({}));
  return { status: res.status, body: parsed };
}

export function readStdin(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    if (stream.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (c) => (data += c));
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

export function fmtElapsed(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

export function fmtList(consoles) {
  if (!consoles || !consoles.length) return "(no agents)";
  const header = ["ID", "LABEL", "AGENT", "ENGINE", "MODEL", "STATE", "ELAPSED", "LAST TOOL"];
  const rows = consoles.map((c) => [
    c.id,
    c.label || "-",
    c.agent || "-",
    c.engine || "-",
    c.model || "-",
    c.running ? "running" : "stopped",
    fmtElapsed(c.elapsedMs),
    c.lastTool || "-",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cols) => cols.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}

/** One transcript event as a line a person reads, claude's stream-json
 *  shape -- same content-part reading agent-api.js's own resultTextFrom/
 *  lastToolFrom do. Empty string for an event with nothing to show. */
export function fmtEvent(evt) {
  if (!evt || typeof evt !== "object") return "";
  if (evt.type === "prompt") return `> ${evt.text}`;
  if (evt.type === "exit") return `[exit code=${evt.code ?? "null"}${evt.signal ? ` signal=${evt.signal}` : ""}]`;
  if (evt.type === "stderr") return String(evt.text || "").trimEnd();
  if (evt.type === "stdout-line") return evt.line || "";
  if (evt.type === "gap") return `... ${evt.dropped} event(s) dropped ...`;
  if (evt.type === "agent" && evt.payload) {
    const p = evt.payload;
    if (p.type === "result" && typeof p.result === "string") return p.result;
    const content = p.message && p.message.content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (part && part.type === "text" && typeof part.text === "string") return part.text;
          if (part && part.type === "tool_use") return `[tool] ${part.name}`;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
  }
  return "";
}

export function fmtOutput(events) {
  return (events || []).map(fmtEvent).filter((l) => l.length).join("\n");
}

const USAGE = `usage: zevet-agent <spawn|status|wait|output|stop|list> [--flags]`;

async function run(argv, { disc, fetchImpl = fetch, stdin = process.stdin, stdout = console.log, stderr = console.error } = {}) {
  const { command, opts } = parseArgs(argv);
  const d = disc || loadDiscovery();

  if (command === "spawn") {
    if (!opts.cwd || opts.cwd === true) throw new Error("spawn needs --cwd <directory>");
    let prompt = typeof opts.prompt === "string" ? opts.prompt : undefined;
    if (prompt === undefined && typeof opts["prompt-file"] === "string") prompt = readFileSync(opts["prompt-file"], "utf8");
    if (prompt === undefined) prompt = await readStdin(stdin);
    const { status, body } = await request(d, "POST", "/spawn", {
      fetchImpl,
      body: {
        cwd: opts.cwd,
        ...(prompt ? { prompt } : {}),
        ...(typeof opts.model === "string" ? { model: opts.model } : {}),
        ...(typeof opts.engine === "string" ? { engine: opts.engine } : {}),
        ...(typeof opts.mode === "string" ? { mode: opts.mode } : {}),
        ...(typeof opts.label === "string" ? { label: opts.label } : {}),
        ...(typeof opts.agent === "string" ? { agent: opts.agent } : {}),
      },
    });
    if (status !== 200 || !body.ok) return { ok: false, exitCode: 1, text: body.error || `spawn failed (${status})` };
    return { ok: true, exitCode: 0, text: JSON.stringify(body) };
  }

  if (command === "status" || command === "stop" || command === "wait" || command === "output") {
    if (!opts.id || opts.id === true) throw new Error(`${command} needs --id <console id>`);
  }

  if (command === "status") {
    const { status, body } = await request(d, "GET", "/status", { fetchImpl, query: { id: opts.id } });
    if (status !== 200 || !body.ok) return { ok: false, exitCode: 1, text: body.error || `status failed (${status})` };
    return { ok: true, exitCode: 0, text: JSON.stringify(body) };
  }

  if (command === "wait") {
    const { status, body } = await request(d, "POST", "/wait", {
      fetchImpl,
      query: { id: opts.id, ...(opts["timeout-ms"] ? { timeoutMs: opts["timeout-ms"] } : {}) },
    });
    if (status !== 200 || !body.ok) return { ok: false, exitCode: 1, text: body.error || `wait failed (${status})` };
    return { ok: true, exitCode: 0, text: body.resultText || "" };
  }

  if (command === "output") {
    const { status, body } = await request(d, "GET", "/output", {
      fetchImpl,
      query: { id: opts.id, ...(opts.tail ? { tail: opts.tail } : {}) },
    });
    if (status !== 200 || !body.ok) return { ok: false, exitCode: 1, text: body.error || `output failed (${status})` };
    return { ok: true, exitCode: 0, text: fmtOutput(body.events) };
  }

  if (command === "stop") {
    const { status, body } = await request(d, "POST", "/stop", { fetchImpl, query: { id: opts.id } });
    if (status !== 200 || !body.ok) return { ok: false, exitCode: 1, text: body.error || `stop failed (${status})` };
    return { ok: true, exitCode: 0, text: "stopped" };
  }

  if (command === "list") {
    const { status, body } = await request(d, "GET", "/list", { fetchImpl });
    if (status !== 200 || !body.ok) return { ok: false, exitCode: 1, text: body.error || `list failed (${status})` };
    return { ok: true, exitCode: 0, text: fmtList(body.consoles) };
  }

  return { ok: false, exitCode: 1, text: USAGE };
}

export { run };

async function main() {
  try {
    const r = await run(process.argv.slice(2));
    if (r.text) (r.ok ? console.log : console.error)(r.text);
    process.exitCode = r.exitCode;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(fileURLToPath(import.meta.url)).href && process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
