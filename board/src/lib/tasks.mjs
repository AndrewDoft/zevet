// Team task board (D-NEXT-W2-15): the pure model. No DOM, no socket, no clock of
// its own, so the tests drive it exactly as the board does.
//
// A card is a bag of last-writer-wins fields plus an append-only set of
// comments. State and delta share one shape, so "merge" is the only operation
// and it is commutative, associative and idempotent: a replayed log, a snapshot
// and a live delta all go through the same function and cannot disagree.
//
//   { cards: { <id>: { f: { title, owner, status, link, del }, c: { <cid>: comment } } } }
//   field   { v, t, by }      value, time (ms), author
//   comment { text, by, t }
//
// Every entry names its author. A receiver keeps an entry only if that author's
// role, as the hub reports it, allows the write. The author name is not
// signed: anyone holding the team document key can forge one (D-NEXT-W2-15).

export const STATUSES = Object.freeze(["todo", "doing", "done"]);
export const LINK_KINDS = Object.freeze(["path", "agent"]);
export const LIMITS = Object.freeze({ cards: 500, comments: 200, title: 200, owner: 80, ref: 300, comment: 2000, id: 64 });

const RANK = { viewer: 0, commenter: 1, editor: 2, owner: 3 };
/** The least role each operation needs. Mirrors hub ACTION_ROLE's shape. */
export const NEED = Object.freeze({ create: "editor", move: "editor", assign: "editor", edit: "editor", remove: "editor", comment: "commenter", handoff: "editor" });

export const may = (role, op) => RANK[role] !== undefined && NEED[op] !== undefined && RANK[role] >= RANK[NEED[op]];

export const emptyState = () => ({ cards: {} });

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const idOk = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);

/** The value a field may hold, or undefined when it is junk. */
function cleanValue(name, v) {
  if (name === "title") return str(v, LIMITS.title) || undefined;
  if (name === "owner") return typeof v === "string" ? v.trim().replace(/^@/, "").slice(0, LIMITS.owner) : undefined;
  if (name === "status") return STATUSES.includes(v) ? v : undefined;
  if (name === "del") return v === true ? true : undefined;
  if (name === "link") {
    if (v === null) return null;
    if (!v || typeof v !== "object" || !LINK_KINDS.includes(v.kind)) return undefined;
    const ref = str(v.ref, LIMITS.ref);
    return ref ? { kind: v.kind, ref } : undefined;
  }
  return undefined;
}

const newer = (a, b) => !b || a.t > b.t || (a.t === b.t && a.by > b.by);

/**
 * Fold `delta` into `state`. `roleOf(login)` is the hub's word for who may do
 * what; an author it does not know, or whose role is too low, has that entry
 * dropped. Returns a new state and whether anything changed.
 */
export function merge(state, delta, { roleOf }) {
  const next = { cards: { ...state.cards } };
  let changed = false;
  const src = delta && typeof delta === "object" && delta.cards && typeof delta.cards === "object" ? delta.cards : {};
  for (const [id, d] of Object.entries(src)) {
    if (!idOk(id) || !d || typeof d !== "object") continue;
    const had = next.cards[id];
    if (!had && Object.keys(next.cards).length >= LIMITS.cards) continue;
    const card = { f: { ...(had ? had.f : {}) }, c: { ...(had ? had.c : {}) } };
    let touched = false;
    for (const [name, e] of Object.entries(d.f && typeof d.f === "object" ? d.f : {})) {
      if (!e || typeof e !== "object" || !Number.isFinite(e.t) || typeof e.by !== "string") continue;
      const v = cleanValue(name, e.v);
      if (v === undefined || !may(roleOf(e.by), "edit")) continue;
      const entry = { v, t: e.t, by: e.by };
      if (newer(entry, card.f[name])) {
        card.f[name] = entry;
        touched = true;
      }
    }
    for (const [cid, e] of Object.entries(d.c && typeof d.c === "object" ? d.c : {})) {
      if (!idOk(cid) || card.c[cid] || !e || typeof e !== "object" || !Number.isFinite(e.t) || typeof e.by !== "string") continue;
      const text = str(e.text, LIMITS.comment);
      if (!text || !may(roleOf(e.by), "comment") || Object.keys(card.c).length >= LIMITS.comments) continue;
      card.c[cid] = { text, by: e.by, t: e.t };
      touched = true;
    }
    if (touched) {
      next.cards[id] = card;
      changed = true;
    }
  }
  return { state: changed ? next : state, changed };
}

/**
 * One local action. Refused (never applied, never sent) when `role` is too low.
 * Returns { ok, state, delta } with `delta` the minimal frame to broadcast.
 *
 * ops: create {id,title,owner?,link?} | move {id,status} | assign {id,owner}
 *      edit {id,title?,link?} | remove {id} | comment {id,cid,text}
 */
export function apply(state, op, { by, role, now = Date.now }) {
  const kind = op && op.op;
  if (!may(role, kind)) return { ok: false, error: `${NEED[kind] || "editor"} role required`, role: role || null };
  if (!idOk(op.id)) return { ok: false, error: "bad card id" };
  const had = state.cards[op.id];
  if (kind !== "create" && (!had || !had.f.title || (had.f.del && had.f.del.v))) return { ok: false, error: "no such card" };
  if (kind === "create" && had) return { ok: false, error: "card exists" };

  const f = {};
  const c = {};
  const t0 = now();
  const stamp = (name) => {
    const prev = had && had.f[name];
    return { t: prev && prev.t >= t0 ? prev.t + 1 : t0, by };
  };
  const set = (name, v) => {
    const clean = cleanValue(name, v);
    if (clean === undefined) throw new Error(`bad ${name}`);
    f[name] = { v: clean, ...stamp(name) };
  };
  try {
    if (kind === "create") {
      set("title", op.title);
      set("status", "todo");
      set("owner", op.owner || "");
      if (op.link) set("link", op.link);
    } else if (kind === "move") set("status", op.status);
    else if (kind === "assign") set("owner", op.owner);
    else if (kind === "edit") {
      if (op.title !== undefined) set("title", op.title);
      if (op.link !== undefined) set("link", op.link);
      if (!Object.keys(f).length) return { ok: false, error: "nothing to change" };
    } else if (kind === "remove") set("del", true);
    else if (kind === "comment") {
      const text = str(op.text, LIMITS.comment);
      if (!text || !idOk(op.cid)) return { ok: false, error: "empty comment" };
      c[op.cid] = { text, by, t: t0 };
    } else return { ok: false, error: "unknown op" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const delta = { cards: { [op.id]: { f, c } } };
  const merged = merge(state, delta, { roleOf: (login) => (login === by ? role : null) });
  if (!merged.changed) return { ok: false, error: "nothing to change" };
  return { ok: true, state: merged.state, delta };
}

/** Cards for display: removed and title-less (not yet arrived) ones left out. */
export function cards(state) {
  const out = [];
  for (const [id, k] of Object.entries(state.cards)) {
    if (!k.f.title || (k.f.del && k.f.del.v)) continue;
    out.push({
      id,
      title: k.f.title.v,
      owner: k.f.owner ? k.f.owner.v : "",
      status: k.f.status ? k.f.status.v : "todo",
      link: k.f.link ? k.f.link.v : null,
      by: k.f.title.by,
      comments: Object.entries(k.c).map(([cid, m]) => ({ id: cid, ...m })).sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1)),
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export const encode = (state) => new TextEncoder().encode(JSON.stringify(state));

/** A frame's state, or null when it is not one. Never throws. */
export function decode(bytes) {
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === "object" && v.cards && typeof v.cards === "object" ? v : null;
  } catch {
    return null;
  }
}

export const newId = (rand = () => Math.random().toString(36).slice(2, 10), now = Date.now) => `${now().toString(36)}-${rand()}`;

/**
 * "Start agent on this": the prompt and the gate. Only an Editor hands work to
 * an agent; the hub gates the teammate route too (/api/spawn, Editor).
 */
export function handoff(card, role) {
  if (!may(role, "handoff")) return { ok: false, error: `${NEED.handoff} role required` };
  const file = card.link && card.link.kind === "path" ? ` Start with ${card.link.ref}.` : "";
  return { ok: true, prompt: `Task: ${card.title}.${file}`, label: card.title.slice(0, 60) };
}

export const roomName = (team) => `tasks:${team || "team"}`;
