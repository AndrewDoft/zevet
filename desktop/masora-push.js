// Pushing agent sessions to Masora (T5, docs/contracts/cross_app_context.md
// C1): one document per session, gzip JSONL batches to POST /connector/ingest,
// only for repos the user opted in (masora.js's `repos` map -- default none).
//
// Built entirely from what zevet already reads for its own UI: session
// summaries and transcripts from desktop/agent-sessions.js (the CLIs' own
// JSONL, read-only -- see that file's own header), and `git` for the
// repository slug, the same way desktop/repo-stats.js already shells out to
// git for the file tree's diff badges.
//
// DURABLE RETRY: a small on-disk outbox (~/.zevet/masora-outbox.jsonl). A
// changed session is appended to it before any network call, and a line is
// only removed once Masora has 202'd the batch it was sent in -- so a push
// that fails partway loses nothing, it just retries next cycle. ONLY CHANGED
// SESSIONS are ever appended: a cursor file remembers each session's last-seen
// `updated` timestamp (agent-sessions.js already recomputes this from the
// transcript's own timestamps), and a session whose `updated` has not moved
// since the last successful cursor write is never re-read, let alone re-sent.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFile } = require("node:child_process");

const HOME = process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet");
const OUTBOX_PATH = path.join(HOME, "masora-outbox.jsonl");
/** Zevet Chat records (`surface: "zevet_chat"`) get their OWN outbox. A Masora
 *  that predates that surface answers such a line with a whole-batch 400, and
 *  a shared outbox would then hold every session queued behind it forever. */
const CHAT_OUTBOX_PATH = path.join(HOME, "masora-chat-outbox.jsonl");
const CURSOR_PATH = path.join(HOME, "masora-cursor.json");

const GIT_TIMEOUT_MS = 4000;
/** C1: content_text capped at 200 KB server-side; capped here too so a
 *  session too large to ever be accepted is never carried in the outbox. */
const CONTENT_TEXT_MAX_BYTES = 200_000;
/** One HTTP POST covers at most this many sessions, so one huge backlog does
 *  not become one huge gzip body. */
const BATCH_SIZE = 50;

/**
 * `owner/name` from `git remote get-url origin`, handling both the SSH and
 * HTTPS spellings; falls back to the folder name for a repo with no such
 * remote (C1: "<owner/name or folder>"). Best-effort like repo-stats.js's own
 * git calls: no git, no remote, or a timeout all fall back rather than throw.
 */
function deriveRepository(dir) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", dir, "remote", "get-url", "origin"],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        const url = err ? "" : String(stdout).trim();
        const m = url.match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?$/);
        resolve(m ? m[1] : path.basename(dir));
      },
    );
  });
}

/** Tool calls that write files, so their `file_path`/`path` input is what
 *  "files touched" means. ponytail: a fixed name list, not a schema read off
 *  each CLI -- add a name here if a CLI ships a new editing tool. */
const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function textOfContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * The markdown transcript and the files touched, from one session's records
 * as `agent-sessions.js#read()` returns them (claude: `{type, message}`;
 * codex: `{item}`).
 */
function summarize(records) {
  const turns = [];
  const files = new Set();
  for (const r of records) {
    if (r.source === "codex") {
      const item = r.item || {};
      if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
        turns.push(["ASSISTANT", item.text.trim()]);
      } else if (item.type === "user_message" && typeof item.text === "string" && item.text.trim()) {
        turns.push(["HUMAN", item.text.trim()]);
      }
      // Codex's own patch/file tool calls vary by version; best-effort only.
      if (typeof item.path === "string") files.add(item.path);
      continue;
    }
    const message = r.message || {};
    const text = textOfContent(message.content);
    if (text) turns.push([r.type === "user" ? "HUMAN" : "ASSISTANT", text]);
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          block && block.type === "tool_use" && FILE_EDIT_TOOLS.has(block.name) &&
          block.input && typeof block.input.file_path === "string"
        ) {
          files.add(block.input.file_path);
        }
      }
    }
  }
  let contentText = turns.map(([label, text]) => `[${label}]: ${text}`).join("\n");
  if (Buffer.byteLength(contentText, "utf8") > CONTENT_TEXT_MAX_BYTES) {
    contentText = `${Buffer.from(contentText, "utf8").subarray(0, CONTENT_TEXT_MAX_BYTES)}`;
  }
  return { contentText, filesTouched: [...files] };
}

/** One C1 record for one session summary (agent-sessions.js `list()` shape). */
async function toRecord(summary, records, repository) {
  const { contentText, filesTouched } = summarize(records);
  return {
    surface: "zevet",
    external_id: `zevet:session:${summary.source}:${summary.slug}:${summary.id}`,
    repository,
    title: summary.title || summary.id,
    created_at: new Date(summary.started || summary.updated || Date.now()).toISOString(),
    updated_at: new Date(summary.updated || Date.now()).toISOString(),
    content_text: contentText,
    files_touched: filesTouched,
    agent: summary.source === "codex" ? "codex" : "claude",
    participants: [],
  };
}

/* ── cursor: session key -> last-pushed `updated` (ms) ──────────────────── */

function sessionKey(summary) {
  return `${summary.source}:${summary.slug}:${summary.id}`;
}

function readCursor() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CURSOR_PATH, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeCursor(cursor) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CURSOR_PATH, JSON.stringify(cursor), "utf8");
}

/* ── outbox: newline-delimited C1 records awaiting a successful POST ────── */

function appendOutbox(records, file = OUTBOX_PATH) {
  if (!records.length) return;
  fs.mkdirSync(HOME, { recursive: true });
  fs.appendFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
}

function readOutbox(file = OUTBOX_PATH) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** Removes the first `n` lines (the ones just confirmed delivered); anything
 *  appended after they were read stays -- lines are re-read, not indices. */
function removeFromOutbox(n, file = OUTBOX_PATH) {
  const remaining = readOutbox(file).slice(n);
  fs.writeFileSync(
    file,
    remaining.length ? `${remaining.map((r) => JSON.stringify(r)).join("\n")}\n` : "",
    "utf8",
  );
}

/**
 * Sends outbox batches until it is empty or a POST fails. A failure (network,
 * non-202, timeout) stops the loop and leaves the remainder on disk for the
 * next cycle -- this is the durability: nothing is removed before Masora has
 * accepted it.
 */
async function flushOutbox({ baseUrl, token, fetchImpl, file = OUTBOX_PATH }) {
  const f = typeof fetchImpl === "function" ? fetchImpl : (...a) => fetch(...a);
  let sent = 0;
  for (;;) {
    const pending = readOutbox(file);
    if (!pending.length) break;
    const batch = pending.slice(0, BATCH_SIZE);
    const gz = zlib.gzipSync(batch.map((r) => JSON.stringify(r)).join("\n"));
    let res;
    try {
      res = await f(`${String(baseUrl).replace(/\/+$/, "")}/api/connector/ingest`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/gzip" },
        body: gz,
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      break; // network error -- retry next cycle
    }
    if (res.status !== 202) break; // rejected -- leave it for a human/next cycle, not a retry loop
    removeFromOutbox(batch.length, file);
    sent += batch.length;
  }
  return { sent };
}

/**
 * One push cycle: for every opted-in repo, find sessions whose `updated` has
 * moved since the cursor, turn the changed ones into C1 records, append them
 * to the outbox, advance the cursor, then flush. `listSessions`/`readSession`
 * are `agent-sessions.js`'s `list`/`read` (injected so this is testable with
 * fixtures instead of a real `~/.claude`).
 */
async function runOnce({ repos, baseUrl, token, listSessions, readSession, fetchImpl }) {
  const dirs = Object.keys(repos || {});
  if (!dirs.length || !token) return { queued: 0, sent: 0 };
  const cursor = readCursor();
  const toQueue = [];
  for (const dir of dirs) {
    const repository = await deriveRepository(dir);
    const { sessions } = listSessions({ cwd: dir });
    for (const summary of sessions) {
      const key = sessionKey(summary);
      if (cursor[key] && cursor[key] >= (summary.updated || 0)) continue;
      const { records } = readSession(summary.source, summary.slug, summary.id);
      toQueue.push({ summary, key, record: await toRecord(summary, records, repository) });
    }
  }
  if (toQueue.length) {
    appendOutbox(toQueue.map((q) => q.record));
    const nextCursor = { ...cursor };
    for (const q of toQueue) nextCursor[q.key] = q.summary.updated || Date.now();
    writeCursor(nextCursor);
  }
  const { sent } = await flushOutbox({ baseUrl, token, fetchImpl });
  return { queued: toQueue.length, sent };
}

module.exports = {
  OUTBOX_PATH,
  CHAT_OUTBOX_PATH,
  CURSOR_PATH,
  BATCH_SIZE,
  CONTENT_TEXT_MAX_BYTES,
  deriveRepository,
  summarize,
  toRecord,
  readCursor,
  writeCursor,
  appendOutbox,
  readOutbox,
  removeFromOutbox,
  flushOutbox,
  runOnce,
};
