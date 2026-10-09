/* The thread renders every message it is given, and assistant-ui reconciles
 * every message's client resources on every update: measured 25 s of CPU to
 * stream 60 events into a 300-turn thread (4x throttle), 0.1 s at 20 turns.
 * So the thread is handed the tail only; the rest is one click away. */
export const WINDOW = 80;

/** The last `WINDOW + more` messages, and how many are held back. The array
 *  comes back as-is while it fits, so identity (and memoisation) is kept. */
export function tail(messages, more = 0) {
  const keep = WINDOW + Math.max(0, more);
  if (messages.length <= keep) return { shown: messages, hidden: 0 };
  return { shown: messages.slice(-keep), hidden: messages.length - keep };
}

/** How much wider than WINDOW `key`'s thread is drawn; a different thread starts narrow. */
export const moreFor = (state, key) => (state.key === key ? state.n : 0);

/** One more window for `key`. */
export const widen = (state, key) => ({ key, n: moreFor(state, key) + WINDOW });
