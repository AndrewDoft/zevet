/**
 * Native notifications for agents: which events deserve one, whether the
 * person asked for that kind, and how a burst is folded into one.
 *
 * Two kinds. "attention" is an agent that cannot go on without a person (a
 * permission prompt, a question, an error, a non-zero exit) and is on by
 * default. "finished" is a turn that ended cleanly and is off by default: it is
 * the chattier one. Both are per-person settings, kept in zevet.notify.v1.
 *
 * Pure: the clock, the timer and the OS call are injected, so board.ts wires
 * the real ones and the tests wire fakes.
 */

export const NOTIFY_KEY = "zevet.notify.v1";
export const NOTIFY_DEFAULTS = { finished: false, attention: true };

/** Burst window, and how many notifications inside it are shown one by one. */
export const BURST_MS = 2000;
export const BURST_SHOWN = 2;

export function readNotifyPrefs(storage) {
  let raw = null;
  try {
    raw = JSON.parse(storage.getItem(NOTIFY_KEY) || "null");
  } catch {
    raw = null;
  }
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    finished: typeof o.finished === "boolean" ? o.finished : NOTIFY_DEFAULTS.finished,
    attention: typeof o.attention === "boolean" ? o.attention : NOTIFY_DEFAULTS.attention,
  };
}

export function writeNotifyPrefs(storage, prefs) {
  try {
    storage.setItem(NOTIFY_KEY, JSON.stringify({ finished: !!prefs.finished, attention: !!prefs.attention }));
  } catch {
    // storage full or blocked: the toggle then lasts until reload, which beats throwing in a click handler
  }
}

/**
 * A console event as { kind, reason } or null. Exit 0 and a clean `result` are
 * "finished"; a result flagged is_error and a non-zero exit are "attention". A
 * signal exit (code null) is the person stopping it, so it is nothing.
 */
export function classifyAgentEvent(evt) {
  if (!evt) return null;
  if (evt.type === "exit") {
    if (evt.code === 0) return { kind: "finished", reason: "Finished" };
    if (typeof evt.code === "number") return { kind: "attention", reason: "Exited " + evt.code };
    return null;
  }
  if (evt.type === "agent" && evt.payload && evt.payload.type === "result") {
    return evt.payload.is_error ? { kind: "attention", reason: "Error" } : { kind: "finished", reason: "Finished" };
  }
  return null;
}

/** A permit or ask request: always "attention". */
export function classifyRequest(type) {
  return { kind: "attention", reason: type === "ask" ? "Question" : "Permission" };
}

/**
 * deps: { prefs(): {finished, attention}, now(): ms, schedule(fn, ms): handle,
 *         show({ title, body, key }), viewing?(key): boolean }
 * `viewing` is true when that agent is already on screen and the app focused.
 */
export function createNotifier(deps) {
  const burstMs = deps.burstMs ?? BURST_MS;
  const shown = deps.shown ?? BURST_SHOWN;
  let windowStart = -Infinity;
  let used = 0;
  let held = [];
  let timer = null;

  function flush() {
    timer = null;
    const more = held;
    held = [];
    windowStart = -Infinity;
    used = 0;
    if (!more.length) return;
    deps.show({ title: more.length + " more agents", body: more.map((m) => m.label).slice(0, 4).join(", "), key: more[0].key });
  }

  /** Returns true when the event was shown or held, false when dropped. */
  function notify(n) {
    if (!n || !n.kind) return false;
    if (!deps.prefs()[n.kind]) return false;
    if (deps.viewing && deps.viewing(n.key)) return false;
    const t = deps.now();
    if (t - windowStart >= burstMs) {
      windowStart = t;
      used = 0;
    }
    if (used < shown) {
      used++;
      deps.show({ title: n.label, body: n.reason, key: n.key });
    } else {
      held.push(n);
    }
    if (!timer) timer = deps.schedule(flush, burstMs);
    return true;
  }

  return { notify };
}
