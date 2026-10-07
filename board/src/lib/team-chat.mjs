// Team chat (D-NEXT-W2-15B): the pure model. No DOM, no socket, no clock of its own.
//
// An append-only set of messages. State and delta share one shape, so "merge" is
// the only operation and it is commutative, associative and idempotent: a replayed
// log, a snapshot and a live delta all go through the same function.
//
//   { msgs: { <id>: { text, by, t, replyTo?, cardId? } } }
//
// A message is never edited or removed; the first one seen for an id wins. A
// receiver keeps a message only if its author's role, as the hub reports it,
// allows posting. The author name is not signed (see D-NEXT-W2-15).

export const LIMITS = Object.freeze({ messages: 500, text: 4000, id: 64 });

const RANK = { viewer: 0, commenter: 1, editor: 2, owner: 3 };
/** Viewer reads; Commenter and above post. Mirrors hub ACTION_ROLE.chat. */
export const NEED = Object.freeze({ post: "commenter" });
export const may = (role, op) => RANK[role] !== undefined && NEED[op] !== undefined && RANK[role] >= RANK[NEED[op]];

export const emptyState = () => ({ msgs: {} });

const idOk = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
const clean = (m) => {
  if (!m || typeof m !== "object" || !Number.isFinite(m.t) || typeof m.by !== "string" || !m.by || typeof m.text !== "string") return null;
  const text = m.text.trim().slice(0, LIMITS.text);
  if (!text) return null;
  const out = { text, by: m.by, t: m.t };
  if (m.replyTo !== undefined) {
    if (!idOk(m.replyTo)) return null;
    out.replyTo = m.replyTo;
  }
  if (m.cardId !== undefined) {
    if (!idOk(m.cardId)) return null;
    out.cardId = m.cardId;
  }
  return out;
};
const order = (a, b) => a[1].t - b[1].t || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/** Fold `delta` into `state`; an author whose role cannot post has that message dropped. */
export function merge(state, delta, { roleOf }) {
  const src = delta && typeof delta === "object" && delta.msgs && typeof delta.msgs === "object" ? delta.msgs : {};
  let msgs = { ...state.msgs };
  let added = false;
  for (const [id, raw] of Object.entries(src)) {
    if (!idOk(id) || msgs[id]) continue;
    const m = clean(raw);
    if (!m || !may(roleOf(m.by), "post")) continue;
    msgs[id] = m;
    added = true;
  }
  if (!added) return { state, changed: false };
  // Keep the newest `messages` by (t, id): the top N of a union is order-independent.
  const all = Object.entries(msgs);
  if (all.length > LIMITS.messages) {
    msgs = Object.fromEntries(all.sort(order).slice(-LIMITS.messages));
    if (Object.keys(msgs).every((k) => state.msgs[k])) return { state, changed: false }; // arrived below the cutoff
  }
  return { state: { msgs }, changed: true };
}

/**
 * One local post. Refused (never applied, never sent) when `role` is too low.
 * op: { op: "post", id, text, replyTo?, cardId? }
 */
export function apply(state, op, { by, role, now = Date.now }) {
  if (!op || op.op !== "post") return { ok: false, error: "unknown op" };
  if (!may(role, "post")) return { ok: false, error: `${NEED.post} role required`, role: role || null };
  if (!idOk(op.id)) return { ok: false, error: "bad message id" };
  if (state.msgs[op.id]) return { ok: false, error: "message exists" };
  if (typeof op.text !== "string" || !op.text.trim()) return { ok: false, error: "empty message" };
  if (op.text.trim().length > LIMITS.text) return { ok: false, error: `message over ${LIMITS.text} characters` };
  const m = clean({ text: op.text, by, t: now(), replyTo: op.replyTo, cardId: op.cardId });
  if (!m) return { ok: false, error: "bad reply or card" };
  const delta = { msgs: { [op.id]: m } };
  const merged = merge(state, delta, { roleOf: (login) => (login === by ? role : null) });
  if (!merged.changed) return { ok: false, error: "nothing to change" };
  return { ok: true, state: merged.state, delta };
}

/** Messages for display, oldest first. Text is data: render it as text, never HTML. */
export const messages = (state) =>
  Object.entries(state.msgs)
    .sort(order)
    .map(([id, m]) => ({ id, ...m }));

/** Message count per card id. */
export function countByCard(state) {
  const out = {};
  for (const m of Object.values(state.msgs)) if (m.cardId) out[m.cardId] = (out[m.cardId] || 0) + 1;
  return out;
}

/** Messages by others newer than the local last-read marker (a ms timestamp). */
export const unread = (state, lastRead, me) => Object.values(state.msgs).filter((m) => m.t > (lastRead || 0) && m.by.toLowerCase() !== String(me || "").toLowerCase()).length;

/** The marker to store once everything shown has been read. */
export const readMark = (state) => Object.values(state.msgs).reduce((a, m) => Math.max(a, m.t), 0);

/** Does `text` @-mention any of `names` (login or display name, case-insensitive)? */
export function mentions(text, names) {
  const t = String(text || "");
  return names.some((n) => {
    const name = String(n || "").toLowerCase().replace(/^@/, "").trim();
    if (!name) return false;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\w])@${esc}(?![\\w-])`, "i").test(t);
  });
}

/**
 * Raise a needs-attention notification for each message that mentions me, that
 * someone else wrote, that is newer than my last-read marker, and that this
 * session has not already announced. `seen` is mutated. The notifier
 * (notify.mjs) applies the person's toggle and folds bursts.
 * ctx: { names, me, lastRead, seen: Set, notifier: { notify(n) } }
 */
export function raiseMentions(state, { names, me, lastRead, seen, notifier }) {
  let n = 0;
  for (const m of messages(state)) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    if (m.t <= (lastRead || 0) || m.by.toLowerCase() === String(me || "").toLowerCase() || !mentions(m.text, names)) continue;
    notifier.notify({ kind: "attention", label: m.by, reason: m.text.slice(0, 80), key: `chat:${m.id}` });
    n++;
  }
  return n;
}

export const encode = (state) => new TextEncoder().encode(JSON.stringify(state));

/** A frame's state, or null when it is not one. Never throws. */
export function decode(bytes) {
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === "object" && v.msgs && typeof v.msgs === "object" ? v : null;
  } catch {
    return null;
  }
}

export const newId = (rand = () => Math.random().toString(36).slice(2, 10), now = Date.now) => `${now().toString(36)}-${rand()}`;

export const roomName = (team) => `chat:${team || "team"}`;
