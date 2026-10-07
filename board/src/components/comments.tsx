/**
 * The comment thread panel under the shared editor. Comments are anchored to a
 * position in the text (lib/presence-comments.mjs) and shown in the gutter
 * (editor/src/index.js); this lists them, takes replies and resolves.
 * Renders nothing when the editor is not shared.
 */
import { useState, type CSSProperties } from "react";
import { hueOf, selectActiveConsole, useBoard } from "../lib/board";
import { addAtCursor, addWithRef, attachStep, commentToAgent, reply, resolve, reveal, setPendingAnchor, useComments, usePendingAnchor } from "../lib/presence-session";
import { stepState, type CommentRef } from "../lib/comment-anchor.mjs";
import { useSteer } from "../lib/steer";
import type { Comment } from "../lib/presence-comments.mjs";

const box: CSSProperties = { borderTop: "1px solid var(--line)", background: "var(--paper)", color: "var(--ink)", fontSize: 12, flex: "none", maxHeight: "40%", overflow: "auto" };
const btn: CSSProperties = { border: 0, background: "none", color: "var(--subtle)", cursor: "pointer", fontSize: 11, padding: "0 4px" };
const input: CSSProperties = { flex: 1, minWidth: 0, font: "inherit", padding: "3px 6px", border: "1px solid var(--line)", borderRadius: 4, background: "var(--raise)", color: "var(--ink)" };

/** Where a comment is pinned, in words. */
function anchorLabel(c: Comment): string {
  if (c.ref?.kind === "turn") return `turn ${c.ref.turn + 1}`;
  if (c.ref?.kind === "hunk") return `edit ${c.ref.file}`;
  return c.line == null ? "detached" : `line ${c.line}`;
}

function Thread({ c, focused }: { c: Comment; focused: boolean }) {
  const [text, setText] = useState("");
  const target = useSteer((s) => s.target);
  const plan = useBoard(selectActiveConsole)?.plan?.steps ?? [];
  const state = c.step ? stepState(c.step, plan) : null;
  const send = () => {
    reply(c.id, text);
    setText("");
  };
  return (
    <div data-comment={c.id} data-resolved={String(Boolean(c.resolvedAt))} style={{ padding: "6px 12px", borderBottom: "1px solid var(--line)", opacity: c.resolvedAt ? 0.55 : 1, background: focused ? "var(--raise)" : undefined }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <b style={{ color: hueOf(c.author) }}>{c.author}</b>
        <button style={btn} onClick={() => reveal(c)} disabled={c.line == null} title="Go to the line">
          {anchorLabel(c)}
        </button>
        {c.step ? <span data-comment-step title={`Plan step: ${c.step.text}`} style={{ color: "var(--subtle)" }}>step {c.step.index + 1}{state ? ` · ${state.replace("_", " ")}` : " · gone"}</span> : null}
        <span style={{ flex: 1 }} />
        {plan.length ? (
          <select style={btn} aria-label="Attach to plan step" value={c.step && state ? String(c.step.index) : ""} onChange={(e) => {
            const i = e.target.value === "" ? -1 : Number(e.target.value);
            attachStep(c.id, i < 0 ? null : { session: "", index: i, text: plan[i].text });
          }}>
            <option value="">no step</option>
            {plan.map((st, i) => <option key={i} value={i}>{i + 1}. {st.text.slice(0, 40)}</option>)}
          </select>
        ) : null}
        <button style={btn} disabled={!target} onClick={() => target && void commentToAgent(c, target)} title={target ? "Steer their agent with this comment and its lines" : "Pick an agent to steer first"}>to agent</button>
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
  const pending = usePendingAnchor();
  if (!room || !editor || editor.room !== room) return null;

  const unresolved = comments.filter((c) => !c.resolvedAt).length;
  const add = () => {
    if (pending ? addWithRef(draft, pending) : addAtCursor(draft)) {
      setDraft("");
      setPendingAnchor(null);
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
        <input style={input} placeholder={pending ? (pending.kind === "turn" ? `Comment on turn ${pending.turn + 1}` : `Comment on this edit`) : "Comment on the line at your cursor"} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        {pending ? <button style={btn} onClick={() => setPendingAnchor(null)} title="Back to the cursor line">clear</button> : null}
        <button style={btn} onClick={add} disabled={!draft.trim()}>Add</button>
      </div>
      {shown ? comments.map((c) => <Thread key={c.id} c={c} focused={focus.includes(c.id)} />) : null}
      {shown && !comments.length ? <div style={{ padding: "4px 12px", color: "var(--subtle)" }}>No comments on this file.</div> : null}
    </div>
  );
}

/** "Comment" on a turn or a diff hunk: pins the next comment to it. */
export function AnchorButton({ refOf, label = "Comment" }: { refOf: () => CommentRef | null; label?: string }) {
  const { room } = useComments();
  if (!room) return null;
  return (
    <button type="button" className="text-foreground/50 hover:text-foreground/90 rounded-full px-2 py-0.5 text-[11px] font-medium" title="Pin your next comment here" onClick={() => setPendingAnchor(refOf())}>
      {label}
    </button>
  );
}
