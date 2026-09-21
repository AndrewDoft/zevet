/**
 * Agent runs on a clock.
 *
 * zevet could already start an agent; it could not start one later. A schedule
 * is that and nothing more — the same spawn, triggered by a timer instead of a
 * click — so it adds no capability the app did not have, only a delay.
 *
 * ⚠️ ONE REFUSAL, AND IT IS DELIBERATE: a schedule may not run in `dangerous`
 * mode. That posture skips every permission prompt, and the whole point of a
 * prompt is that somebody is there to answer it. Unattended and unprompted at
 * the same time is the combination worth refusing, so `sanitise` downgrades it
 * to `auto` rather than silently honouring it.
 *
 * The pure parts live here — what is due, what runs next, what a stored record
 * is allowed to contain — because they are the parts worth testing, and the
 * gate cannot spawn Electron. Everything with a side effect is in main.js.
 */

/** The cadences offered. Minutes, because a schedule measured in seconds is a
 *  loop and this is not a loop. */
const CADENCES = [
  { id: "15m", label: "every 15 minutes", minutes: 15 },
  { id: "1h", label: "hourly", minutes: 60 },
  { id: "4h", label: "every 4 hours", minutes: 240 },
  { id: "1d", label: "daily", minutes: 1440 },
];

const MIN_MINUTES = 15;
const MAX_HISTORY = 20;

function cadenceOf(id) {
  return CADENCES.find((c) => c.id === id) || CADENCES[1];
}

/**
 * A stored schedule, with everything a caller is allowed to set and nothing
 * it is not.
 *
 * The record comes off disk, and a file somebody edited by hand is not a
 * reason to crash at startup — every field is coerced rather than trusted.
 */
function sanitise(raw, now = Date.now()) {
  const o = raw && typeof raw === "object" ? raw : {};
  const cadence = cadenceOf(String(o.cadence || ""));
  const mode = String(o.mode || "auto");
  return {
    id: String(o.id || `s${now}${Math.random().toString(36).slice(2, 8)}`),
    name: String(o.name || "Scheduled run").slice(0, 80),
    prompt: String(o.prompt || "").slice(0, 4000),
    agent: String(o.agent || "claude").slice(0, 40),
    model: String(o.model || "").slice(0, 120),
    // See the refusal above. A schedule cannot skip permissions.
    mode: mode === "dangerous" ? "auto" : mode,
    root: String(o.root || ""),
    cadence: cadence.id,
    enabled: o.enabled !== false,
    // A brand new schedule does not fire immediately: it fires one cadence
    // from now. Running the moment you press save is a surprise, not a
    // schedule.
    nextAt: Number(o.nextAt) > 0 ? Number(o.nextAt) : now + cadence.minutes * 60_000,
    history: Array.isArray(o.history)
      ? o.history
          .slice(-MAX_HISTORY)
          .map((h) => ({
            id: String((h && h.id) || ""),
            at: Number(h && h.at) || 0,
            ok: Boolean(h && h.ok),
          }))
          .filter((h) => h.at > 0)
      : [],
  };
}

/** Everything due to run now. Disabled schedules are never due, and a schedule
 *  whose folder is gone is filtered by the caller, which is the only one that
 *  knows which folders are open. */
function due(schedules, now = Date.now()) {
  return (schedules || []).filter((s) => s && s.enabled && Number(s.nextAt) > 0 && s.nextAt <= now);
}

/**
 * The schedule after it has fired.
 *
 * ⚠️ NEXT IS COMPUTED FROM NOW, NOT FROM THE LAST DUE TIME. A laptop that was
 * asleep for six hours comes back with one overdue schedule, not twenty-four
 * queued runs — catching up on a missed cron is how an unattended agent spends
 * a day's quota in a minute.
 */
function advance(schedule, ok, now = Date.now()) {
  const minutes = cadenceOf(schedule.cadence).minutes;
  return {
    ...schedule,
    nextAt: now + minutes * 60_000,
    history: [...(schedule.history || []), { id: `r${now}`, at: now, ok: Boolean(ok) }].slice(-MAX_HISTORY),
  };
}

module.exports = { CADENCES, MIN_MINUTES, MAX_HISTORY, cadenceOf, sanitise, due, advance };
