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

/** @returns {{ok: boolean, state: string, detail: string}} */
export function removeOpencode(repo) {
  return installOpencode(repo, { remove: true });
}
