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
 * "Opus 5" and "GPT-5.6-Sol". opencode has no such catalogue, so its ids still
 * fall through to the string work below.
 */
import { CLAUDE_MODELS, CODEX_MODELS } from "./agent-models.generated.mjs";

/** id -> what that CLI's own picker calls it. */
const CATALOGUE = new Map(
  [...CLAUDE_MODELS, ...CODEX_MODELS].map((m) => [m.id, m]),
);

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
 * How to show a model alias: what it is, where it comes from, and whether
 * using it feeds a training set.
 *
 * @param {string} alias
 * @returns {{ label: string, from: string, note: string, trains: boolean }}
 */
export function describeModel(alias) {
  /* "" is not "no model" — it is the real, and usual, choice of letting the
     CLI pick. It said "default", which reads as a placeholder for something
     missing. Andrew: "you can retitle whatever the cli picks to just 'CLI
     Choice' across the board". */
  if (!alias) return { label: "CLI Choice", from: "", note: "", trains: false };
  const known = CATALOGUE.get(alias);
  if (known) return { label: known.name, from: "", note: known.note, trains: false };
  const parts = alias.split("/");
  const tail = parts[parts.length - 1]
    .replace(/(:free|-free)$/, "")
    .replace(/-contributor$/, "");
  return {
    label: tail || alias,
    from: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
    note: "",
    // The contributor builds are free because the prompt may be used for
    // training. Someone pointing one at their own repo should be told.
    trains: /-contributor(-|$)/.test(alias),
  };
}
