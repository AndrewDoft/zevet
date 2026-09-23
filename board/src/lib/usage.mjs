/**
 * Usage parsing shared between Code consoles and Chat threads.
 *
 * .mjs so the gate can test it straight off the source tree.
 */

export const CONTEXT_FLOOR = 200_000;

/**
 * What a single usage payload yields. This is the shape both
 * ConsoleEntry.usage and ChatThread.usage store.
 * @typedef {Object} UsageReading
 * @property {number} context
 * @property {number|null} cacheHit
 * @property {string|null} model
 * @property {number} input
 * @property {number} cachedInput
 * @property {number} output
 */

/**
 * Parse a usage payload from any agent CLI into a UsageReading.
 * Returns null when the payload carries no usage information.
 *
 * claude: payload.message.usage (per-message) or payload.usage (result)
 * codex:  payload.usage (turn.completed) or payload.part.tokens
 * opencode: payload.part.tokens
 */
export function usageOf(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.type === "result" || payload.type === "turn.completed") return null;
  const u = ((payload.message && payload.message.usage) || payload.usage);
  const tokens = payload.part && payload.part.tokens;
  if ((!u || typeof u !== "object") && tokens && typeof tokens === "object") {
    const ti = tokens;
    const n2 = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
    const cx = n2(ti.input);
    if (!cx && !n2(ti.output)) return null;
    return { context: cx, cacheHit: cx > 0 ? 0 : null, model: null, input: cx, cachedInput: 0, output: n2(ti.output) };
  }
  if (!u || typeof u !== "object") return null;
  const n = (v) => (typeof v === "number" && isFinite(v) ? v : 0);

  const codexStyle = u.cached_input_tokens !== undefined;
  const read = codexStyle ? n(u.cached_input_tokens) : n(u.cache_read_input_tokens);
  const written = codexStyle ? n(u.cache_write_input_tokens) : n(u.cache_creation_input_tokens);
  const context = codexStyle ? n(u.input_tokens) + written : n(u.input_tokens) + read + written;
  if (!context && !n(u.output_tokens)) return null;
  return {
    context,
    cacheHit: context > 0 ? (read / context) * 100 : null,
    model: (payload.message && payload.message.model) || payload.model || null,
    input: Math.max(0, context - read),
    cachedInput: read,
    output: n(u.output_tokens),
  };
}

/**
 * 0..1 share of context used. Clamped because the floor is a guess.
 */
export function contextShare(used, window) {
  const w = window && window > 0 ? window : CONTEXT_FLOOR;
  if (!used || used < 0) return 0;
  return Math.min(1, used / w);
}