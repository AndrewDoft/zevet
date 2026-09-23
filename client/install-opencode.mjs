// Wires zevet's opencode plugin into one repo.
//
// opencode loads JS plugins from `<repo>/.opencode/plugins/` automatically at
// startup — no config merge, no trust ceremony. So installing is copying one
// self-contained file (client/opencode-plugin.mjs, which imports node builtins
// only), and removing is deleting it. The per-repo file IS the opt-in, the way
// Claude Code's per-repo settings.json entry is: unlike Codex's global hooks
// block, nothing installed here can report on any other project.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, "opencode-plugin.mjs");

/** How we recognise our own plugin file. Mirrors install.mjs's MARK discipline. */
export const PLUGIN_MARK = "zevet-opencode-plugin v1";

/**
 * Where opencode looks for project plugins. Auto-loaded; nothing to register.
 *
 * `.js`, not `.mjs`: MEASURED 2026-09-19 against opencode 1.18.31, a `.mjs`
 * file in this directory is silently never loaded — not evaluated, not called,
 * no error anywhere. The docs say "JavaScript or TypeScript files" and the
 * loader means exactly the extensions it knows.
 */
export function opencodePluginPathFor(repo) {
  return path.join(repo, ".opencode", "plugins", "zevet.js");
}

/** The pre-0.2.5 name, from before the `.mjs` measurement. Removed wherever found. */
export function opencodeLegacyPathFor(repo) {
  return path.join(repo, ".opencode", "plugins", "zevet.mjs");
}

/**
 * opencode's GLOBAL plugin directory — loaded at startup the same way as a
 * repo's `.opencode/plugins/`, for every session on the machine regardless of
 * which repo (or no repo) it starts in. VERIFIED 2026-09-23 against
 * opencode's own docs (opencode.ai/docs/plugins: "Global plugins ...
 * ~/.config/opencode/plugins/") and confirmed on this machine — opencode
 * itself had already created an empty one at `~/.config/opencode/plugins/`.
 *
 * This is what makes a fresh worktree visible on the board without a
 * per-repo `zevet install` in it: opencode-plugin.mjs reads the repo it is
 * running against off `directory` at call time (see `repoInfo` there), not
 * off where the plugin FILE lives, so one copy here covers every repo.
 */
export function opencodeGlobalPluginPath(home = os.homedir()) {
  return path.join(home, ".config", "opencode", "plugins", "zevet.js");
}

/**
 * The repos this machine opted in to reporting opencode activity for.
 *
 * A GLOBAL plugin needs this the same way D-001 made Codex's global hooks
 * need `codex-repos.json`: without an allowlist, wiring up one repo would
 * report every `opencode run` on the machine — including unrelated private
 * work nobody asked zevet to watch — to a hub the whole team can read. Its
 * own file, not a share of codex's: a repo wired only for opencode has
 * nothing to do with Codex's list, and vice versa.
 *
 * The plugin itself (opencode-plugin.mjs) cannot import this — it is
 * self-contained by design, copied to run with no access to the checkout —
 * so it carries an inline copy of the read side, the same way it already
 * copies secret.mjs's derivation. If this shape changes, that copy changes
 * with it.
 */
export function opencodeReposPath() {
  return path.join(process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet"), "opencode-repos.json");
}

/** Read the opt-in list; a missing or corrupt file is an empty list, never a throw. */
export function readOpencodeRepos() {
  try {
    const raw = readFileSync(opencodeReposPath(), "utf8").replace(/^﻿/, "");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((d) => typeof d === "string" && d.trim()) : [];
  } catch {
    return [];
  }
}

function writeOpencodeRepos(list) {
  const file = opencodeReposPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`, "utf8");
}

/** Case-insensitive on Windows, exact elsewhere — matches hook.mjs's own repo comparison. */
function sameRepoPath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Called by install.mjs when it wires opencode for `repo`. */
export function addOpencodeRepo(repo) {
  const here = path.resolve(repo);
  const repos = readOpencodeRepos();
  if (!repos.some((d) => sameRepoPath(path.resolve(d), here))) repos.push(here);
  writeOpencodeRepos(repos);
}

/** Called by install.mjs --remove. Leaves other repos' opt-in untouched. */
export function removeOpencodeRepo(repo) {
  const here = path.resolve(repo);
  writeOpencodeRepos(readOpencodeRepos().filter((d) => !sameRepoPath(path.resolve(d), here)));
}

function backup(file) {
  copyFileSync(file, `${file}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`);
}

/**
 * Is an OpenRouter key available to opencode on this machine?
 *
 * Presence only — never a value, never a prefix. opencode reads the same key
 * from either place: `~/.local/share/opencode/auth.json` (written by
 * `/connect` -> OpenRouter, as `{ "openrouter": { "type": "api", "key": ... } }`)
 * or the OPENROUTER_API_KEY environment variable. `:free` models cost nothing
 * either way; the key is what lifts the free-tier daily request cap.
 *
 * @param {string} [home] overridable for tests; defaults to the real home dir.
 * @returns {{ready: boolean, via: string|null}}
 */
export function openrouterReady(home = os.homedir()) {
  if (process.env.OPENROUTER_API_KEY) return { ready: true, via: "OPENROUTER_API_KEY" };
  const candidates = [
    path.join(home, ".local", "share", "opencode", "auth.json"),
    path.join(home, ".config", "opencode", "auth.json"),
  ];
  for (const f of candidates) {
    try {
      // Strip a BOM: PowerShell 5.1 writes one, JSON.parse rejects it, and a
      // key that parses nowhere is reported missing everywhere. See hook.mjs.
      const parsed = JSON.parse(readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
      if (parsed && parsed.openrouter && typeof parsed.openrouter.key === "string" && parsed.openrouter.key) {
        return { ready: true, via: f };
      }
    } catch {
      // Absent or unreadable: not evidence either way. Keep looking.
    }
  }
  return { ready: false, via: null };
}

/**
 * Write (or remove) zevet's plugin template at one exact path. The shared
 * half of installOpencode/installOpencodeGlobal — everything below this line
 * is generic; the per-repo legacy-`.mjs` cleanup above it is not, because
 * that legacy name was only ever written per-repo.
 *
 * @returns {{ok: boolean, state: "removed"|"clean"|"absent"|"failed", detail: string}}
 */
function writePluginAt(file, { remove = false } = {}) {
  if (remove) {
    if (!existsSync(file)) return { ok: true, state: "absent", detail: "no opencode plugin file" };
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      return { ok: false, state: "failed", detail: `could not read ${file} (${err.message}) — left untouched` };
    }
    // Rule borrowed from uninstall.mjs: never delete somebody else's config.
    // A zevet.js we did not write is theirs and it stays.
    if (!text.includes(PLUGIN_MARK)) {
      return { ok: true, state: "clean", detail: `no zevet plugin in ${file} — left untouched` };
    }
    try {
      backup(file);
      rmSync(file);
    } catch (err) {
      return { ok: false, state: "failed", detail: `could not remove ${file} (${err.message})` };
    }
    return { ok: true, state: "removed", detail: `removed zevet's plugin from ${file}` };
  }

  let template;
  try {
    template = readFileSync(TEMPLATE, "utf8");
  } catch (err) {
    return { ok: false, state: "failed", detail: `zevet's plugin template is missing (${TEMPLATE}: ${err.message})` };
  }
  if (!template.includes(PLUGIN_MARK)) {
    return { ok: false, state: "failed", detail: `zevet's plugin template carries no mark — refusing to install from it` };
  }

  if (existsSync(file)) {
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch (err) {
      return { ok: false, state: "failed", detail: `could not read ${file} (${err.message}) — left untouched` };
    }
    if (!current.includes(PLUGIN_MARK)) {
      return {
        ok: false,
        state: "failed",
        detail:
          `${file} exists and is not zevet's — refusing to overwrite it. ` +
          `Move it aside first if the plugin there is yours.`,
      };
    }
    if (current === template) return { ok: true, state: "clean", detail: `${file} already current` };
    backup(file);
  } else {
    mkdirSync(path.dirname(file), { recursive: true });
  }

  try {
    writeFileSync(file, template, "utf8");
  } catch (err) {
    return { ok: false, state: "failed", detail: `could not write ${file} (${err.message})` };
  }
  return { ok: true, state: "installed", detail: file };
}

/**
 * Every return carries both shapes: install.mjs reads `ok`, uninstall.mjs
 * reads `state` ("absent" is silently skipped there; "clean" is reported but
 * is not a removal). One function, two callers, no adapter.
 *
 * @returns {{ok: boolean, state: "removed"|"clean"|"absent"|"failed", detail: string}}
 */
export function installOpencode(repo, { remove = false } = {}) {
  const file = opencodePluginPathFor(repo);
  const legacy = opencodeLegacyPathFor(repo);

  // The `.mjs` name never loaded anywhere (see above). Take ours back out
  // wherever this meets one, install or remove — leaving it would look
  // installed while doing nothing, which is the worst state in this project.
  if (existsSync(legacy)) {
    try {
      if (readFileSync(legacy, "utf8").includes(PLUGIN_MARK)) {
        backup(legacy);
        rmSync(legacy);
      }
    } catch {
      // Unreadable is not ours to fix; the install below still proceeds.
    }
  }

  return writePluginAt(file, { remove });
}

/**
 * Same plugin, installed ONCE for the whole machine instead of per-repo — see
 * opencodeGlobalPluginPath's comment. `client/install.mjs` calls this instead
 * of leaving opencode coverage to whichever repos happened to get an explicit
 * per-repo install; a repo that already carried the old per-repo copy has it
 * removed in the same run (`installOpencode(repo, {remove:true})`), so it is
 * not double-reporting from both a local and a global copy at once. A repo
 * nobody has re-installed since is a known gap — see docs/KNOWN-FAILURES.md.
 *
 * @returns {{ok: boolean, state: "removed"|"clean"|"absent"|"failed", detail: string}}
 */
export function installOpencodeGlobal({ remove = false, home } = {}) {
  // ZEVET_OPENCODE_HOME is test-only: it lets install.mjs's own test suite
  // point this at a tempdir instead of the real machine's ~/.config, the same
  // isolation CODEX_HOME/ZEVET_HOME already give the codex and zevet halves
  // of the installer (test/client.test.mjs § SANDBOX). Production never sets it.
  const resolved = home || process.env.ZEVET_OPENCODE_HOME || os.homedir();
  return writePluginAt(opencodeGlobalPluginPath(resolved), { remove });
}

/** @returns {{ok: boolean, state: string, detail: string}} */
export function removeOpencode(repo) {
  return installOpencode(repo, { remove: true });
}
