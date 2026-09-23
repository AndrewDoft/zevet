// zevet opencode plugin — reports prompts, tool calls and turn ends to the hub.
//
// zevet-opencode-plugin v1 — managed file, do not edit by hand. Re-run
// `node client/install.mjs <repo> --agents=opencode` to refresh it.
//
// SELF-CONTAINED ON PURPOSE. client/install-opencode.mjs copies this file into
// <repo>/.opencode/plugins/zevet.js, where it runs inside opencode with no
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
import { readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
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

/**
 * The repo a zevet-made worktree belongs to, or null for any other folder.
 *
 * desktop/agent-worktree.js gives a second agent in one repo a worktree of its
 * own, beside a record of which repo it is. To everyone watching it IS that
 * repo: same name, same branch, same checkout, so its file activity is not
 * dropped as some other checkout's. Keep in sync with the copy in hook.mjs.
 */
function zevetOrigin(dir) {
  const home = process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet");
  const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!same(path.dirname(dir), path.resolve(home, "worktrees"))) return null;
  try {
    const { repo } = JSON.parse(readFileSync(`${dir}.json`, "utf8"));
    return typeof repo === "string" && repo ? path.resolve(repo) : null;
  } catch {
    return null;
  }
}

/**
 * The repos this machine opted in to reporting opencode activity for.
 *
 * Copy of install-opencode.mjs's readOpencodeRepos + sameRepoPath, inline for
 * the same reason the credential derivation above is: this file runs with no
 * access to the checkout. Load-bearing, not optional — this is a GLOBAL
 * plugin now (opencodeGlobalPluginPath's comment), so without this check it
 * would report every `opencode run` on the machine, including repos nobody
 * ever pointed zevet at. See DECISIONS.md D-001, which hit the identical
 * problem for Codex's global hooks first.
 */
function repoIsOptedIn(dir) {
  let list;
  try {
    const home = process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet");
    const raw = readFileSync(path.join(home, "opencode-repos.json"), "utf8").replace(/^﻿/, "");
    const parsed = JSON.parse(raw);
    list = Array.isArray(parsed) ? parsed : [];
  } catch {
    // No list, no opt-in. Silence is the safe direction for a global plugin —
    // better to report nothing than to publish a repo nobody chose.
    return false;
  }
  const canonical = (p) => {
    try {
      return realpathSync(path.resolve(p));
    } catch {
      return path.resolve(p);
    }
  };
  const here = canonical(dir || "");
  return list.some((d) => {
    if (typeof d !== "string" || !d.trim()) return false;
    const there = canonical(d);
    return process.platform === "win32" ? there.toLowerCase() === here.toLowerCase() : there === here;
  });
}

/** Repo root, name and branch, straight off the filesystem. No git subprocess. */
function repoInfo(startDir) {
  try {
    let dir = path.resolve(startDir || process.cwd());
    for (let i = 0; i < 40; i++) {
      if (existsSync(path.join(dir, ".git"))) {
        const origin = zevetOrigin(dir);
        // `root` stays the worktree: it is where the agent's files are.
        return { repo: path.basename(origin || dir), root: dir, origin };
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

// A checkout fingerprint distinguishes worktrees without publishing local paths.
// Keep this normalization in sync with board.ts's checkoutId.
function checkoutId(root) {
  if (!root) return "";
  let normalized = root.replaceAll("\\", "/").replace(/\/+$/, "");
  if (/^[a-z]:/i.test(normalized) || normalized.startsWith("//")) normalized = normalized.toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * A file path every teammate spells the same way: relative to the repo root,
 * so Windows and macOS checkouts of one repo compare equal for the collision
 * check. Outside paths have no target — never a made-up root file.
 */
function repoRelative(file, root, cwd = root) {
  try {
    if (!root) return null;
    const rel = path.relative(root, path.resolve(cwd || root, file));
    if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join("/");
  } catch {
    return null;
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
  await flushOutbox();
  const r = await postEvent(payload, TIMEOUT_MS);
  if (r.status === "failed") outboxAppend(payload);
}

async function postEvent(body, timeoutMs) {
  const { hub, token, actor } = settings();
  if (!token) {
    debug("no credential — nothing sent");
    return { status: "rejected", code: 0 };
  }
  let machine = "";
  try {
    machine = os.hostname() || "";
  } catch {
    machine = "";
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${hub}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": token },
      body: JSON.stringify({ ...body, actor, machine, agent: "opencode" }),
      signal: ac.signal,
      // Same reasoning as hook.mjs: a custom header survives a cross-origin
      // redirect, so a redirecting hub would collect the team's credential.
      // The hub never redirects; refusing costs nothing.
      redirect: "error",
    });
    if (!res.ok) {
      debug(`hub answered ${res.status} — turn unaffected`);
      return { status: "rejected", code: res.status };
    }
    await res.arrayBuffer().catch(() => {});
    return { status: "sent" };
  } catch (err) {
    const why = err.name === "AbortError" ? `no answer in ${timeoutMs}ms` : err.message;
    debug(`hub unreachable (${why}) — kept for later, turn unaffected`);
    return { status: "failed", why };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Store-and-forward. Copy of the outbox in client/hook.mjs — same bounds
 * (4 per run, 250ms each, 100 stored), same rule (only network failures are
 * queued; answers are dropped). The two are copies, not imports: this file
 * runs inside opencode with no access to the checkout. If one changes, the
 * other changes with it.
 */
const OUTBOX_FLUSH_MAX = 4;
const OUTBOX_TRY_MS = 250;
const OUTBOX_MAX = 100;

function outboxFile() {
  const home = process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet");
  return path.join(home, "outbox.jsonl");
}

function outboxRead() {
  try {
    const out = [];
    for (const line of readFileSync(outboxFile(), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt && typeof evt === "object") out.push(evt);
      } catch {
        // One corrupt line is not a corrupt outbox.
      }
    }
    return out;
  } catch {
    return [];
  }
}

function outboxWrite(list) {
  try {
    const home = process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet");
    mkdirSync(home, { recursive: true });
    writeFileSync(outboxFile(), list.map((e) => JSON.stringify(e)).join("\n") + (list.length ? "\n" : ""), "utf8");
  } catch (err) {
    debug(`could not write the outbox (${err.message}) — the event is lost`);
  }
}

function outboxAppend(body) {
  const list = outboxRead();
  list.push(body);
  while (list.length > OUTBOX_MAX) list.shift();
  outboxWrite(list);
}

async function flushOutbox() {
  const list = outboxRead();
  if (!list.length) return;
  const rest = [];
  let attempts = 0;
  for (const body of list) {
    if (attempts >= OUTBOX_FLUSH_MAX) {
      rest.push(body);
      continue;
    }
    attempts++;
    const r = await postEvent(body, OUTBOX_TRY_MS);
    if (r.status !== "sent") rest.push(body);
  }
  outboxWrite(rest);
}

/**
 * The plugin. opencode calls this once at startup with { project, directory,
 * ... }; the returned hooks run per event. directory is the repo opencode was
 * started in — the same role --zevet-repo plays for the shell hook.
 */
export const Zevet = async ({ directory } = {}) => {
  const { repo, root, origin } = repoInfo(directory);
  const detailLevel = (process.env.ZEVET_DETAIL || "full").toLowerCase();
  // This repo (or the repo a zevet-made worktree belongs to) must be
  // explicitly opted in — see repoIsOptedIn's comment. Checked once, at
  // startup: the directory a session runs in does not change mid-session.
  // Same fallback chain as hook.mjs's Codex check: origin (a zevet-made
  // worktree's real repo), else the git root, else the raw directory opencode
  // handed us — a session outside any git repo still needs SOMETHING to
  // compare against the opt-in list, and "nothing" would either always match
  // (falls open) or never match (silently drops a folder somebody genuinely
  // opted in by its own path, not a repo root).
  const optedIn = repoIsOptedIn(origin || root || directory);

  return {
    // Fires before each tool runs. input.tool is the name, output.args holds
    // the arguments — the opencode equivalent of Claude Code's PreToolUse.
    "tool.execute.before": async (input, output) => {
      try {
        if (!optedIn) return;
        const tool = (input && input.tool) || "";
        if (!tool) return;
        const { file, detail } = describe(output && output.args);
        let shown = "";
        if (detailLevel === "full") shown = scrub(detail);
        else if (detailLevel === "brief") shown = String(detail || "").trim().split(/\s+/)[0] || "";
        await post({ kind: "tool", tool, target: file ? repoRelative(file, root, directory) : null, detail: shown, repo, checkout: checkoutId(origin || root) });
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
        if (!optedIn) return;
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
