#!/usr/bin/env node
/**
 * The model lists for claude and codex, taken from the CLIs' own catalogues.
 *
 * ⚠️ WHY THIS EXISTS. zevet's model picker held a hand-written list, and every
 * entry in it had gone stale:
 *
 *     claude: "opus", "sonnet", "haiku"          — no Fable at all
 *     codex:  "gpt-5", "gpt-5-codex", "o3"       — none of these exist any more
 *
 * Andrew, looking at the picker: "the available model names are wrong... it
 * should specify Fable 5.1, opus 5 (1M), etc. all of that stuff should be named
 * just as claude, codex, and opencode name their models".
 *
 * Both CLIs already keep a machine-readable catalogue on disk, with the display
 * names their own pickers show. Nothing here is typed by hand or remembered:
 *
 *   claude  ~/.claude/cache/model-catalog/*.json
 *           -> catalog.config.models[] of { id, name, short_name, description,
 *              section }. The surface matters: "cc" is Claude Code's own list;
 *              "ccd" is the desktop app's and carries an `overflow` section of
 *              older models. zevet drives the CLI, so "cc" wins when present.
 *
 *   codex   ~/.codex/models_cache.json
 *           -> models[] of { id, display_name, description }.
 *
 * opencode is NOT here: it answers `opencode models` over the network and its
 * free tier churns weekly, so it has its own generator (sync-models.mjs) with
 * its own allowlist rules. This one reads two local files and invents nothing.
 *
 *     node scripts/sync-agent-models.mjs             # write the file
 *     node scripts/sync-agent-models.mjs --dry-run   # print what it would write
 *
 * A machine without one of those caches keeps whatever is already committed for
 * that agent, and says so. That is deliberate: this runs on a developer's
 * machine and the committed file is what ships, so a missing cache must never
 * silently empty a picker.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "src", "lib", "agent-models.generated.mjs");
const HOME = os.homedir();
const dry = process.argv.includes("--dry-run");

/** claude's own catalogue, preferring the Claude Code surface. */
function claudeModels() {
  const dir = path.join(HOME, ".claude", "cache", "model-catalog");
  if (!existsSync(dir)) return null;
  let best = null;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    } catch {
      continue; // a half-written cache is not an error, just not usable
    }
    const catalog = parsed?.catalog;
    const models = catalog?.config?.models;
    if (!Array.isArray(models) || !models.length) continue;
    // "cc" is Claude Code itself. Anything else is a fallback.
    if (catalog.surface === "cc") best = models;
    else if (!best) best = models;
  }
  if (!best) return null;
  return best
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
function codexModels() {
  const file = path.join(HOME, ".codex", "models_cache.json");
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const models = parsed?.models;
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

/** What is already committed, so a missing cache changes nothing. */
async function committed() {
  if (!existsSync(OUT)) return { CLAUDE_MODELS: [], CODEX_MODELS: [] };
  try {
    return await import(`${OUT.replace(/\\/g, "/")}?t=${Date.now()}`);
  } catch {
    return { CLAUDE_MODELS: [], CODEX_MODELS: [] };
  }
}

const prior = await committed();
const claude = claudeModels();
const codex = codexModels();

if (!claude) console.error("  ! no claude catalogue on this machine — keeping the committed list");
if (!codex) console.error("  ! no codex catalogue on this machine — keeping the committed list");

const finalClaude = claude ?? [...(prior.CLAUDE_MODELS ?? [])];
const finalCodex = codex ?? [...(prior.CODEX_MODELS ?? [])];

const lines = (list) =>
  list
    .map((m) => `  { id: ${JSON.stringify(m.id)}, name: ${JSON.stringify(m.name)}, note: ${JSON.stringify(m.note)} },`)
    .join("\n");

const today = new Date().toISOString().slice(0, 10);
const body = `// GENERATED by board/scripts/sync-agent-models.mjs — do not edit by hand.
// Re-run \`node scripts/sync-agent-models.mjs\` from board/ to refresh.
//
// The names are the CLIs' OWN, read from the catalogues they cache on disk:
// ~/.claude/cache/model-catalog/*.json and ~/.codex/models_cache.json. The
// hand-written list this replaced had gone entirely stale — it offered claude
// "opus/sonnet/haiku" with no Fable, and codex "gpt-5/gpt-5-codex/o3", none of
// which exist any more.
//
// Generated ${today} — ${finalClaude.length} claude, ${finalCodex.length} codex.

/** Models \`claude --model\` accepts, with the names Claude Code shows. */
export const CLAUDE_MODELS = [
${lines(finalClaude)}
];

/** Models \`codex -m\` accepts, with the names codex shows. */
export const CODEX_MODELS = [
${lines(finalCodex)}
];
`;

if (dry) {
  console.log(body);
} else {
  writeFileSync(OUT, body, "utf8");
  console.log(`wrote ${path.relative(path.join(HERE, ".."), OUT)}`);
  console.log(`  claude ${finalClaude.length}: ${finalClaude.map((m) => m.name).join(", ")}`);
  console.log(`  codex  ${finalCodex.length}: ${finalCodex.map((m) => m.name).join(", ")}`);
}
