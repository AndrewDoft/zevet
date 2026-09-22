/**
 * Turning a model id into something a person can read.
 *
 * claude and codex take short aliases — "opus", "gpt-5" — that need no help.
 * opencode takes a provider-qualified id, and those are long enough to truncate
 * mid-name in the picker: `openrouter/thinkingmachines/inkling:free` and
 * `openrouter/thinkingmachines/inkling-small:free` both render as
 * `openrouter/thinkingmachines/in…`, which is two different models the user
 * cannot tell apart. So the row shows the model and its provider separately.
 *
 * Pure string work, deliberately kept out of the component so the suite can
 * test it — same arrangement as roster.mjs and prose.mjs.
 *
 * ⚠️ THE NAMES ARE NOT INVENTED HERE. claude and codex publish their own
 * display names in the catalogues they cache on disk, and zevet reads them
 * (scripts/sync-agent-models.mjs). Deriving a name from the id instead is what
 * produced "claude-opus-5" and "gpt-5.6-sol" in a picker whose CLIs call those
 * "Opus 5" and "GPT-5.6-Sol". opencode has no such catalogue, so
 * scripts/sync-models.mjs takes OpenRouter's names for its ids; only an id
 * neither knows falls through to the string work below.
 */
import { CLAUDE_MODELS, CODEX_MODELS } from "./agent-models.generated.mjs";
import { OPENCODE_MODEL_NAMES } from "./models.generated.mjs";

/** id -> what that CLI's own picker calls it. */
const CATALOGUE = new Map(
  [...CLAUDE_MODELS, ...CODEX_MODELS].map((m) => [m.id, m]),
);

/**
 * Names for models the desktop app read from the CLIs' caches just now
 * (desktop/main.js `local:agents`). Newer than the generated file, so they
 * win; nothing is forgotten, because a running console may still be on a
 * model the CLI has since dropped.
 *
 * @param {Array<{ id: string, name: string, note: string }>} list
 */
export function learnModels(list) {
  for (const m of list) if (m && typeof m.id === "string") CATALOGUE.set(m.id, m);
}

/**
 * The model string a picker row stands for, recovered from its `<family>:<alias>` id.
 *
 * Splits on the FIRST colon only: an alias may contain colons of its own, as
 * every OpenRouter `:free` id does.
 *
 * @param {string} id
 * @returns {string}
 */
export function aliasOf(id) {
  const cut = id.indexOf(":");
  return cut === -1 ? "" : id.slice(cut + 1);
}

/**
 * The name of the model a console is on: the one it reports, else the one it
 * was started with. "" when neither is known (a resumed console passes no flag).
 *
 * @param {string | null | undefined} reported  usage.model
 * @param {string | null | undefined} started   the console's own model
 * @returns {string}
 */
export function runningModelName(reported, started) {
  const raw = reported || started || "";
  return describeModel(raw).label || raw;
}

/**
 * How to show a model alias: what it is, where it comes from, and whether
 * using it feeds a training set.
 *
 * @param {string} alias
 * @returns {{ label: string, from: string, note: string, trains: boolean }}
 */
export function describeModel(alias) {
  /* "" is no longer a pickable row (constants.ts dropped it from MODELS), but
     it still reaches here: a resumed console legitimately carries no model
     (desktop/main.js), and this function has to stay total for that case
     rather than throw. Empty everything, deliberately — no invented label
     like "CLI Choice" for a thing nobody chose. Callers fall back to
     whatever they already fall back to (e.g. the raw id). */
  if (!alias) return { label: "", from: "", note: "", trains: false };
  const known = CATALOGUE.get(alias);
  if (known) return { label: known.name, from: "", note: known.note, trains: false };
  const parts = alias.split("/");
  const tail = parts[parts.length - 1]
    .replace(/(:free|-free)$/, "")
    .replace(/-contributor$/, "");
  return {
    label: OPENCODE_MODEL_NAMES[alias] || tail || alias,
    from: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
    note: "",
    // The contributor builds are free because the prompt may be used for
    // training. Someone pointing one at their own repo should be told.
    trains: /-contributor(-|$)/.test(alias),
  };
}
