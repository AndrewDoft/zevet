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
    const raw = readFileSync(path.join(home, "config.json"), "utf8").replace(/^﻿/, "");
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
  return {
    hub: (process.env.ZEVET_HUB || file.hub || "http://127.0.0.1:8787").replace(/\/+$/, ""),
    token: process.env.ZEVET_TOKEN || file.token || "",
    actor: process.env.ZEVET_ACTOR || file.actor || username || "unknown",
  };
}

const { hub: HUB, token: TOKEN, actor: ACTOR } = settings();
const TIMEOUT_MS = Number(process.env.ZEVET_TIMEOUT_MS || 1500);

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

  const cwd = p.cwd || process.cwd();
  const { repo, branch, root } = repoInfo(cwd);

  let body;
  if (eventName === "UserPromptSubmit") {
    body = { kind: "prompt", tool: "", target: null, detail: String(p.prompt || "").slice(0, 400) };
  } else if (eventName === "Stop" || eventName === "SubagentStop") {
    body = { kind: "turn_end", tool: "", target: null, detail: "" };
  } else {
    const tool = p.tool_name || p.toolName || "";
    if (!tool) return;
    const { file, detail } = describe(p.tool_input || p.toolInput);
    body = { kind: "tool", tool, target: file ? repoRelative(file, root) : null, detail };
  }

  let machine = "";
  try {
    machine = os.hostname() || "";
  } catch {
    machine = "";
  }

  const payload = { ...body, actor: ACTOR, machine, repo, branch, agent: "claude-code" };

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
