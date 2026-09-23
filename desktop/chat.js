// Zevet Chat: conversations with no repository behind them.
//
// Same CLI Zevet Code drives (agent-console.js), run headless from a neutral
// per-chat folder under ~/.zevet/chats/<id>/ with every built-in tool off.
// The user's own Claude login answers; no API key of ours is involved.
//
// FLAGS, read off `claude --help` on 2.1.280 and each one exercised in a probe
// run on this machine (2026-09-22), not remembered:
//
//   -p --input-format stream-json --output-format stream-json --verbose
//       one JSON user message per stdin line, JSONL events out
//   --include-partial-messages
//       `stream_event` text deltas, so a reply streams token by token
//   --tools ""            no built-in tools (init event reported `tools: []`)
//   --strict-mcp-config   only servers from --mcp-config (none, unless Masora
//                         is paired), never the user's other MCP servers
//   --session-id <uuid>   first turn on this machine: a fresh claude session
//   --resume <uuid>       later turns (the same session_id came back)
//   --allowedTools mcp__masora
//       pre-approves every tool of that one server; probed with a stub server
//       named `probe`: `mcp__probe` let `mcp__probe__secret_word` run with
//       `permission_denials: []`
//   --append-system-prompt <text>
//
// Conversations persist as ~/.zevet/chats/<id>.json, beside the rest of
// zevet's local state, the way consoles and prefs do.
//
// SHAPED TO TRAVEL. A chat is {id (uuid, global), title, owner,
// participants[], messages[{role, author, text, at, provider?, model?}],
// created, updated}: the
// whole of it is the transcript, and it serializes on its own. The claude
// session that answers it is NOT in it. That binding is this machine's
// (~/.zevet/chats/<id>/session.json), so a chat handed to someone else is
// resumed on their machine from the transcript alone: with no binding there,
// the first turn replays the messages to a fresh session (composeTurn's
// `prior`).
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const HOME = process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet");
const CHATS = path.join(HOME, "chats");
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Same cap Masora applies to content_text (C1). */
const CONTENT_TEXT_MAX_BYTES = 200_000;

/* ⚠️ NO `"&|<>^%!` IN HERE. On Windows a claude installed as a .cmd shim is
   re-parsed by cmd.exe, and agent-console.js refuses to launch any argv
   holding one of those. This text is argv; the user's words never are. */
const SYSTEM_PROMPT =
  "You are Zevet Chat, a general conversation assistant. This conversation has no repository " +
  "and no file or shell access. When a turn opens with a masora-context block, it is cited " +
  "evidence from the user's own Masora workspace: use it, cite the titles you rely on, and say " +
  "plainly when the answer is not in it instead of guessing. A prior-conversation block is this " +
  "chat's history so far, carried over from another session.";

function isId(id) {
  return typeof id === "string" && ID.test(id);
}

function fileOf(id) {
  if (!isId(id)) throw new Error("not a chat id");
  return path.join(CHATS, `${id}.json`);
}

/** The neutral working directory claude runs in for this chat. */
function dirOf(id) {
  if (!isId(id)) throw new Error("not a chat id");
  const dir = path.join(CHATS, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function write(chat) {
  fs.mkdirSync(CHATS, { recursive: true });
  fs.writeFileSync(fileOf(chat.id), `${JSON.stringify(chat)}\n`, "utf8");
  return chat;
}

function read(id) {
  if (!isId(id)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(fileOf(id), "utf8"));
    return c && c.id === id && Array.isArray(c.messages) ? c : null;
  } catch {
    return null; // missing or hand-mangled: not a chat
  }
}

function summary(c) {
  return { id: c.id, title: c.title || "", created: c.created, updated: c.updated, owner: c.owner || "" };
}

/** `owner` is the hub login of whoever started it, and its first participant. */
function create(owner) {
  const now = Date.now();
  const who = String(owner || "");
  return write({ id: randomUUID(), title: "", owner: who, participants: who ? [who] : [], created: now, updated: now, messages: [] });
}

/** Newest first. `query` matches the title or any message, case-insensitive. */
function list(query) {
  let names = [];
  try {
    names = fs.readdirSync(CHATS).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const q = String(query || "").trim().toLowerCase();
  const out = [];
  for (const n of names) {
    const c = read(n.slice(0, -5));
    if (!c) continue;
    if (q && !(c.title || "").toLowerCase().includes(q) &&
        !c.messages.some((m) => String(m.text || "").toLowerCase().includes(q))) continue;
    out.push(summary(c));
  }
  return out.sort((a, b) => b.updated - a.updated);
}

function rename(id, title) {
  const c = read(id);
  if (!c) return null;
  c.title = String(title || "").trim().slice(0, 120);
  return summary(write(c));
}

function remove(id) {
  if (!isId(id)) return false;
  fs.rmSync(fileOf(id), { force: true });
  fs.rmSync(path.join(CHATS, id), { recursive: true, force: true });
  return true;
}

/* ── this machine's claude session for a chat (never in the transcript) ── */

function sessionFile(id) {
  return path.join(dirOf(id), "session.json");
}

/** `{ sessionId, started }`; a new, unstarted one when this machine has none. */
function session(id) {
  try {
    const s = JSON.parse(fs.readFileSync(sessionFile(id), "utf8"));
    if (s && isId(s.sessionId)) return { sessionId: s.sessionId, started: s.started === true };
  } catch {
    // none on this machine yet
  }
  const fresh = { sessionId: randomUUID(), started: false };
  fs.writeFileSync(sessionFile(id), JSON.stringify(fresh), "utf8");
  return fresh;
}

function markStarted(id) {
  const s = session(id);
  if (!s.started) fs.writeFileSync(sessionFile(id), JSON.stringify({ ...s, started: true }), "utf8");
}

/** One finished exchange, by `author` (a hub login). The reply records the
 *  provider and model that wrote it. The first exchange names an untitled chat. */
function addTurn(id, user, assistant, model, author, provider) {
  const c = read(id);
  if (!c) return null;
  const at = Date.now();
  const who = String(author || c.owner || "");
  c.messages.push(
    { role: "user", author: who, text: String(user), at },
    {
      role: "assistant", author: "assistant", text: String(assistant), at,
      ...(provider ? { provider: String(provider) } : {}),
      ...(model ? { model: String(model) } : {}),
    },
  );
  const participants = Array.isArray(c.participants) ? c.participants : [];
  if (who && !participants.includes(who)) c.participants = [...participants, who];
  c.updated = at;
  if (model) c.model = String(model);
  if (!c.title) c.title = String(user).trim().split("\n")[0].slice(0, 60);
  return write(c);
}

/** argv for one chat process. Pure; see the flag notes at the top. */
function chatArgs({ sessionId, started, mcpConfig, model } = {}) {
  return [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--include-partial-messages",
    "--tools", "",
    "--strict-mcp-config",
    ...(started ? ["--resume", sessionId] : ["--session-id", sessionId]),
    "--append-system-prompt", SYSTEM_PROMPT,
    ...(mcpConfig ? ["--mcp-config", mcpConfig, "--allowedTools", "mcp__masora"] : []),
    ...(model ? ["--model", model] : []),
  ];
}

/**
 * What goes on stdin for one turn: the conversation so far when this
 * machine's session has never seen it (a handed-over chat, or a lost
 * session), the C2 brief when there is one, then the words.
 */
function composeTurn(text, brief, prior) {
  const parts = [];
  if (prior && prior.length) {
    const log = prior.map((m) => `[${m.role === "user" ? m.author || "user" : "assistant"}]: ${m.text}`).join("\n\n");
    parts.push(`<prior-conversation>\n${log}\n</prior-conversation>`);
  }
  if (brief) parts.push(`<masora-context>\n${brief}\n</masora-context>`);
  parts.push(text);
  return parts.join("\n\n");
}

/** The C1 `zevet_chat` record for one chat. No repository: a chat has none. */
function toRecord(chat) {
  let content = (chat.messages || [])
    .map((m) => `[${m.role === "user" ? "HUMAN" : "ASSISTANT"}]: ${m.text}`)
    .join("\n");
  if (Buffer.byteLength(content, "utf8") > CONTENT_TEXT_MAX_BYTES) {
    content = `${Buffer.from(content, "utf8").subarray(0, CONTENT_TEXT_MAX_BYTES)}`;
  }
  return {
    surface: "zevet_chat",
    external_id: `zevet:chat:${chat.id}`,
    title: chat.title || "",
    created_at: new Date(chat.created || Date.now()).toISOString(),
    updated_at: new Date(chat.updated || Date.now()).toISOString(),
    content_text: content,
    model: chat.model || "",
    owner: chat.owner || "",
    // C1: the audience is derived from participants. Today Masora grants
    // only the pairing person; see docs/contracts/cross_app_context.md.
    participants: Array.isArray(chat.participants) ? chat.participants : [],
  };
}

module.exports = {
  CHATS,
  SYSTEM_PROMPT,
  isId,
  dirOf,
  read,
  create,
  list,
  rename,
  remove,
  session,
  markStarted,
  addTurn,
  chatArgs,
  composeTurn,
  toRecord,
};
