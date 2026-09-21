/**
 * Times, as a person reads them.
 *
 * `text.mjs` already has `agoText`, which answers "how long ago" against a
 * server clock for roster rows. These two answer a different question —
 * an absolute moment, and a cadence id — for commits and schedules, where the
 * thing being described may be in the future.
 *
 * .mjs with a .d.mts beside it, the convention every piece of board logic the
 * gate tests follows, because the gate runs `node --test` against the source
 * and cannot import TypeScript.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The cadences desktop/schedule.js offers, by id. Kept in the board because
 *  the board is what renders them; if a cadence is added there and not here it
 *  falls back to its own id rather than to a wrong label. */
const CADENCE_LABEL = {
  "15m": "every 15 minutes",
  "1h": "hourly",
  "4h": "every 4 hours",
  "1d": "daily",
};

export function cadenceLabel(id) {
  return CADENCE_LABEL[String(id)] || String(id || "");
}

/**
 * A moment, relative to now, in both directions.
 *
 * A schedule's next run is in the future and a commit is in the past, and the
 * same list can hold both — so this says "in 12m" and "12m ago" rather than
 * assuming a direction the caller did not state.
 */
export function whenText(ms, now = Date.now()) {
  const at = Number(ms);
  if (!Number.isFinite(at) || at <= 0) return "";

  const delta = at - now;
  const ahead = delta > 0;
  const abs = Math.abs(delta);

  // Under a minute either way is "now": a clock that says "in 3s" is noise,
  // and one that says "0m ago" reads as broken.
  if (abs < MINUTE) return "just now";

  let n;
  let unit;
  if (abs < HOUR) {
    n = Math.round(abs / MINUTE);
    unit = "m";
  } else if (abs < DAY) {
    n = Math.round(abs / HOUR);
    unit = "h";
  } else {
    n = Math.round(abs / DAY);
    unit = "d";
  }

  return ahead ? `in ${n}${unit}` : `${n}${unit} ago`;
}
