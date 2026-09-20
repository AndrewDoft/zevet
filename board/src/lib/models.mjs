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
 */

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
 * @returns {{ label: string, from: string, trains: boolean }}
 */
export function describeModel(alias) {
  if (!alias) return { label: "default", from: "", trains: false };
  const parts = alias.split("/");
  const tail = parts[parts.length - 1]
    .replace(/(:free|-free)$/, "")
    .replace(/-contributor$/, "");
  return {
    label: tail || alias,
    from: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
    // The contributor builds are free because the prompt may be used for
    // training. Someone pointing one at their own repo should be told.
    trains: /-contributor(-|$)/.test(alias),
  };
}
