/**
 * Live prompt boxes. A person's composer draft is published over a presence
 * room's awareness (sealed by doc-sync like any other frame, so the hub relays
 * it without reading it). Shared by default (Andrew, 2026-10-06); each person
 * can hide their own with the "hide my draft" toggle.
 */
export const DRAFT_MAX = 1000;
export const DRAFT_DEBOUNCE_MS = 400;
/** A draft that has not been refreshed for this long is stale (peer vanished). */
export const DRAFT_STALE_MS = 60_000;

/** The awareness field to publish, or null (clear it). */
export function draftField({ text, target, hidden, now = Date.now() }) {
  const t = String(text || "");
  if (hidden || !t.trim()) return null;
  return { text: t.slice(0, DRAFT_MAX), target: target ? String(target).slice(0, 60) : null, ts: now };
}

/** Everyone else's live drafts, from an awareness `getStates()` map. */
export function liveDrafts(states, selfId, now = Date.now()) {
  const out = {};
  for (const [id, s] of states) {
    if (id === selfId || !s || !s.user || !s.draft) continue;
    if (now - Number(s.draft.ts) > DRAFT_STALE_MS) continue;
    out[s.user.name] = { text: String(s.draft.text || ""), target: s.draft.target || null, ts: s.draft.ts };
  }
  return out;
}

/** One person's draft out of `liveDrafts`' map. The key is the name the room was joined with (the
 *  config's actor), the roster's is the hub's display name; they differ in case until whoami lands. */
export function draftFor(drafts, actor) {
  if (drafts[actor]) return drafts[actor];
  const want = String(actor).toLowerCase();
  for (const [k, v] of Object.entries(drafts)) if (k.toLowerCase() === want) return v;
  return undefined;
}
