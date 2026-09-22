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

// ponytail: capped by event count, not bytes; a run of huge tool results can
// still hold a lot. Add a byte budget if memory ever shows up.
function createConsoleLog({ cap = EVENT_CAP, head = HEAD } = {}) {
  const entries = new Map();
  let seq = 0;

  return {
    /**
     * A console started. `continues` is the process a resumed console replaces:
     * the board keeps ONE thread across a follow-up while the process under it
     * is new, so the history moves to the new id rather than coming back as a
     * second thread.
     */
    open(id, meta, continues) {
      const prev = continues ? entries.get(continues) : null;
      if (prev) entries.delete(continues);
      entries.set(id, {
        id,
        // The thread's start, not this process's: the board's does not move
        // on a follow-up either.
        meta: prev ? { ...meta, startedAt: prev.meta.startedAt } : meta,
        running: true,
        events: prev ? prev.events : [],
        dropped: prev ? prev.dropped : 0,
      });
    },

    /** Stamp an event with its sequence number and keep it. Returns what the
     *  board is sent live, so a reloading page can tell which live events its
     *  snapshot already holds. */
    record(id, evt) {
      const out = { ...evt, id, seq: ++seq };
      const e = entries.get(id);
      if (e) {
        e.events.push(out);
        if (evt.type === "exit") e.running = false;
        if (e.events.length > cap) {
          e.events.splice(head, 1);
          e.dropped++;
        }
      }
      return out;
    },

    /** The board closed the thread. A finished console is otherwise kept, so a
     *  run that ended during a reload still comes back, as finished. */
    forget(id) {
      entries.delete(id);
    },

    snapshot() {
      return {
        seq,
        consoles: [...entries.values()].map((e) => ({
          id: e.id,
          ...e.meta,
          running: e.running,
          events: e.dropped
            ? [...e.events.slice(0, head), { type: "gap", id: e.id, dropped: e.dropped }, ...e.events.slice(head)]
            : e.events.slice(),
        })),
      };
    },

    clear() {
      entries.clear();
    },
  };
}

module.exports = { createConsoleLog, EVENT_CAP };
