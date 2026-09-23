/**
 * What a change in the composer means for the thread's saved draft.
 *
 * `prev` is the last { key, text } seen; `null` on mount. Returns "save",
 * "forget" or null (leave storage alone).
 *
 * ⚠️ ONLY A CHANGE MADE IN THIS THREAD COUNTS. The composer is one for the
 * whole window, so switching threads carries its text along; saving on the
 * switch filed thread A's words under thread B, and B then offered them back.
 * And a mount with an empty composer must not wipe the leftover draft it is
 * about to offer.
 *
 * Text going empty in the same thread is a send (or a clear): the draft is
 * gone. That is what keeps "unsent draft" off a prompt that was sent.
 *
 * WHY .mjs: the gate runs `node --test` straight against the source tree.
 */
export function draftChange(prev, key, text) {
  if (!key || !prev || prev.key !== key || prev.text === text) return null;
  return text ? "save" : "forget";
}
