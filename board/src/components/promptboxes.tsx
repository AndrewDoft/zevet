/**
 * Live prompt boxes: what a teammate is typing, as a ghost bubble under their
 * name in the people pane. Always shared (D-record 2026-10-09). Transport is in
 * lib/presence-room.ts; this file is the view and the composer tap.
 */
import { useEffect, type CSSProperties } from "react";
import { useAuiState } from "@assistant-ui/react";
import { bridge } from "../lib/bridge";
import { hueOf, selectActiveConsole, useBoard } from "../lib/board";
import { ensurePresenceRoom, setMyDraft, usePresenceStore } from "../lib/presence-room";
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

/** Under a teammate's row: their live draft. */
export function PromptGhost({ actor }: { actor: string }) {
  const { drafts } = usePresenceStore();
  const repo = useBoard((s) => s.selectedRepo);
  useEffect(() => ensurePresenceRoom(repo), [repo]);
  if (!bridge.canShare) return null;

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
