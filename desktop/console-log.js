"use strict";

/**
 * What each console has already told the board, kept on THIS side of the bridge.
 *
 * A board reload is a new renderer, and everything the old one knew about the
 * running agents — the rail entry, the transcript — died with it, while the
 * processes themselves live on here as children of the main process. The fix
 * is re-attaching, not reaping: the new page asks for `snapshot()` and folds
 * every event through the same code that handled it live, so it arrives at
 * the same state the old page was in.
 *
 * No Electron in here, so node --test can load it.
 *
 * ⚠️ HEAD AND TAIL, NOT A RING. The oldest events are the ones that say who the
 * agent is — claude's init line with its slash commands and MCP servers,
 * codex's one `thread.started` that carries the only copy of its session id —
 * so a buffer that dropped strictly oldest-first would hand back a long run
 * that can no longer be resumed. The gap goes in the middle, with a marker.
 */

const EVENT_CAP = 2000;
const HEAD = 50;

/** entries.get(id)'s stored shape, projected to what a caller may read --
 *  shared by `snapshot()` and `get()` so the gap-marker splice happens once. */
function toPublic(e, head) {
  return {
    id: e.id,
    ...e.meta,
    running: e.running,
    state: e.running ? e.state : "exited",
    turns: e.turns,
    lastResult: e.lastResult,
    isError: e.isError,
    costUsd: e.costUsd,
    usage: e.usage,
    events: e.dropped
      ? [...e.events.slice(0, head), { type: "gap", id: e.id, dropped: e.dropped }, ...e.events.slice(head)]
      : e.events.slice(),
  };
}

// ponytail: capped by event count, not bytes; a run of huge tool results can
// still hold a lot. Add a byte budget if memory ever shows up.
/** claude's --replay-user-messages echoes each prompt back as a text-only
 *  `user` line; the console already stores its own `prompt` event for it, so
 *  the echo is a second copy. A `user` line carrying a tool_result is the
 *  tool's record and stays. */
function isPromptEcho(evt) {
  const p = evt.type === "agent" && evt.payload;
  if (!p || p.type !== "user" || !p.message) return false;
  const c = p.message.content;
  return typeof c === "string" || (Array.isArray(c) && !c.some((part) => part && part.type === "tool_result"));
}

/** `onceDone(id)` fires when the first turn's `result` arrives on a console
 *  marked `setOnce` -- fire-and-forget workers use it to end the process. */
function createConsoleLog({ cap = EVENT_CAP, head = HEAD, onceDone, now = Date.now } = {}) {
  const entries = new Map();
  let seq = 0;
  let lastAt = 0;

  return {
    /**
     * A console started. `continues` is the process a resumed console replaces:
     * the board keeps ONE thread across a follow-up while the process under it
     * is new, so the history moves to the new id rather than coming back as a
     * second thread.
     */
    open(id, meta, continues) {
      lastAt = now();
      const prev = continues ? entries.get(continues) : null;
      if (prev) entries.delete(continues);
      entries.set(id, {
        id,
        // The thread's start, not this process's: the board's does not move
        // on a follow-up either. Nor does its generated title.
        meta: prev ? { ...meta, startedAt: prev.meta.startedAt, ...(prev.meta.title ? { title: prev.meta.title } : {}) } : meta,
        running: true,
        // working = a prompt is out and its `result` has not come back; idle =
        // the process is up and waiting for the next one (claude stays alive
        // between turns, so `running` alone never says a turn is done).
        state: "idle",
        turns: prev ? prev.turns : 0,
        lastResult: prev ? prev.lastResult : "",
        isError: prev ? prev.isError : false,
        costUsd: prev ? prev.costUsd : null,
        usage: prev ? prev.usage : null,
        // Re-stamped with the new id: the board replays them against the
        // console that now answers to it, and drops what matches no console.
        events: prev ? prev.events.map((e) => ({ ...e, id })) : [],
        dropped: prev ? prev.dropped : 0,
      });
    },

    /** Stamp an event with its sequence number and keep it. Returns what the
     *  board is sent live, so a reloading page can tell which live events its
     *  snapshot already holds. */
    record(id, evt) {
      const out = { ...evt, id, seq: ++seq };
      lastAt = now();
      const e = entries.get(id);
      // Partial-message deltas (claude --include-partial-messages) are live-only:
      // hundreds per answer, and the complete block that follows is what a reload needs.
      const partial = evt.type === "agent" && evt.payload && evt.payload.type === "stream_event";
      if (e && !partial && !isPromptEcho(evt)) {
        e.events.push(out);
        if (evt.type === "exit") e.running = false;
        else if (evt.type === "prompt") e.state = "working";
        else if (evt.type === "agent" && evt.payload && evt.payload.type === "result") {
          const r = evt.payload;
          e.state = "idle";
          e.turns++;
          e.lastResult = typeof r.result === "string" ? r.result : "";
          e.isError = Boolean(r.is_error);
          if (typeof r.total_cost_usd === "number") e.costUsd = r.total_cost_usd;
          if (r.usage && typeof r.usage === "object") e.usage = r.usage;
          if (e.once && onceDone) onceDone(id);
        }
        if (e.events.length > cap) {
          e.events.splice(head, 1);
          e.dropped++;
        }
      }
      return out;
    },

    /** Mark a console fire-and-forget: `onceDone` fires after its first result. */
    setOnce(id) {
      const e = entries.get(id);
      if (e) e.once = true;
    },

    /** Whether the thread has been sent a prompt yet: the first one is what
     *  gets it a title (desktop/auto-title.js). */
    prompted(id) {
      const e = entries.get(id);
      return Boolean(e && e.events.some((evt) => evt.type === "prompt"));
    },

    /** A generated title, kept with the metadata so a reload shows it again.
     *  False when the console is gone. */
    setTitle(id, title) {
      const e = entries.get(id);
      if (!e) return false;
      e.meta = { ...e.meta, title };
      return true;
    },

    /** The board closed the thread. A finished console is otherwise kept, so a
     *  run that ended during a reload still comes back, as finished. */
    forget(id) {
      entries.delete(id);
    },

    snapshot() {
      return {
        seq,
        consoles: [...entries.values()].map((e) => toPublic(e, head)),
      };
    },

    /** One console, in the same shape `snapshot()` hands each entry -- for a
     *  caller that wants a single console rather than every one of them (the
     *  control API's status/output/wait, desktop/agent-api.js). Undefined
     *  when there is no such console. */
    get(id) {
      const e = entries.get(id);
      return e ? toPublic(e, head) : undefined;
    },

    /** For the payload swap gate (payload-swap.js): how many consoles have a live
     *  process, and when any console last opened or spoke (0 = never). */
    activity() {
      return { running: [...entries.values()].filter((e) => e.running).length, lastAt };
    },

    clear() {
      entries.clear();
    },
  };
}

module.exports = { createConsoleLog, EVENT_CAP };
