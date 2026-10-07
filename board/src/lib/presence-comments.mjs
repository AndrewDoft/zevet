/**
 * Anchored comments: one Y.Array per room in the SAME encrypted Y.Doc as the
 * text, so they travel and seal exactly like an edit. Each comment is a Y.Map
 * { id, author, text, anchor, createdAt, resolvedAt, replies }.
 *
 * `anchor` is a Y.RelativePosition (JSON), so the comment follows its line
 * through concurrent edits above it, and agent rewrites folded in as diffs.
 *
 * A comment may also carry `ref` (a transcript turn or a diff hunk, which has no
 * text position: `anchor` is then null) and `step` (a plan step it is attached
 * to). See comment-anchor.mjs. Both are plain JSON in the same sealed map.
 *
 * `Y` is passed in, never imported: the board must use the editor bundle's copy
 * of Yjs (two copies break instanceof checks), and tests use editor/node_modules.
 */
import { cleanRef, cleanStep } from "./comment-anchor.mjs";

export const COMMENTS_KEY = "comments";

const arr = (ydoc) => ydoc.getArray(COMMENTS_KEY);
const find = (ydoc, id) => arr(ydoc).toArray().find((m) => m.get("id") === id) || null;

/** `index` null/undefined with a valid `ref` is a turn comment: no text anchor.
 *  A hunk comment may give both: the ref names the edit, `index` where it sits. */
export function addComment(ydoc, Y, { author, text, index, id, ref = null, step = null, now = Date.now() }) {
  const m = new Y.Map();
  const cid = id || `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const clean = cleanRef(ref);
  const rel = index == null ? null : Y.createRelativePositionFromTypeIndex(ydoc.getText("content"), index);
  if (!rel && !clean) throw new Error("a comment needs a text position or a turn/hunk ref");
  ydoc.transact(() => {
    m.set("id", cid);
    m.set("author", String(author || "someone"));
    m.set("text", String(text || ""));
    m.set("anchor", rel ? Y.relativePositionToJSON(rel) : null);
    m.set("ref", clean);
    m.set("step", cleanStep(step));
    m.set("createdAt", now);
    m.set("resolvedAt", null);
    m.set("replies", new Y.Array());
    arr(ydoc).push([m]);
  });
  return cid;
}

export function replyTo(ydoc, id, { author, text, now = Date.now() }) {
  const m = find(ydoc, id);
  if (!m) return false;
  m.get("replies").push([{ author: String(author || "someone"), text: String(text || ""), at: now }]);
  return true;
}

/** `resolved=false` reopens. */
export function setResolved(ydoc, id, resolved, now = Date.now()) {
  const m = find(ydoc, id);
  if (!m) return false;
  m.set("resolvedAt", resolved ? now : null);
  return true;
}

/** Attach a comment to a plan step; `null` detaches. */
export function linkStep(ydoc, id, step) {
  const m = find(ydoc, id);
  if (!m) return false;
  const clean = step == null ? null : cleanStep(step);
  if (step != null && !clean) return false;
  m.set("step", clean);
  return true;
}

const lineOf = (text, index) => {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) n++;
  return n;
};

/** Plain snapshot with anchors resolved to the current index and 1-based line.
 *  An anchor whose text was deleted resolves to null and the comment is kept
 *  (shown as "detached") rather than dropped. */
export function listComments(ydoc, Y) {
  const ytext = ydoc.getText("content");
  const text = ytext.toString();
  return arr(ydoc).toArray().map((m) => {
    let index = null;
    const anchor = m.get("anchor");
    try {
      if (!anchor) throw new Error("no text anchor");
      const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor), ydoc);
      if (abs && abs.type === ytext) index = abs.index;
    } catch { /* malformed anchor from a peer: detached */ }
    return {
      id: m.get("id"),
      author: m.get("author"),
      text: m.get("text"),
      createdAt: m.get("createdAt"),
      resolvedAt: m.get("resolvedAt") ?? null,
      replies: m.get("replies") ? m.get("replies").toArray() : [],
      index,
      ref: cleanRef(m.get("ref")),
      step: cleanStep(m.get("step")),
      line: index == null ? null : lineOf(text, index),
    };
  });
}

/** What an agent may read: unresolved comments only, with the line's text. */
export function exportUnresolved(list, text, room) {
  const lines = String(text || "").split("\n");
  return {
    room,
    comments: list.filter((c) => !c.resolvedAt).map((c) => ({
      id: c.id,
      author: c.author,
      line: c.line,
      lineText: c.line == null ? null : lines[c.line - 1].slice(0, 200),
      ref: c.ref,
      step: c.step,
      text: c.text,
      replies: c.replies.map((r) => ({ author: r.author, text: r.text })),
    })),
  };
}
