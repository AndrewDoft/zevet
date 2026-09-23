/**
 * Which models are past OpenRouter's free daily cap (or another usage limit),
 * remembered per model id so the picker stops offering one that would only
 * fail the same way again — lib/transcript.mjs's `plainError` already turns
 * that failure into "Rate limited" (plus a reset time, where one is known);
 * this reads that same text rather than re-parsing the provider's raw error,
 * so the two can never disagree about what counts. `classifyEnding` below is
 * the actual parse of the raw error, shared by plainError so there is exactly
 * one place that decides what a 429 looks like.
 *
 * `storage` is whatever implements getItem/setItem (window.localStorage in
 * the app, a plain in-memory fake in tests) — kept out of this file so it
 * runs under `node --test` without a DOM.
 */

const KEY = "zevet.modelLimits.v1";

/** What plainError puts at the front of a run that ended on a rate limit. */
const LIMIT_MESSAGE_RE = /^Rate limited\b/;

/**
 * A 429/usage-limit signal, vs. a provider error that is not a rate limit
 * (404, other 5xx, a timeout), vs. neither. Pure — a raw stderr line or a
 * payload's error message in, a classification out, nothing else.
 *
 * MEASURED against opencode 1.18.31 (2026-09-23), on OpenRouter's free tier:
 *   "Rate limit exceeded: free-models-per-day..."        -> rate_limited
 *   "Error: Upstream request failed: [429]"               -> rate_limited
 *   "Error from provider (Console): ... [404] ..."         -> provider_error (404)
 *   "Error: [Nvidia] Provider returned error"              -> null (no code, no
 *                                                             429/timeout signal
 *                                                             to classify by —
 *                                                             still closes the
 *                                                             run, just with the
 *                                                             generic message)
 *   "Streaming response failed: [504] A Timeout Occurred"  -> provider_error (504)
 *
 * 401/unauthorized is deliberately NOT provider_error here — plainError checks
 * for it first and reports "Not signed in." instead, which is a more useful
 * message than "Provider error 401" and needs no model-limit bookkeeping.
 */
const RATE_LIMIT_RE = /free-models-per-day|rate.?limit|\b429\b|too many requests|usage limit|quota/i;
const CODE_RE = /\b([45]\d\d)\b/;
const TIMEOUT_RE = /\btime(?:d)?[\s-]?out\b|timeout/i;

/** @returns {{ kind: "rate_limited" | "provider_error" | null, code: number | null }} */
export function classifyEnding(raw) {
  const s = String(raw ?? "");
  if (!s) return { kind: null, code: null };
  if (RATE_LIMIT_RE.test(s)) return { kind: "rate_limited", code: null };
  const code = CODE_RE.exec(s);
  if (code && code[1] !== "401") return { kind: "provider_error", code: Number(code[1]) };
  if (TIMEOUT_RE.test(s)) return { kind: "provider_error", code: null };
  return { kind: null, code: null };
}

/** "14:05", in the VIEWER's own local time — this is copy shown on screen
 *  ("resets 14:05"), and a person reads that against their own clock, not
 *  UTC. (§9.13's "pin the context" is about a number quoted in a log or a
 *  report surviving to a different reader; a live clock rendered for the
 *  person looking at it right now is the one case local time is correct,
 *  not a violation of it.) `recordModelLimit`'s own UTC-midnight FALLBACK is
 *  unrelated and unchanged — that is a storage cadence picked to match
 *  OpenRouter's own reset schedule, not something ever shown as a time. */
export function resetClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

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

/**
 * Fold whatever just closed a transcript into this memory: a run that ended
 * on "Rate limited" remembers it, a run that ended clean forgets it.
 * Anything else (still running, a provider error, "Not signed in.") is left
 * alone — a provider error must never gray a model that was never actually
 * over its cap.
 *
 * Shared by board.ts (Code) and chat.ts (Chat) so the two surfaces can never
 * disagree about what a rate limit looks like — each computes its own
 * `key` (Code: `${agent}:${model}`; Chat is claude-only, `claude:${model}`)
 * and its own last-message `status` off whichever transcript shape it has,
 * then calls this the same way.
 *
 * @param {unknown} storage
 * @param {string | null | undefined} key
 * @param {{ type?: string; error?: string } | null | undefined} status
 * @param {unknown} payload the raw agent payload, for resetFromPayload
 */
export function noteModelLimit(storage, key, status, payload) {
  if (!key || !status) return;
  if (status.type === "complete") clearModelLimit(storage, key);
  else if (status.type === "incomplete" && isLimitMessage(status.error)) {
    recordModelLimit(storage, key, resetFromPayload(payload));
  }
}

/** Model ids reordered so any still-limited ones sink below the rest, order
 *  otherwise kept. */
export function sortByLimit(ids, storage, now = Date.now()) {
  return ids
    .map((id, i) => ({ id, i, until: modelLimitedUntil(storage, id, now) }))
    .sort((a, b) => (Boolean(a.until) === Boolean(b.until) ? a.i - b.i : a.until ? 1 : -1))
    .map((x) => x.id);
}
