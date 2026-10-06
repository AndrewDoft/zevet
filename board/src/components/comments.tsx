/**
 * The comment thread panel under the shared editor. Comments are anchored to a
 * position in the text (lib/presence-comments.mjs) and shown in the gutter
 * (editor/src/index.js); this lists them, takes replies and resolves.
 * Renders nothing when the editor is not shared.
 */
import { useState, type CSSProperties } from "react";
import { hueOf, useBoard } from "../lib/board";
import { addAtCursor, reply, resolve, reveal, useComments } from "../lib/presence-session";
import type { Comment } from "../lib/presence-comments.mjs";

const box: CSSProperties = { borderTop: "1px solid var(--line)", background: "var(--paper)", color: "var(--ink)", fontSize: 12, flex: "none", maxHeight: "40%", overflow: "auto" };
const btn: CSSProperties = { border: 0, background: "none", color: "var(--subtle)", cursor: "pointer", fontSize: 11, padding: "0 4px" };
const input: CSSProperties = { flex: 1, minWidth: 0, font: "inherit", padding: "3px 6px", border: "1px solid var(--line)", borderRadius: 4, background: "var(--raise)", color: "var(--ink)" };

function Thread({ c, focused }: { c: Comment; focused: boolean }) {
  const [text, setText] = useState("");
  const send = () => {
    reply(c.id, text);
    setText("");
  };
  return (
    <div data-comment={c.id} data-resolved={String(Boolean(c.resolvedAt))} style={{ padding: "6px 12px", borderBottom: "1px solid var(--line)", opacity: c.resolvedAt ? 0.55 : 1, background: focused ? "var(--raise)" : undefined }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <b style={{ color: hueOf(c.author) }}>{c.author}</b>
        <button style={btn} onClick={() => reveal(c)} disabled={c.line == null} title="Go to the line">
          {c.line == null ? "detached" : `line ${c.line}`}
        </button>
        <span style={{ flex: 1 }} />
        <button style={btn} onClick={() => resolve(c.id, !c.resolvedAt)}>{c.resolvedAt ? "reopen" : "resolve"}</button>
      </div>
      <div style={{ whiteSpace: "pre-wrap" }}>{c.text}</div>
      {c.replies.map((r, i) => (
        <div key={i} style={{ marginLeft: 12, marginTop: 3, whiteSpace: "pre-wrap" }}>
          <b style={{ color: hueOf(r.author) }}>{r.author}</b> {r.text}
        </div>
      ))}
      {c.resolvedAt ? null : (
        <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
          <input style={input} placeholder="Reply" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }} />
        </div>
      )}
    </div>
  );
}

export function CommentsPanel() {
  const { room, comments, focus } = useComments();
  const editor = useBoard((s) => s.edView);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  if (!room || !editor || editor.room !== room) return null;

  const unresolved = comments.filter((c) => !c.resolvedAt).length;
  const add = () => {
    if (addAtCursor(draft)) {
      setDraft("");
      setOpen(true);
    }
  };
  const shown = open || focus.length > 0;
  return (
    <div className="comments" style={box}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 12px" }}>
        <button style={{ ...btn, color: "var(--ink)" }} onClick={() => setOpen(!shown)} aria-expanded={shown}>
          Comments{unresolved ? ` (${unresolved})` : ""}
        </button>
        <input style={input} placeholder="Comment on the line at your cursor" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        <button style={btn} onClick={add} disabled={!draft.trim()}>Add</button>
      </div>
      {shown ? comments.map((c) => <Thread key={c.id} c={c} focused={focus.includes(c.id)} />) : null}
      {shown && !comments.length ? <div style={{ padding: "4px 12px", color: "var(--subtle)" }}>No comments on this file.</div> : null}
    </div>
  );
}
