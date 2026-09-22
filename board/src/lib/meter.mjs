/**
 * How full a run's context is, for the composer's ring.
 *
 * .mjs so the gate can test it straight off the source tree (see sessions.mjs).
 */

/** The window assumed until the agent reports its own — the smallest common
 *  one, so an unreported window undersells rather than oversells. */
export const CONTEXT_FLOOR = 200_000;

/**
 * 0..1. Clamped because the floor is a guess: a 1M-window model past 200k
 * reads full until its real window arrives, never "177%".
 *
 * @param {number | null | undefined} used
 * @param {number | null | undefined} window
 */
export function contextShare(used, window) {
  const w = window && window > 0 ? window : CONTEXT_FLOOR;
  if (!used || used < 0) return 0;
  return Math.min(1, used / w);
}
