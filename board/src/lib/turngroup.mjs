/**
 * One tool-call dropdown per turn, instead of ten.
 *
 * THE MEASUREMENT THAT PROMPTED THIS. assistant-ui already collapses tool
 * calls: `MessagePrimitive.GroupedParts` coalesces ADJACENT parts that share a
 * group path, and the group is closed by default. But adjacency is exactly
 * what an agent breaks — it says a sentence, calls three tools, says another
 * sentence, calls eight more. Run against a real session on this machine
 * (2026-09-21, 6,053 records): 2,342 tool calls in 32 assistant turns formed
 * **341 separate groups**, 10.7 per turn. Every one of those is a collapsed
 * row taking vertical space, so a turn that should read as a paragraph and a
 * dropdown reads as a paragraph and eleven dropdowns.
 *
 * Andrew: "the tool call history should be available by dropdown, so that we
 * can have more agents viewed." 341 rows is not that.
 *
 * WHAT THIS DOES, and the trade it makes. Within one assistant message, every
 * tool-call part is moved after the prose. They are then contiguous, so
 * assistant-ui makes them ONE group — "23 tool calls", closed — and the turn
 * is a paragraph plus a row. The order of the calls among themselves is
 * untouched; what is given up is their interleaving with the sentences around
 * them. That is a real loss, and it is the price of the ask: a turn cannot be
 * both a strict transcript and one line tall.
 *
 * WHY IT IS A VIEW TRANSFORM AND NOT A CHANGE TO transcript.mjs. The stored
 * transcript stays in true order, because other things read it and mean it:
 * the turn detail panel, the trace waterfall, the thread map, and anything
 * that reasons about what happened when. This runs only where messages are
 * handed to the runtime for rendering.
 *
 * IDENTITY IS PRESERVED ON PURPOSE. A message that needs no change is returned
 * BY REFERENCE, and when no message changes the original array comes back
 * unchanged — assistant-ui memoises per message by reference, and a transform
 * that allocated a new object every render would re-mount every dropdown and
 * throw away which ones you had opened.
 *
 * WHY .mjs: the gate runs `node --test` straight against the source tree and
 * cannot import TypeScript.
 */

/**
 * @param {readonly any[]} messages
 * @param {{ min?: number }} [opts] `min` is the fewest tool calls in a turn
 *   worth rearranging. Below it there is no dropdown to win and reordering
 *   would cost the interleaving for nothing.
 */
/* ⚠️ THE REARRANGED MESSAGE HAS TO KEEP ITS IDENTITY. assistant-ui memoises
   a message by reference, and `{...m, content}` mints a fresh object on every
   call — so a turn that needed rearranging re-rendered on every store update,
   which for a chatty run is every few milliseconds. Returning `m` itself
   already covers the turns that need no change; this covers the rest.

   WeakMap, keyed on the INPUT message: the store replaces a message object
   whenever it changes, so a changed turn is a new key and is recomputed, and
   nothing here keeps a message alive. */
const rearranged = new WeakMap();

export function groupTurnTools(messages, opts = {}) {
  const min = Number.isFinite(opts.min) ? Number(opts.min) : 2;
  if (!Array.isArray(messages) || !messages.length) return messages;

  let changed = false;
  const out = messages.map((m) => {
    if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return m;

    const tools = [];
    const rest = [];
    for (const part of m.content) {
      if (part && part.type === "tool-call") tools.push(part);
      else rest.push(part);
    }
    if (tools.length < min) return m;

    // Already prose-then-tools: the first tool call is exactly where the
    // non-tool parts end, so they are contiguous and trailing and there is
    // nothing to do. Returning `m` itself keeps the reference stable.
    const firstTool = m.content.findIndex((p) => p && p.type === "tool-call");
    if (firstTool === rest.length) return m;

    changed = true;
    const seen = rearranged.get(m);
    if (seen) return seen;
    const next = { ...m, content: rest.concat(tools) };
    rearranged.set(m, next);
    return next;
  });

  return changed ? out : messages;
}

/**
 * How many tool calls a turn made, for anything that wants to say so without
 * reaching into message parts itself.
 *
 * @param {any} message
 */
export function turnToolCount(message) {
  if (!message || !Array.isArray(message.content)) return 0;
  let n = 0;
  for (const part of message.content) if (part && part.type === "tool-call") n += 1;
  return n;
}
