// Wires zevet's hook into a repo's .codex/config.toml.
//
// THE SHAPE OF THIS FILE IS NOT GUESSWORK, and it is not mine either: it comes
// from Amoeba's Codex adapter, which probed it live against codex-cli 0.142.5
// with `codex mcp list -c '<toml>'` — a command that loads and validates the
// whole config and then does something entirely local, so a rejected shape
// prints the serde error naming the field that refused it. What that probe
// established, and what this file therefore relies on:
//
//   * `hooks` is a TABLE, not an array of tables. `[[hooks]]` is wrong.
//   * Event keys are PascalCase: UserPromptSubmit, PreToolUse, Stop,
//     SessionStart. The snake_case spelling — which is what the event name
//     serialises to on the wire — is SILENTLY ACCEPTED and never fires,
//     because unknown keys are ignored. That asymmetry is the trap.
//   * Each event key holds a sequence of `{ matcher?: string, hooks: [...] }`.
//   * A handler is `{ type = "command", command = "...", timeout = N }`.
//     A flat `{type=…, command=…}` placed directly in the event array parses
//     fine and is silently discarded — another shape that looks installed and
//     does nothing.
//
// TWO THINGS CODEX DOES DIFFERENTLY FROM CLAUDE CODE, both of which this file
// exists to handle:
//
//   1. TRUST GATING, and it is silent. Codex ignores a project's
//      .codex/config.toml entirely until the project is trusted, with no
//      warning of any kind. A perfectly installed hook in an untrusted project
//      simply never fires. So this checks, and says so.
//   2. NO `cwd` IN THE HOOK PAYLOAD. Claude Code sends one; Codex's stdin
//      vocabulary has no such field. Rather than hope the process cwd is the
//      repo, the repo path is passed on the command line.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const BLOCK_START = "# zevet:hooks:start — managed block, do not edit by hand";
export const BLOCK_END = "# zevet:hooks:end";

/** `$CODEX_HOME`, default `~/.codex` — where the global config and trust table live. */
function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function codexConfigPathFor(repo) {
  return path.join(repo, ".codex", "config.toml");
}

/**
 * A TOML literal string: single quotes, no escape sequences at all.
 *
 * Deliberately not a basic ("...") string. Our command contains Windows
 * backslashes and double quotes, both of which need escaping in a basic string
 * and neither of which means anything inside a literal one. The only character
 * a literal string cannot contain is a single quote, so that is refused.
 */
function tomlLiteral(s) {
  if (s.includes("'")) {
    throw new Error(`refusing to write a path containing a single quote into TOML: ${s}`);
  }
  return `'${s}'`;
}

/**
 * Is this repo trusted by Codex?
 *
 * Read with a line scanner rather than a TOML parser, because there is no TOML
 * dependency here and this needs exactly two token shapes. It never throws: an
 * unreadable global config reports `false`, which is the safe direction — we
 * warn about a project that might be fine rather than stay silent about one
 * that is not. Trust is NOT inherited from a parent directory, so this matches
 * the exact path, and the comparison is case-insensitive because Windows.
 */
export function isTrusted(repo) {
  const globalConfig = path.join(codexHome(), "config.toml");
  let text;
  try {
    text = readFileSync(globalConfig, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return { trusted: false, globalConfig };
  }
  const target = path.resolve(repo).replace(/[\\/]+$/, "").toLowerCase();
  let inTarget = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const m = /^\[projects\.(?:"([^"]*)"|'([^']*)')\]$/.exec(line);
      const key = m ? (m[1] !== undefined ? m[1] : m[2]) : undefined;
      inTarget = key !== undefined && path.resolve(key).replace(/[\\/]+$/, "").toLowerCase() === target;
      continue;
    }
    if (!inTarget) continue;
    const lvl = /^trust_level\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
    if (lvl) return { trusted: (lvl[1] ?? lvl[2]) === "trusted", globalConfig };
  }
  return { trusted: false, globalConfig };
}

function stripBlock(text) {
  const start = text.indexOf(BLOCK_START);
  if (start === -1) return { text, had: false };
  const endIdx = text.indexOf(BLOCK_END, start);
  if (endIdx === -1) {
    // A start with no end means somebody edited it by hand. Leave it alone and
    // say so rather than eating the rest of their file.
    return { text, had: false, malformed: true };
  }
  const end = endIdx + BLOCK_END.length;
  const before = text.slice(0, start).replace(/\n+$/, "\n");
  const after = text.slice(end).replace(/^\n+/, "");
  return { text: before + after, had: true };
}

/** Does a `hooks` key already exist OUTSIDE our managed block? */
function hasForeignHooks(text) {
  const { text: without } = stripBlock(text);
  return /^\s*\[hooks[\].]/m.test(without) || /^\s*hooks\s*\./m.test(without) || /^\s*hooks\s*=/m.test(without);
}

/**
 * @returns {{ok: boolean, detail: string, trusted?: boolean, globalConfig?: string}}
 */
export function installCodex(repo, { hookPath, node, mark, remove = false }) {
  const file = codexConfigPathFor(repo);
  mkdirSync(path.dirname(file), { recursive: true });

  let existing = "";
  if (existsSync(file)) {
    const backup = `${file}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(file, backup);
    existing = readFileSync(file, "utf8");
  }

  const stripped = stripBlock(existing);
  if (stripped.malformed) {
    return {
      ok: false,
      detail: `${file} has a zevet block with no end marker. Fix or remove it by hand; nothing was changed.`,
    };
  }

  if (remove) {
    writeFileSync(file, stripped.text, "utf8");
    return { ok: true, detail: stripped.had ? `removed zevet's hooks from ${file}` : `nothing of zevet's in ${file}` };
  }

  if (hasForeignHooks(stripped.text)) {
    return {
      ok: false,
      detail:
        `${file} already defines its own \`hooks\`. TOML cannot hold two, and merging somebody ` +
        `else's hook config by text surgery is how config files get corrupted. ` +
        `Move those hooks inside zevet's managed block by hand, or remove them.`,
    };
  }

  let command;
  try {
    // The repo is passed explicitly: Codex's hook payload carries no cwd, and
    // assuming the process cwd is the repo is exactly the kind of guess that
    // produces a hook which reports the wrong project.
    command = `${tomlLiteral(`"${node}" "${hookPath}" ${mark} --zevet-agent codex --zevet-repo "${repo}"`)}`;
  } catch (err) {
    return { ok: false, detail: err.message };
  }

  const handler = `{ type = "command", command = ${command}, timeout = 10 }`;
  const block = [
    BLOCK_START,
    "[hooks]",
    `UserPromptSubmit = [{ hooks = [${handler}] }]`,
    `PreToolUse = [{ matcher = "*", hooks = [${handler}] }]`,
    `Stop = [{ hooks = [${handler}] }]`,
    BLOCK_END,
    "",
  ].join("\n");

  const base = stripped.text.length && !stripped.text.endsWith("\n") ? `${stripped.text}\n` : stripped.text;
  writeFileSync(file, `${base}${base.length ? "\n" : ""}${block}`, "utf8");

  const trust = isTrusted(repo);
  // Codex writes its own trust keys lowercased with backslashes; hand back a
  // string in that spelling so a copy-paste matches what it would have written.
  const trustKey = path.resolve(repo).split(path.sep).join(path.win32.sep).toLowerCase();
  return { ok: true, detail: file, trusted: trust.trusted, globalConfig: trust.globalConfig, trustKey };
}
