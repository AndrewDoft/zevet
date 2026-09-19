// zevet hook — runs on every prompt, tool call and turn end, on every machine.
//
// TWO RULES, both learned the hard way from taking apart a tool that broke
// them. Amoeba's PreToolUse hook answered `permissionDecision: "defer"` when
// its daemon had nothing to say, on the documented belief that defer is the
// same as staying silent. Against Claude Code 2.1.275 it is not: the turn ends
// with stop_reason "tool_deferred" and the tool never runs. A watcher that can
// end someone's turn is worse than no watcher.
//
//   1. NOTHING is ever written to stdout. Not a decision, not a diagnostic,
//      not an empty object. Silence is the only output guaranteed to leave the
//      CLI's own permission flow untouched.
//   2. EXIT 0, always, on every path including our own bugs. Diagnostics go to
//      stderr, which Claude Code surfaces without acting on.
//
// Everything else is best effort. If the hub is down, the turn does not care.
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { resolveAuth } from "./secret.mjs";

/**
 * Settings, from ~/.zevet/config.json, with environment variables winning.
 *
 * The file is the normal case: `setup.ps1`/`setup.sh` write it once and a
 * teammate never thinks about it again. Requiring exported variables instead
 * would mean every one of them had to get their shell profile right before
 * zevet did anything at all, and would fail silently when they didn't.
 */
function settings() {
  let file = {};
  try {
    const home = process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet");
    // Strip a UTF-8 BOM. Windows PowerShell 5.1 writes one with
    // `Set-Content -Encoding UTF8`, and JSON.parse rejects a leading U+FEFF —
    // which silently sent every Windows teammate back to the 127.0.0.1 default
    // and kept them off the board entirely.
    const raw = readFileSync(path.join(home, "config.json"), "utf8").replace(/^\uFEFF/, "");
    file = JSON.parse(raw);
  } catch {
    // No config yet, or unreadable. Environment variables may still carry it.
  }
  // os.userInfo() THROWS when the OS has no passwd entry for this uid — inside
  // some containers, and on certain roaming/domain profiles. This runs at
  // module scope, so an uncaught throw here exits non-zero with a stack trace
  // on every single tool call, breaking rule 2 above at the first hurdle.
  let username = "";
  try {
    username = os.userInfo().username || "";
  } catch {
    username = "";
  }
  // THE CREDENTIAL IS DERIVED, NOT COPIED. `file.secret` is the team's master
  // secret and must never leave this machine; what goes on the wire is
  // SHA-256("zevet-auth\0" || S), which the hub can check and can do nothing
  // else with (client/secret.mjs explains why, and why a config holding only a
  // legacy `token` still works until the hub's env is cut over).
  //
  // resolveAuth is documented never to throw — a malformed secret comes back as
  // `error`. This call is still fenced, because it runs at MODULE SCOPE, above
  // and outside main()'s .catch(): a throw here would exit non-zero with a
  // stack trace before a single byte of stdin had been read, on every tool
  // call, which is rule 2 broken at the first hurdle. The fence is not distrust
  // of resolveAuth; it is that this one call site has no other net under it.
  let auth = { token: "", error: null };
  try {
    auth = resolveAuth({ env: process.env, file });
  } catch (err) {
    // Cannot happen per the contract. If it ever does, the hook still runs and
    // simply has no credential: the hub answers 401, warn() says so on stderr,
    // and the turn is unaffected.
    auth = { token: "", error: err && err.message };
  }
  if (auth.error) {
    // stderr only. Claude Code surfaces it without acting on it, and it is the
    // single thread connecting "the board is empty" to "the secret is a typo".
    warn(`the configured master secret is unusable (${auth.error}) — run \`node client/doctor.mjs\``);
  }

  return {
    hub: (process.env.ZEVET_HUB || file.hub || "http://127.0.0.1:8787").replace(/\/+$/, ""),
    token: auth.token,
    actor: process.env.ZEVET_ACTOR || file.actor || username || "unknown",
  };
}

const { hub: HUB, token: TOKEN, actor: ACTOR } = settings();

/** `--zevet-repo <path>` / `--zevet-agent <id>`, written into the command by install.mjs. */
function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const REPO_FLAG = flag("--zevet-repo");
const AGENT_FLAG = flag("--zevet-agent");
const TIMEOUT_MS = Number(process.env.ZEVET_TIMEOUT_MS || 1500);

/**
 * Which agent is calling. The flag is authoritative -- the installer wrote the
 * command and knows. The payload sniff only covers a hook installed by an
 * older version, whose command carries no flag.
 */
const isCodex = AGENT_FLAG ? AGENT_FLAG === "codex" : false;

/** The repos this machine opted in to reporting Codex activity for. */
function repoIsOptedIn(dir) {
  let list;
  try {
    const home = process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet");
    const raw = readFileSync(path.join(home, "codex-repos.json"), "utf8").replace(/^﻿/, "");
    const parsed = JSON.parse(raw);
    list = Array.isArray(parsed) ? parsed : [];
  } catch {
    // No list, no opt-in. Silence is the safe direction for a global hook:
    // better to report nothing than to publish a repo nobody chose.
    return false;
  }
  const here = path.resolve(dir || "");
  return list.some((d) => {
    if (typeof d !== "string" || !d.trim()) return false;
    const there = path.resolve(d);
    return process.platform === "win32" ? there.toLowerCase() === here.toLowerCase() : there === here;
  });
}

function warn(msg) {
  try {
    process.stderr.write(`[zevet] ${msg}\n`);
  } catch {
    // Diagnostics must never be the thing that breaks the hook.
  }
}

/**
 * Repo root, name and branch, straight off the filesystem.
 *
 * No `git` subprocess: this runs before every single tool call, on both
 * platforms, and spawning a process each time is latency we would be adding to
 * someone else's turn for information that is two file reads away.
 */
function repoInfo(startDir) {
  try {
    let dir = path.resolve(startDir || process.cwd());
    for (let i = 0; i < 40; i++) {
      const dotgit = path.join(dir, ".git");
      if (existsSync(dotgit)) {
        let branch = "";
        try {
          let gitdir = dotgit;
          if (!existsSync(path.join(dotgit, "HEAD"))) {
            // In a worktree, .git is a file pointing at the real gitdir.
            const link = readFileSync(dotgit, "utf8").trim();
            const m = link.match(/^gitdir:\s*(.+)$/);
            if (m) gitdir = path.resolve(dir, m[1]);
          }
          const head = readFileSync(path.join(gitdir, "HEAD"), "utf8").trim();
          const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
          branch = ref ? ref[1] : head.slice(0, 8);
        } catch (err) {
          warn(`could not read HEAD: ${err.code || err.message}`);
        }
        return { repo: path.basename(dir), branch, root: dir };
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch (err) {
    warn(`repo lookup failed: ${err.message}`);
  }
  return { repo: "", branch: "", root: null };
}

/**
 * A file path every teammate will spell the same way.
 *
 * REQUIRED for the collision check to work at all across machines. Andrew's
 * `C:\dev\masora\src\db.ts` and Kai's `/Users/kai/code/masora/src/db.ts` are
 * the same file, and comparing absolute paths would never say so — the warning
 * would silently never fire in exactly the mixed Windows/macOS setup it exists
 * for. Relative to the repo root, both are `src/db.ts`.
 *
 * A path outside the repo keeps its basename only; it is not ours to publish
 * someone's home directory layout to the team.
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
 * Never put a credential on the wire or on three screens.
 *
 * This reports what people type: prompts, and shell commands verbatim. That is
 * the feature — "michael is running the migration" is the whole point — but it
 * means an `export STRIPE_KEY=sk_live_...`, a `curl -H "Authorization: Bearer
 * ..."` or a password pasted into a prompt would otherwise be transmitted in
 * clear and drawn on everybody's board, where it also sits in the hub's memory.
 *
 * So the obvious shapes are replaced before the event is built. This is a net,
 * not a guarantee — a secret that looks like an English sentence goes through,
 * and no regex fixes that. `ZEVET_DETAIL=brief` keeps only the first word of a
 * command and drops prompt bodies entirely, for anyone who would rather not
 * rely on a net at all.
 */
const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, // stripe, openai and friends
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, // github tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // aws access key id
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // slack
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // jwt
  /\b(?:bearer|token|api[-_]?key|secret|password|passwd|pwd)\b[\s"':=]+\S+/gi,
  /\b[A-Fa-f0-9]{40,}\b/g, // long hex blobs
];

function scrub(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

/** The one file or command this tool call is about. */
function describe(input) {
  const i = input && typeof input === "object" ? input : {};
  const firstString = (...keys) => {
    for (const k of keys) if (typeof i[k] === "string" && i[k]) return i[k];
    return null;
  };
  const file = firstString("file_path", "path", "notebook_path", "filePath");
  if (file) return { file, detail: "" };
  const cmd = firstString("command");
  if (cmd) return { file: null, detail: cmd.slice(0, 300) };
  const pattern = firstString("pattern", "query", "url");
  if (pattern) return { file: null, detail: pattern.slice(0, 300) };
  return { file: null, detail: "" };
}

async function main() {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return; // no stdin: nothing to report, and nothing to complain about
  }
  if (process.env.ZEVET_DEBUG) warn(`payload: ${raw.slice(0, 1200)}`);

  let p = {};
  try {
    p = JSON.parse(raw || "{}");
  } catch {
    return;
  }

  const eventName = p.hook_event_name || p.hookEventName || "";

  // PostToolUse is deliberately NOT reported. It fires for the same tool call
  // PreToolUse already announced, so sending both drew every tool twice on the
  // board and doubled the hook traffic on every turn for no added meaning.
  if (eventName === "PostToolUse") return;

  // Both agents send `cwd`. The claim that Codex does not was wrong, and it was
  // wrong in a load-bearing way: it is why the installer baked a --zevet-repo
  // into the command, which only works while the hooks config is per-repo.
  // MEASURED on codex-cli 0.155.0-alpha.2.6, the Stop payload is
  //   {session_id, turn_id, transcript_path, cwd, hook_event_name, model,
  //    permission_mode, stop_hook_active, last_assistant_message}
  // Payload first, flag second, process cwd last.
  const cwd = p.cwd || REPO_FLAG || process.cwd();
  const { repo, branch, root } = repoInfo(cwd);

  // Codex's hooks live in the GLOBAL config (a repo-local block never fires),
  // so this hook is invoked for every project on the machine. The opt-in list
  // is what keeps zevet from publishing unrelated work to a shared hub: no
  // entry, no event, no noise. Claude Code is wired per repo and needs no such
  // filter -- if its hook ran, somebody installed it there on purpose.
  if (isCodex && !repoIsOptedIn(root || cwd)) return;

  // full  — prompts and commands as typed, with secrets scrubbed (default)
  // brief — the first word of a command, no prompt bodies
  // none  — nothing but the tool name and file
  const detailLevel = (process.env.ZEVET_DETAIL || "full").toLowerCase();

  let body;
  if (eventName === "UserPromptSubmit") {
    const prompt = detailLevel === "full" ? scrub(String(p.prompt || "")).slice(0, 400) : "";
    body = { kind: "prompt", tool: "", target: null, detail: prompt };
  } else if (eventName === "Stop" || eventName === "SubagentStop") {
    body = { kind: "turn_end", tool: "", target: null, detail: "" };
  } else {
    const tool = p.tool_name || p.toolName || "";
    if (!tool) return;
    const { file, detail } = describe(p.tool_input || p.toolInput);
    let shown = "";
    if (detailLevel === "full") shown = scrub(detail);
    else if (detailLevel === "brief") shown = String(detail || "").trim().split(/\s+/)[0] || "";
    body = { kind: "tool", tool, target: file ? repoRelative(file, root) : null, detail: shown };
  }

  let machine = "";
  try {
    machine = os.hostname() || "";
  } catch {
    machine = "";
  }

  // Which agent produced this. Codex payloads carry `agent_type`/`turn_id`;
  // Claude Code's carry `cwd`. The flag is authoritative because install.mjs
  // knows exactly which config file it wrote the command into.
  const agent = isCodex ? "codex" : "claude-code";

  const payload = { ...body, actor: ACTOR, machine, repo, branch, agent };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${HUB}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": TOKEN },
      body: JSON.stringify(payload),
      signal: ac.signal,
      // MEASURED: fetch follows redirects by default and, per spec, strips only
      // Authorization and Cookie when the origin changes. A custom header does
      // NOT get stripped — a hub that 302s elsewhere (compromise, a proxy
      // "canonicalising" the host, an injection over plain HTTP) receives the
      // team's shared secret from every machine, silently. The hub never has a
      // legitimate reason to redirect, so refusing costs nothing.
      redirect: "error",
    });
    if (!res.ok) warn(`hub answered ${res.status} — this turn is unaffected`);
    // Drain before exiting. process.exit() with an undici socket still in
    // teardown is what tripped a libuv assertion in the updater.
    await res.arrayBuffer().catch(() => {});
  } catch (err) {
    const why = err.name === "AbortError" ? `no answer in ${TIMEOUT_MS}ms` : err.message;
    warn(`hub unreachable (${why}) — this turn is unaffected`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kick off an update check, at most every half hour, without waiting for it.
 *
 * Detached and unref'd: this process exits immediately whether or not the
 * updater has finished, so an update can never sit in front of somebody's
 * turn. The rate limit is a timestamp written into a file, because each hook
 * run is a fresh process with no memory of the last one.
 */
function maybeCheckForUpdates() {
  try {
    const home = process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet");
    const updater = path.join(path.dirname(fileURLToPath(import.meta.url)), "updater.mjs");
    if (!existsSync(updater)) return;

    const every = Number(process.env.ZEVET_UPDATE_INTERVAL_MS || 30 * 60 * 1000);
    const stamp = path.join(home, "last-check");
    if (existsSync(stamp)) {
      const age = Date.now() - Number(readFileSync(stamp, "utf8").trim() || 0);
      // A NEGATIVE age means the stamp is in the future — a clock correction,
      // or a dual-boot machine with the RTC in local time. The old condition
      // was `age >= 0 && age < every`, which fell through on a future stamp
      // and pinned the client into spawning a fresh node process on EVERY
      // tool call, forever. Out-of-range in either direction means "do not
      // trust it, and do not hammer": treat it as fresh and move on.
      if (age < 0) return;
      if (age < every) return;
    }

    const child = spawn(process.execPath, [updater], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    warn(`could not start the update check: ${err.message}`);
  }
}

main()
  .catch((err) => warn(`hook bug, ignored: ${err && err.message}`))
  .finally(() => {
    maybeCheckForUpdates();
    process.exit(0);
  });
