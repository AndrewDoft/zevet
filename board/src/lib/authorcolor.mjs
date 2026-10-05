/** Change colour = author colour. The one place that turns "who made this
 *  change" into colour tokens; every diff line, +N/−N count and change badge
 *  spreads authorStyle() onto its element and uses the .d-add / .d-del /
 *  .d-add-bg / .d-del-bg classes (masora.css). No component does its own
 *  colour math. Plain JS so the tests run the file that ships.
 *
 *  An actor not in the roster gets {} — the classes then fall back to the
 *  generic success/alert green and red. */

/** Must equal HUES in constants.ts (a test pins it). */
export const HUES = 5;
/** Tint strengths over the paper; test/author-color.test.mjs proves AA at these. */
export const ADD_TINT = 8;
export const DEL_TINT = 5;

export function authorIndex(actor, roster) {
  if (!actor || !Array.isArray(roster)) return -1;
  const i = roster.findIndex((r) => r && r.actor === actor);
  return i < 0 ? -1 : i % HUES;
}

export function authorTokens(actor, roster) {
  const i = authorIndex(actor, roster);
  if (i < 0) return null;
  const add = `var(--who-${i})`;
  const del = `var(--who-${i}-del)`;
  return {
    add,
    del,
    addBg: `color-mix(in srgb, ${add} ${ADD_TINT}%, transparent)`,
    delBg: `color-mix(in srgb, ${del} ${DEL_TINT}%, transparent)`,
  };
}

/** Whoever touched a file most recently, from a tree node's {actor: ts} map. */
export function lastAuthor(who) {
  let best = null;
  for (const a of Object.keys(who || {})) if (best == null || who[a] > who[best]) best = a;
  return best;
}

export function authorStyle(actor, roster) {
  const t = authorTokens(actor, roster);
  return t
    ? { "--diff-add": t.add, "--diff-del": t.del, "--diff-add-bg": t.addBg, "--diff-del-bg": t.delBg }
    : {};
}
