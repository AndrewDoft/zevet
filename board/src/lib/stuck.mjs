/**
 * Is a running agent going round in circles?
 *
 * The idea, not the code, of OpenHands' stuck detector (MIT,
 * conversation/stuck_detector.py), over the `messages` that transcript.mjs
 * builds. Pure and bounded: it reads only the tail of the current turn run
 * (everything after the last user prompt), so a badge can be recomputed on
 * every streamed event.
 *
 * Patterns, in the order they are reported:
 *   repeat     the same call, with the same result, REPEAT_SAME times running
 *   error-loop the same call failing ERROR_LOOP times running
 *   ping-pong  A,B,A,B... with the same results, PING_PONG calls long
 *   monologue  the same words said MONOLOGUE times with no tool call between
 */

export const REPEAT_SAME = 4;
export const ERROR_LOOP = 3;
export const PING_PONG = 6;
export const MONOLOGUE = 3;

/** How much of the tail is read; enough for every pattern above. */
const TAIL = Math.max(REPEAT_SAME, ERROR_LOOP, PING_PONG, MONOLOGUE);
/** A result is compared by its first characters; a huge one is not copied. */
const RESULT_CAP = 400;

const norm = (s) => String(s).replace(/\s+/g, " ").trim();

function resultKey(result) {
  const s = typeof result === "string" ? result : JSON.stringify(result);
  return norm(s ?? "").slice(0, RESULT_CAP);
}

/** The last TAIL events of the current run, oldest first: calls and texts. */
function tailEvents(messages) {
  const out = [];
  for (let i = messages.length - 1; i >= 0 && out.length < TAIL; i -= 1) {
    const m = messages[i];
    if (!m || m.role === "user") break;
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content || [];
    for (let j = parts.length - 1; j >= 0 && out.length < TAIL; j -= 1) {
      const p = parts[j];
      if (p.type === "tool-call") {
        const done = p.result !== undefined;
        out.push({
          kind: "call",
          call: `${p.toolName}\u0000${p.argsText ?? JSON.stringify(p.args ?? {})}`,
          done,
          result: done ? resultKey(p.result) : "",
          isError: Boolean(p.isError),
        });
      } else if (p.type === "text" && p.text && norm(p.text)) {
        out.push({ kind: "text", text: norm(p.text) });
      }
    }
  }
  return out.reverse();
}

const lastN = (events, n) => (events.length >= n ? events.slice(-n) : null);

/**
 * @param {Array<{ role?: string, content?: unknown }>} messages
 * @returns {{ pattern: "repeat" | "error-loop" | "ping-pong" | "monologue", detail: string } | null}
 */
export function detectStuck(messages) {
  const events = tailEvents(Array.isArray(messages) ? messages : []);

  const run = lastN(events, REPEAT_SAME);
  if (run && run.every((e) => e.kind === "call" && e.done && e.call === run[0].call && e.result === run[0].result)) {
    return { pattern: "repeat", detail: `same call and result ${REPEAT_SAME} times` };
  }

  const fails = lastN(events, ERROR_LOOP);
  if (fails && fails.every((e) => e.kind === "call" && e.isError && e.call === fails[0].call)) {
    return { pattern: "error-loop", detail: `same call failed ${ERROR_LOOP} times` };
  }

  const pp = lastN(events, PING_PONG);
  if (
    pp &&
    pp.every((e) => e.kind === "call" && e.done) &&
    pp[0].call !== pp[1].call &&
    pp.every((e, i) => e.call === pp[i % 2].call && e.result === pp[i % 2].result)
  ) {
    return { pattern: "ping-pong", detail: `alternating between two calls ${PING_PONG} times` };
  }

  const said = lastN(events, MONOLOGUE);
  if (said && said.every((e) => e.kind === "text" && e.text === said[0].text)) {
    return { pattern: "monologue", detail: `same message ${MONOLOGUE} times, no tool use` };
  }
  return null;
}
