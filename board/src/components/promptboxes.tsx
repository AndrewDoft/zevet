/**
 * Live prompt boxes: what a teammate is typing, as a ghost bubble under their
 * name in the people pane. Shared by default (Andrew's call); the owner can hide
 * their own draft with one click. Transport and the toggle are in
 * lib/presence-room.ts; this file is the two views and the composer tap.
 */
import { useEffect, type CSSProperties } from "react";
import { useAuiState } from "@assistant-ui/react";
import { bridge } from "../lib/bridge";
import { hueOf, selectActiveConsole, useBoard } from "../lib/board";
import { ensurePresenceRoom, setHideMyDraft, setMyDraft, usePresenceStore } from "../lib/presence-room";
import { draftFor } from "../lib/presence-drafts.mjs";

/** Mounted next to the composer: publishes its text (debounced) and which agent it targets. */
export function DraftPublisher() {
  const text = useAuiState((s) => s.composer.text);
  const active = useBoard(selectActiveConsole);
  const repo = useBoard((s) => s.selectedRepo);
  const target = active ? String(active.agent || "") : null;
  useEffect(() => ensurePresenceRoom(repo), [repo]);
  useEffect(() => setMyDraft(text, target), [text, target]);
  return null;
}

/** Under a person's row: their live draft, or for me the share/hide control. */
export function PromptGhost({ actor, me }: { actor: string; me: boolean }) {
  const { drafts, hidden } = usePresenceStore();
  const repo = useBoard((s) => s.selectedRepo);
  useEffect(() => ensurePresenceRoom(repo), [repo]);
  if (!bridge.canShare) return null;

  if (me) {
    return (
      <button
        className="prompt-ghost-toggle"
        onClick={() => setHideMyDraft(!hidden)}
        title={hidden ? "Your drafts are private. Click to share them with the team." : "Teammates see what you are typing. Click to hide it."}
        style={{ margin: "2px 16px 4px 26px", padding: 0, border: 0, background: "none", color: "var(--subtle)", fontSize: 11, cursor: "pointer", textAlign: "left" }}
      >
        {hidden ? "draft hidden · share" : "draft shared · hide"}
      </button>
    );
  }

  // The awareness name is the actor the room was joined with (the config's), the roster's is the
  // hub's display name; they differ in case until whoami lands. Match without case.
  const d = draftFor(drafts, actor);
  if (!d) return null;
  return (
    <div
      className="prompt-ghost"
      data-actor={actor}
      style={{
        "--who": hueOf(actor),
        margin: "2px 16px 6px 26px",
        padding: "5px 8px",
        border: "1px dashed var(--who)",
        borderRadius: 8,
        background: "var(--raise)",
        color: "var(--ink-muted)",
        fontSize: 11.5,
        lineHeight: 1.4,
        opacity: 0.85,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        maxHeight: 96,
        overflow: "hidden",
      } as CSSProperties}
    >
      {d.target ? <div style={{ fontSize: 10, letterSpacing: "0.04em", color: "var(--subtle)" }}>typing to {d.target}</div> : null}
      {d.text}
    </div>
  );
}
