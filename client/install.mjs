// Wires zevet's hook into one repo, for whichever agents are on this machine.
//
//   node client/install.mjs <repo-path>
//   node client/install.mjs <repo-path> --remove
//   node client/install.mjs <repo-path> --agents=claude-code,codex
//
// Nobody should have to tell zevet which agent they use: it looks, and wires
// what it finds. Existing config is preserved; ours is stripped and rewritten
// every run, so installing twice leaves one copy rather than two.
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectAgents } from "./detect.mjs";
import { installCodex } from "./install-codex.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, "hook.mjs");

/**
 * How we recognise our own hook entries.
 *
 * A LITERAL FLAG ON THE COMMAND, not a path substring. The previous version
 * matched `zevet/client/hook.mjs` against the command text, which is true of
 * `~/.zevet/client/hook.mjs` only because `.zevet/` happens to contain
 * `zevet/`. MEASURED from a checkout named anything else — a GitHub ZIP that
 * unpacks to `zevet-main/`, a custom ZEVET_HOME, a clone under another name:
 *
 *   3 installs -> UserPromptSubmit 3, PreToolUse 3, Stop 3   (stacked)
 *   --remove   -> "removed 0 hook entries"                   (a no-op)
 *
 * so the board triple-counted every tool call and the documented uninstall
 * could not undo it. The repo's own test did not catch it because it ran from
 * a directory that happened to be called `zevet`; a test whose result depends
 * on where it is checked out is not testing the thing it claims to.
 */
const MARK = "--zevet-hook";
const CLAUDE_EVENTS = ["UserPromptSubmit", "PreToolUse", "Stop"];

function isOurs(entry) {
  if (!entry || typeof entry.command !== "string") return false;
  // Also recognise entries written by earlier versions, which carried no flag
  // and were matched by path. Without this, upgrading leaves the old entry
  // beside the new one and every tool call is counted twice.
  const norm = entry.command.split("\\").join("/").replace(/\/{2,}/g, "/");
  return entry.command.includes(MARK) || /(^|\/)\.?zevet\/client\/hook\.mjs/.test(norm);
}

/**
 * The interpreter to put in the hook command.
 *
 * NOT `process.execPath` unconditionally. Inside the packaged desktop app that
 * is `zevet.exe` — an Electron binary — and the agent does not set
 * ELECTRON_RUN_AS_NODE when it runs a hook. MEASURED against the real build:
 *
 *   stdout bytes: 2        <- Chromium wrote to stdout. Rule 1, broken.
 *   ERROR:net\disk_cache\cache_util_win.cc  Unable to move the cache
 *
 * and on any machine without an instance already running it would boot a
 * window per tool call. A hook that starts a GUI is the Amoeba failure with
 * different stage dressing.
 */
function interpreter() {
  if (!process.versions.electron) return process.execPath;
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, `node${ext}`);
      try {
        if (existsSync(candidate) && !statSync(candidate).isDirectory()) return candidate;
      } catch {
        // Unreadable PATH entry; keep looking.
      }
    }
  }
  console.error("zevet: could not find node on PATH, and refuses to point the hook at the app binary.");
  console.error("       Install Node 20 or newer from https://nodejs.org, then run this again.");
  process.exit(1);
}

/**
 * Quote a path for the shell the agent runs hook commands through.
 *
 * NOT JSON.stringify: that escapes backslashes for JSON, and the result then
 * gets JSON-escaped a second time when the settings file is written. Plain
 * double quotes are what both cmd.exe and sh actually want around a path with
 * a space in it.
 */
function shellQuote(p) {
  if (p.includes('"')) {
    console.error(`zevet: refusing to build a command from a path containing a quote: ${p}`);
    process.exit(1);
  }
  return `"${p}"`;
}

// ---- Claude Code ----------------------------------------------------------

function installClaude(repo, node, remove) {
  const dir = path.join(repo, ".claude");
  const file = path.join(dir, "settings.json");
  mkdirSync(dir, { recursive: true });

  let cfg = {};
  if (existsSync(file)) {
    copyFileSync(file, `${file}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`);
    try {
      cfg = JSON.parse(readFileSync(file, "utf8").replace(/^\ufeff/, "") || "{}");
    } catch (err) {
      return { ok: false, detail: `${file} is not valid JSON (${err.message}). Fix or move it first.` };
    }
  }
  cfg.hooks = cfg.hooks && typeof cfg.hooks === "object" ? cfg.hooks : {};

  // Strip ours first, so install is idempotent and --remove is just
  // install-without-the-add. This also clears entries from older versions.
  let removed = 0;
  for (const evt of Object.keys(cfg.hooks)) {
    const groups = Array.isArray(cfg.hooks[evt]) ? cfg.hooks[evt] : [];
    for (const g of groups) {
      if (!Array.isArray(g.hooks)) continue;
      const before = g.hooks.length;
      g.hooks = g.hooks.filter((h) => !isOurs(h));
      removed += before - g.hooks.length;
    }
    cfg.hooks[evt] = groups.filter((g) => Array.isArray(g.hooks) && g.hooks.length > 0);
    if (cfg.hooks[evt].length === 0) delete cfg.hooks[evt];
  }

  if (!remove) {
    // The repo is passed explicitly as well as relying on the payload's cwd:
    // Claude Code sends one, Codex does not, and one command shape for both is
    // one fewer thing to get wrong.
    const command = `${shellQuote(node)} ${shellQuote(HOOK)} ${MARK} --zevet-agent claude-code --zevet-repo ${shellQuote(repo)}`;
    for (const evt of CLAUDE_EVENTS) {
      const entry = { type: "command", command, timeout: 10 };
      const groups = Array.isArray(cfg.hooks[evt]) ? cfg.hooks[evt] : [];
      groups.push(evt.endsWith("ToolUse") ? { matcher: "*", hooks: [entry] } : { hooks: [entry] });
      cfg.hooks[evt] = groups;
    }
  }

  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  return { ok: true, detail: file, removed };
}

// ---- main ------------------------------------------------------------------

const args = process.argv.slice(2);
const remove = args.includes("--remove");
const onlyArg = args.find((a) => a.startsWith("--agents="));
const only = onlyArg
  ? onlyArg
      .slice("--agents=".length)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : null;
const repo = path.resolve(args.find((a) => !a.startsWith("--")) || process.cwd());

if (!existsSync(repo)) {
  console.error(`zevet: no such directory: ${repo}`);
  process.exit(1);
}
if (!existsSync(HOOK)) {
  console.error(`zevet: hook not found at ${HOOK}`);
  process.exit(1);
}

const detected = detectAgents();
// On --remove, clean up every agent we know how to wire, whether or not it is
// still installed: uninstalling after removing an agent should still tidy up.
const targets = detected.filter((a) => a.wireable && (remove || a.installed) && (!only || only.includes(a.id)));

if (targets.length === 0) {
  console.error("zevet: found no agent to wire up here.");
  for (const a of detected) {
    const state = a.installed ? "installed" : "not installed";
    console.error(`       ${a.label.padEnd(12)} ${state}${a.wireable ? "" : " (no hook contract)"}`);
  }
  console.error("       Install Claude Code or Codex, then run this again.");
  process.exit(1);
}

const node = remove ? "" : interpreter();
let failed = false;
const notes = [];

for (const agent of targets) {
  if (agent.id === "claude-code") {
    const r = installClaude(repo, node, remove);
    if (!r.ok) {
      console.error(`zevet: ${r.detail}`);
      failed = true;
      continue;
    }
    console.log(
      remove
        ? `Claude Code   removed ${r.removed} hook entr${r.removed === 1 ? "y" : "ies"} from ${r.detail}`
        : `Claude Code   3 hooks -> ${r.detail}${r.removed ? ` (replaced ${r.removed})` : ""}`,
    );
  } else if (agent.id === "codex") {
    const r = installCodex(repo, { hookPath: HOOK, node, mark: MARK, remove });
    if (!r.ok) {
      console.error(`zevet: ${r.detail}`);
      failed = true;
      continue;
    }
    console.log(remove ? `Codex         ${r.detail}` : `Codex         3 hooks -> ${r.detail}`);
    if (!remove) {
      notes.push(
        "Codex hooks go in the GLOBAL config, because a hooks block inside a repo never\n" +
          "  fires. So this one install covers every repo on this machine, and the list in\n" +
          "  ~/.zevet/codex-repos.json decides which of them actually report -- repos you\n" +
          "  have not installed into stay off the board.",
      );
    }
    if (!remove && r.trusted === false) {
      notes.push(
        "Codex will IGNORE the hooks just installed until this project is trusted, and it will\n" +
          "  not tell you — an untrusted project looks exactly like zevet being broken. Run\n" +
          `  \`codex\` once in ${repo} and accept the trust prompt, or add to ${r.globalConfig}:\n` +
          `\n      [projects.'${r.trustKey || repo}']\n      trust_level = "trusted"`,
      );
    }
  }
}

if (!remove) {
  console.log("");
  console.log(`  node:  ${node}`);
  console.log(`  hook:  ${HOOK}`);
  for (const a of detected.filter((x) => x.installed && !x.wireable)) {
    console.log(`  note:  ${a.label} is installed, but zevet has no hook contract for it.`);
  }
  for (const n of notes) {
    console.log("");
    console.log(`  ${n}`);
  }
}

process.exit(failed ? 1 : 0);
