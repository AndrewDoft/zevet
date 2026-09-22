/**
 * Which models are past OpenRouter's free daily cap (or another usage limit),
 * remembered per model id so the picker stops offering one that would only
 * fail the same way again — lib/transcript.mjs's `plainError` already turns
 * that failure into "<model> hit its free daily limit."/"...usage limit.";
 * this reads that same sentence rather than re-parsing the provider's raw
 * error, so the two can never disagree about what counts.
 *
 * `storage` is whatever implements getItem/setItem (window.localStorage in
 * the app, a plain in-memory fake in tests) — kept out of this file so it
 * runs under `node --test` without a DOM.
 */

const KEY = "zevet.modelLimits.v1";

/** The tail plainError puts on a run that ended this way. */
const LIMIT_MESSAGE_RE = /hit its (free daily|usage) limit\.$/;

function readAll(storage) {
  try {
    const v = JSON.parse(storage.getItem(KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function writeAll(storage, all) {
  try {
    storage.setItem(KEY, JSON.stringify(all));
  } catch {
    // private mode, storage disabled, or full — the mark just doesn't stick.
  }
}

/** Whether a closed run's plain error text is a free-daily/usage-limit one. */
export function isLimitMessage(text) {
  return LIMIT_MESSAGE_RE.test(String(text ?? ""));
}

/** OpenRouter's `X-RateLimit-Reset`, off opencode's error shape
 *  (`error.data.responseHeaders`) — milliseconds since epoch, else null. */
export function resetFromPayload(payload) {
  const headers = payload && payload.error && payload.error.data && payload.error.data.responseHeaders;
  const raw = headers && (headers["x-ratelimit-reset"] ?? headers["X-RateLimit-Reset"]);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function nextUtcMidnight(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Record that `modelId` is limited until `resetAt` (ms epoch). Falls back to
 *  the next UTC midnight — OpenRouter's own reset cadence — when the error
 *  carried no reset time. */
export function recordModelLimit(storage, modelId, resetAt, now = Date.now()) {
  if (!modelId) return;
  const all = readAll(storage);
  all[modelId] = { resetAt: resetAt || nextUtcMidnight(now) };
  writeAll(storage, all);
}

/** Forget a model's limit — a run on it just succeeded. */
export function clearModelLimit(storage, modelId) {
  if (!modelId) return;
  const all = readAll(storage);
  if (!(modelId in all)) return;
  delete all[modelId];
  writeAll(storage, all);
}

/** The reset time (ms epoch) for a still-limited model, else null. A reset
 *  that has already passed is cleared here rather than just ignored, so
 *  nothing else has to remember to sweep it. */
export function modelLimitedUntil(storage, modelId, now = Date.now()) {
  if (!modelId) return null;
  const all = readAll(storage);
  const entry = all[modelId];
  if (!entry) return null;
  if (entry.resetAt <= now) {
    delete all[modelId];
    writeAll(storage, all);
    return null;
  }
  return entry.resetAt;
}

/** Model ids reordered so any still-limited ones sink below the rest, order
 *  otherwise kept. */
export function sortByLimit(ids, storage, now = Date.now()) {
  return ids
    .map((id, i) => ({ id, i, until: modelLimitedUntil(storage, id, now) }))
    .sort((a, b) => (Boolean(a.until) === Boolean(b.until) ? a.i - b.i : a.until ? 1 : -1))
    .map((x) => x.id);
}
