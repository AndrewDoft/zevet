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
import { listCodexHooks, ourHooks, trustBlockFor, stripTrustBlock } from "./codex-trust.mjs";

export const BLOCK_START = "# zevet:hooks:start — managed block, do not edit by hand";
export const BLOCK_END = "# zevet:hooks:end";

/** `$CODEX_HOME`, default `~/.codex` — where the global config and trust table live. */
function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/**
 * Where Codex hooks ACTUALLY have to live: the global config.
 *
 * MEASURED 2026-09-18 against codex-cli 0.155.0-alpha.2.6. A `[hooks]` block in
 * `<repo>/.codex/config.toml` never fires -- not once, on any event, trusted or
 * with `--dangerously-bypass-hook-trust`. The identical block in
 * `$CODEX_HOME/config.toml` fires on every turn. Codex reads repo-local files
 * for some purposes, but hooks is not one of them in this version.
 *
 * This is why zevet's Codex support was labelled "installs but has never been
 * seen to fire" for its whole life: it was writing a file Codex ignores.
 */
export function codexGlobalConfigPath() {
  return path.join(codexHome(), "config.toml");
}

/**
 * The LEGACY per-repo location. Retained only so an uninstall can clean up the
 * blocks earlier versions wrote there; nothing installs into it any more.
 */
export function codexConfigPathFor(repo) {
  return path.join(repo, ".codex", "config.toml");
}

/**
 * Codex hooks are global, so the hook itself has to decide which repos count.
 * This file is that list; hook.mjs reads it and stays silent for anything not
 * on it, which keeps the per-repo opt-in zevet had when the config was
 * per-repo. Without it, wiring up one repo would publish every repo on the
 * machine to a hub the whole team can read.
 */
export function codexReposPath() {
  return path.join(process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet"), "codex-repos.json");
}

/** Read the opt-in list; a missing or corrupt file is an empty list, never a throw. */
export function readCodexRepos() {
  try {
    const raw = readFileSync(codexReposPath(), "utf8").replace(/^﻿/, "");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((d) => typeof d === "string" && d.trim()) : [];
  } catch {
    // Unreadable and absent are the same answer here: nothing is opted in.
    return [];
  }
}

function writeCodexRepos(list) {
  const file = codexReposPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(list, null, 2)}
`, "utf8");
}

/** Case-insensitive on Windows, exact elsewhere. */
const sameRepo = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

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

export function stripBlock(text) {
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

/**
 * Does a `hooks` key already exist OUTSIDE the blocks we manage?
 *
 * BOTH blocks are stripped first. zevet's own trust records are written as
 * `[hooks.state.'<key>']`, which the foreign test below matches on sight -- so
 * with only the hooks block stripped, a second install would find zevet's own
 * trust block, call it somebody else's hook config and refuse. It did.
 */
function hasForeignHooks(text) {
  const { text: noHooks } = stripBlock(text);
  const { text: without } = stripTrustBlock(noHooks);
  return /^\s*\[hooks[\].]/m.test(without) || /^\s*hooks\s*\./m.test(without) || /^\s*hooks\s*=/m.test(without);
}

/**
 * @returns {{ok: boolean, detail: string, trusted?: boolean, globalConfig?: string}}
 */
/**
 * Record trust for the hooks we just wrote, so they actually run.
 *
 * Separate from installCodex and called after it on purpose: it needs Codex to
 * read the config that installCodex has only just written, and it spawns a
 * process, so it is async and it is allowed to fail without failing the
 * install. A hook that is installed but untrusted is inert, not broken -- the
 * caller prints what to do by hand.
 *
 * @returns {Promise<{ok: boolean, detail: string, granted?: number}>}
 */
export async function grantCodexHookTrust(codexBin, repo, mark) {
  // Asking Codex costs a process spawn of a very large binary. The suite runs
  // the installer many times over and does not need the real answer each time;
  // the RPC has its own coverage, and the shape of what it writes is tested
  // directly against captured hooks/list output.
  if (process.env.ZEVET_SKIP_CODEX_TRUST === "1") {
    return { ok: false, detail: "skipped (ZEVET_SKIP_CODEX_TRUST=1)" };
  }
  if (!codexBin) return { ok: false, detail: "no codex binary to ask" };
  const listed = await listCodexHooks(codexBin, repo);
  if (!listed.ok) return { ok: false, detail: listed.detail };

  const mine = ourHooks(listed.hooks, mark);
  if (!mine.length) {
    return { ok: false, detail: "Codex reported no zevet hooks — the block may not have been read" };
  }

  const file = codexGlobalConfigPath();
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { ok: false, detail: `could not read ${file} (${err.message})` };
  }
  const stripped = stripTrustBlock(text);
  if (stripped.malformed) {
    return { ok: false, detail: `${file} has a zevet trust block with no end marker — left untouched` };
  }
  let block;
  try {
    block = trustBlockFor(mine);
  } catch (err) {
    return { ok: false, detail: err.message };
  }
  const base = stripped.text.length && !stripped.text.endsWith("\n") ? `${stripped.text}\n` : stripped.text;
  try {
    writeFileSync(file, `${base}${base.length ? "\n" : ""}${block}`, "utf8");
  } catch (err) {
    return { ok: false, detail: `could not write ${file} (${err.message})` };
  }
  const already = mine.filter((h) => h.trustStatus === "trusted").length;
  return {
    ok: true,
    granted: mine.length,
    detail: `trusted ${mine.length} zevet hook${mine.length === 1 ? "" : "s"}${already ? ` (${already} already were)` : ""}`,
  };
}

export function installCodex(repo, { hookPath, node, mark, remove = false }) {
  const file = codexGlobalConfigPath();
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
    // The block is shared by every wired repo, so removing one repo removes its
    // entry from the opt-in list and leaves the block alone unless that was the
    // last one. Taking the block out while another repo still expects it is how
    // an uninstall of repo A silently unwires repo B.
    const left = readCodexRepos().filter((d) => !sameRepo(d, path.resolve(repo)));
    writeCodexRepos(left);
    if (left.length) {
      writeFileSync(file, existing, "utf8");
      return {
        ok: true,
        detail: `${path.resolve(repo)} is no longer watched; ${left.length} repo${left.length === 1 ? "" : "s"} still wired, so the hooks block in ${file} stays`,
      };
    }
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
    // No --zevet-repo: the hooks block is global now, so a repo baked into the
    // command would label every project on the machine with the first one that
    // was wired. MEASURED: the Codex payload carries a real `cwd`, and hook.mjs
    // already prefers it, so the repo comes from the event itself.
    //
    // The command string is NOT passed to a shell, and Codex resolves the
    // program from the FIRST whitespace-delimited token WITHOUT honouring
    // quotes around it. MEASURED, all four on codex 0.155.0-alpha.2.6:
    //
    //   node C:/x/hook.mjs                            -> Completed
    //   node "C:/dir with space/hook.mjs"             -> Completed  (args quote fine)
    //   "C:/Program Files/nodejs/node.exe" C:/x.mjs   -> FAILED     (so does '...')
    //   cmd /c "C:/Program Files/nodejs/node.exe" ... -> Completed
    //
    // So a program path containing a space cannot be written directly, and
    // Windows puts node under "Program Files" by default. `cmd` has no space
    // and is always present, and it re-parses the rest with normal Windows
    // quoting rules. On macOS and Linux node lives somewhere unspaced
    // (/usr/local/bin, /opt/homebrew/bin) and needs no wrapper.
    const inner = `"${node}" "${hookPath}" ${mark} --zevet-agent codex`;
    const line = process.platform === "win32" ? `cmd /c ${inner}` : `${node} "${hookPath}" ${mark} --zevet-agent codex`;
    if (process.platform !== "win32" && /\s/.test(node)) {
      return {
        ok: false,
        detail: `the node binary path contains a space (${node}), which Codex cannot run as a hook program on this platform`,
      };
    }
    command = `${tomlLiteral(line)}`;
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

  // Opt this repo in. The block is global; this list is what keeps the hook
  // quiet about every other project on the machine.
  const here = path.resolve(repo);
  const repos = readCodexRepos();
  if (!repos.some((d) => sameRepo(d, here))) repos.push(here);
  writeCodexRepos(repos);

  const trust = isTrusted(repo);
  // Codex writes its own trust keys lowercased with backslashes; hand back a
  // string in that spelling so a copy-paste matches what it would have written.
  const trustKey = path.resolve(repo).split(path.sep).join(path.win32.sep).toLowerCase();
  return { ok: true, detail: file, trusted: trust.trusted, globalConfig: trust.globalConfig, trustKey };
}
