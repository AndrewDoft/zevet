"use strict";

/**
 * A few words naming a console, from a small model, the way the Claude and
 * Codex desktop apps title a conversation.
 *
 * Without it a console is titled by the first sentence of its prompt, and a
 * rail of agents started from similar prompts reads "You are working in a git
 * worktree of zev…" twelve times. Headless `claude -p` never writes the
 * ai-title interactive Claude Code does, and codex/opencode runs have none.
 *
 * ⚠️ BEST EFFORT, ALWAYS. Every failure — not installed, not signed in, slow,
 * a non-zero exit, an answer that is not a title — resolves "" and the caller
 * keeps the first-sentence fallback. One attempt, never retried, and never in
 * the agent's path: the caller does not wait on it.
 *
 * No Electron in here, so node --test can load it; the spawn is injectable.
 */

const childProcess = require("node:child_process");
const os = require("node:os");

const MODEL = "claude-haiku-4-5-20251001";
const TIMEOUT_MS = 15000;
const MAX_PROMPT = 1500;
const MAX_TITLE = 48;

/* `--setting-sources project` from a cwd with no project skips the user's
   settings, and with them the hooks zevet installs — otherwise the titling run
   would show up on the board as an agent of its own. `--no-session-persistence`
   keeps it out of the session list for the same reason. No argument carries
   text, so a .cmd shim can take these as they are (agent-console.js § shims). */
const ARGS = ["-p", "--model", MODEL, "--setting-sources", "project", "--no-session-persistence", "--strict-mcp-config"];

const ASK =
  "Reply with a 2-5 word title for the request below, like a conversation title in a chat app. " +
  "Answer with the title only: no quotes, no trailing period, nothing else.";

/** The person's words with harness envelopes peeled off the front — the same
 *  rule as board/src/lib/sessions.mjs § unwrapEnvelope, which is ESM and not
 *  shipped beside this file. */
function peel(prompt) {
  let out = String(prompt || "").trim();
  for (let i = 0; i < 12; i++) {
    const closed = /^<([a-zA-Z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/.exec(out);
    if (closed) {
      out = out.slice(closed[0].length).trim();
      continue;
    }
    const opener = /^<[a-zA-Z]+[\w]*[-_][\w-]*(?:\s[^>]*)?>\s*/.exec(out);
    if (!opener) break;
    out = out.slice(opener[0].length).trim();
  }
  return out.replace(/<\/?[\w-]*(?:\s[^>]*)?>?/g, "").trim() ? out : "";
}

/** One short line or "". An answer that runs long is the model talking, not
 *  titling, and a talking answer is worse than the fallback. */
function sanitize(answer) {
  const line = String(answer || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) || "";
  let t = line
    .replace(/^title\s*:\s*/i, "")
    .replace(/^["'“”‘’`*_#\s]+|["'“”‘’`*_\s]+$/g, "")
    .replace(/[.。]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.split(" ").length > 8) return "";
  if (t.length > MAX_TITLE) {
    const cut = t.slice(0, MAX_TITLE);
    t = (cut.lastIndexOf(" ") > 0 ? cut.slice(0, cut.lastIndexOf(" ")) : cut).replace(/[\s,;:.-]+$/, "");
  }
  return t;
}

/**
 * Resolve a title for `prompt`, or "" on any failure.
 * @param {string} prompt
 * @param {{ command: string, args?: string[], options?: object, spawn?: Function, timeoutMs?: number }} how
 */
function titleFor(prompt, { command, args = ARGS, options = {}, spawn = childProcess.spawn, timeoutMs = TIMEOUT_MS } = {}) {
  const ask = peel(prompt).slice(0, MAX_PROMPT);
  if (!ask || !command) return Promise.resolve("");
  return new Promise((resolve) => {
    let child;
    let out = "";
    let timer = null;
    const done = (title) => {
      clearTimeout(timer);
      resolve(title);
    };
    try {
      child = spawn(command, args, { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "ignore"], windowsHide: true, ...options });
    } catch {
      return resolve("");
    }
    // ponytail: kill() takes cmd.exe, not a shim's claude under it; that one
    // is a single short call and ends by itself. taskkill /T if it ever lingers.
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      resolve("");
    }, timeoutMs);
    child.on("error", () => done(""));
    child.stdout.on("data", (b) => {
      out += b;
    });
    child.on("close", (code) => done(code === 0 ? sanitize(out) : ""));
    child.stdin.on("error", () => {});
    child.stdin.end(`${ASK}\n\n<request>\n${ask}\n</request>\n`);
  });
}

module.exports = { titleFor, sanitize, peel, ARGS, MODEL };
