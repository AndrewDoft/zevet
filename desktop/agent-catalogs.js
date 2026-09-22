// The model lists claude and codex keep on disk, read the same way at build
// time (board/scripts/sync-agent-models.mjs writes them into the bundle) and at
// run time (main.js `local:agents` hands them to the board). One reader, so a
// model the CLI learns about shows up without a zevet release, and the shipped
// list is the fallback for a board with no bridge or a machine with no cache.
//
//   claude  ~/.claude/cache/model-catalog/*.json
//           -> catalog.config.models[] of { id, name, description, section }.
//              Several files coexist: "cc" is Claude Code's own list, "ccd"
//              the desktop app's, and each is refreshed on its own clock. The
//              NEWEST "cc" wins — an older one was read first and Opus 5.5,
//              present only in the fresh file, never reached the picker.
//
//   codex   ~/.codex/models_cache.json
//           -> models[] of { slug, display_name, description, visibility }.
//
// Returns null, never [], when a cache is missing or unreadable: "nothing
// known" must stay distinguishable from "known to be empty", or a missing
// cache silently empties a picker.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null; // a half-written cache is not an error, just not usable
  }
}

/** claude's own catalogue: the newest file of the Claude Code surface. */
function claudeModels(home = os.homedir()) {
  const dir = path.join(home, ".claude", "cache", "model-catalog");
  if (!fs.existsSync(dir)) return null;
  let best = null;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const full = path.join(dir, file);
    const parsed = readJson(full);
    const catalog = parsed?.catalog;
    const models = catalog?.config?.models;
    if (!Array.isArray(models) || !models.length) continue;
    // The catalogue stamps its own fetch time; mtime is the fallback for one
    // that does not.
    let at = Number(parsed.fetchedAt);
    if (!Number.isFinite(at)) {
      try {
        at = fs.statSync(full).mtimeMs;
      } catch {
        at = 0;
      }
    }
    const cc = catalog.surface === "cc";
    if (!best || (cc && !best.cc) || (cc === best.cc && at > best.at)) best = { models, cc, at };
  }
  if (!best) return null;
  return best.models
    // `overflow` is the older-models drawer. zevet's picker is a list of what
    // to start now, not an archive.
    .filter((m) => m && typeof m.id === "string" && m.section !== "overflow")
    .map((m) => ({
      id: m.id,
      name: typeof m.name === "string" && m.name ? m.name : m.id,
      note: typeof m.description === "string" ? m.description : "",
    }));
}

/** codex's own catalogue. */
function codexModels(home = os.homedir()) {
  const file = path.join(home, ".codex", "models_cache.json");
  if (!fs.existsSync(file)) return null;
  const models = readJson(file)?.models;
  if (!Array.isArray(models) || !models.length) return null;
  return (
    models
      /* ⚠️ CODEX KEYS ON `slug`, NOT `id`. This filtered on `m.id` first, and
         every record failed it — so the generator wrote an empty codex list,
         reported "codex 0:" and exited 0. A picker that silently offers
         nothing is the worst shape of this bug: nothing is wrong until you
         open it. Read a real record before trusting a field name. */
      .filter((m) => m && typeof m.slug === "string")
      // codex's own picker hides these; they are internal (the auto-review
      // model) or superseded, and starting one does nothing useful.
      .filter((m) => m.visibility !== "hide")
      .map((m) => ({
        id: m.slug,
        name: typeof m.display_name === "string" && m.display_name ? m.display_name : m.slug,
        note: typeof m.description === "string" ? m.description : "",
      }))
  );
}

module.exports = { claudeModels, codexModels };
