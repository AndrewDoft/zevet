// zevet opencode plugin — reports prompts, tool calls and turn ends to the hub.
//
// zevet-opencode-plugin v1 — managed file, do not edit by hand. Re-run
// `node client/install.mjs <repo> --agents=opencode` to refresh it.
//
// SELF-CONTAINED ON PURPOSE. client/install-opencode.mjs copies this file into
// <repo>/.opencode/plugins/zevet.mjs, where it runs inside opencode with no
// access to the zevet checkout. Node builtins only — no imports beyond these.
// The credential derivation below is a copy of client/secret.mjs
// (SHA-256("zevet-auth\0" || secret)); if that ever changes, this copy changes
// with it, and test/opencode.test.mjs asserts they still agree.
//
// TWO RULES, same as client/hook.mjs:
//   1. Never break the turn. Every handler catches its own errors and never
//      throws into opencode — a throw in tool.execute.before would BLOCK the
//      tool, which is the one thing a watcher must not be able to do.
//   2. Never be noisy. Diagnostics go nowhere unless ZEVET_DEBUG is set.
//      (hook.mjs warns to stderr; a plugin's console is opencode's log surface,
//      so silence is the default here rather than just silence on stdout.)
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const TIMEOUT_MS = Number(process.env.ZEVET_TIMEOUT_MS || 1500);

function debug(msg) {
  if (process.env.ZEVET_DEBUG) {
    try {
      process.stderr.write(`[zevet] ${msg}\n`);
    } catch {
      // Diagnostics must never be the thing that breaks the turn.
    }
  }
}

/**
 * The value the client presents to the hub. Copy of the derivation in
 * client/secret.mjs: hex secret -> SHA-256("zevet-auth\0" || bytes).
 * Legacy raw-token installs are honoured the same way hook.mjs honours them.
 */
function deriveAuthToken(secretHex) {
  return createHash("sha256")
    .update(Buffer.from("zevet-auth\0", "utf8"))
    .update(Buffer.from(secretHex, "hex"))
    .digest("hex");
}

function normaliseSecret(raw) {
  if (typeof raw !== "string") throw new TypeError("master secret must be a string");
  const s = raw.trim().replace(/\s+/g, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(s)) throw new Error("master secret must be hex");
  if (s.length < 48 || s.length % 2 !== 0) throw new Error("master secret too short");
  return s;
}

function settings() {
  let file = {};
  try {
    const home = process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet");
    const raw = readFileSync(path.join(home, "config.json"), "utf8").replace(/^\uFEFF/, "");
    file = JSON.parse(raw);
  } catch {
    // No config yet, or unreadable. Environment variables may still carry it.
  }
  let username = "";
  try {
    username = os.userInfo().username || "";
  } catch {
    username = "";
  }
  // Session beats secret beats legacy token — the same precedence
  // client/secret.mjs resolveAuth implements.
  const session = process.env.ZEVET_SESSION || file.session || "";
  let token = "";
  if (session) {
    token = session;
  } else {
    const rawSecret = process.env.ZEVET_SECRET || file.secret || "";
    if (rawSecret) {
      try {
        token = deriveAuthToken(normaliseSecret(rawSecret));
      } catch (err) {
        debug(`unusable master secret (${err.message})`);
        token = "";
      }
    } else {
      token = process.env.ZEVET_TOKEN || file.token || "";
    }
  }
  return {
    hub: (process.env.ZEVET_HUB || file.hub || "http://127.0.0.1:8787").replace(/\/+$/, ""),
    token,
    actor: process.env.ZEVET_ACTOR || file.actor || username || "unknown",
  };
}

/** Repo root, name and branch, straight off the filesystem. No git subprocess. */
function repoInfo(startDir) {
  try {
    let dir = path.resolve(startDir || process.cwd());
    for (let i = 0; i < 40; i++) {
      if (existsSync(path.join(dir, ".git"))) {
        return { repo: path.basename(dir), root: dir };
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch (err) {
    debug(`repo lookup failed: ${err.message}`);
  }
  return { repo: "", root: null };
}

/**
 * A file path every teammate spells the same way: relative to the repo root,
 * so Windows and macOS checkouts of one repo compare equal for the collision
 * check. Outside the repo, basename only — never a home directory layout.
 */
function repoRelative(file, root) {
  try {
    if (!root) return path.basename(file);
    const rel = path.relative(root, path.resolve(root, file));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return path.basename(file);
    return rel.split(path.sep).join("/");
  } catch {
    return path.basename(file);
  }
}

/**
 * Never put a credential on the wire or on three screens. Copy of the net in
 * client/hook.mjs — obvious shapes replaced, not a guarantee.
 */
const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-or-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:bearer|token|api[-_]?key|secret|password|passwd|pwd)\b[\s"':=]+\S+/gi,
  /\b[A-Fa-f0-9]{40,}\b/g,
];

function scrub(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

/** The one file or command this tool call is about. */
function describe(args) {
  const i = args && typeof args === "object" ? args : {};
  const firstString = (...keys) => {
    for (const k of keys) if (typeof i[k] === "string" && i[k]) return i[k];
    return null;
  };
  const file = firstString("file_path", "filePath", "path", "notebook_path", "file");
  if (file) return { file, detail: "" };
  const cmd = firstString("command");
  if (cmd) return { file: null, detail: cmd.slice(0, 300) };
  const pattern = firstString("pattern", "query", "url");
  if (pattern) return { file: null, detail: pattern.slice(0, 300) };
  return { file: null, detail: "" };
}

async function post(payload) {
  const { hub, token, actor } = settings();
  if (!token) {
    debug("no credential — nothing sent");
    return;
  }
  let machine = "";
  try {
    machine = os.hostname() || "";
  } catch {
    machine = "";
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${hub}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": token },
      body: JSON.stringify({ ...payload, actor, machine, agent: "opencode" }),
      signal: ac.signal,
      // Same reasoning as hook.mjs: a custom header survives a cross-origin
      // redirect, so a redirecting hub would collect the team's credential.
      // The hub never redirects; refusing costs nothing.
      redirect: "error",
    });
    if (!res.ok) debug(`hub answered ${res.status} — turn unaffected`);
    await res.arrayBuffer().catch(() => {});
  } catch (err) {
    const why = err.name === "AbortError" ? `no answer in ${TIMEOUT_MS}ms` : err.message;
    debug(`hub unreachable (${why}) — turn unaffected`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The plugin. opencode calls this once at startup with { project, directory,
 * ... }; the returned hooks run per event. directory is the repo opencode was
 * started in — the same role --zevet-repo plays for the shell hook.
 */
export const Zevet = async ({ directory } = {}) => {
  const { repo, root } = repoInfo(directory);
  const detailLevel = (process.env.ZEVET_DETAIL || "full").toLowerCase();

  return {
    // Fires before each tool runs. input.tool is the name, output.args holds
    // the arguments — the opencode equivalent of Claude Code's PreToolUse.
    "tool.execute.before": async (input, output) => {
      try {
        const tool = (input && input.tool) || "";
        if (!tool) return;
        const { file, detail } = describe(output && output.args);
        let shown = "";
        if (detailLevel === "full") shown = scrub(detail);
        else if (detailLevel === "brief") shown = String(detail || "").trim().split(/\s+/)[0] || "";
        await post({ kind: "tool", tool, target: file ? repoRelative(file, root) : null, detail: shown, repo });
      } catch (err) {
        // Rule 1. A watcher that can throw into tool.execute.before is a
        // watcher that can end somebody's turn.
        debug(`tool hook bug, ignored: ${err && err.message}`);
      }
    },

    // tool.execute.after is deliberately NOT reported — it fires for the same
    // call tool.execute.before already announced, and sending both would draw
    // every tool twice. Same reason hook.mjs ignores PostToolUse.
    event: async ({ event } = {}) => {
      try {
        if (!event || typeof event.type !== "string") return;
        if (event.type === "session.idle") {
          // The turn went quiet — the opencode equivalent of Stop.
          await post({ kind: "turn_end", tool: "", target: null, detail: "", repo });
        } else if (event.type === "session.created") {
          // A session started. opencode does not hand us the prompt text here
          // the way UserPromptSubmit does, so this is a marker, not a quote.
          await post({ kind: "prompt", tool: "", target: null, detail: "", repo });
        }
      } catch (err) {
        debug(`event hook bug, ignored: ${err && err.message}`);
      }
    },
  };
};
