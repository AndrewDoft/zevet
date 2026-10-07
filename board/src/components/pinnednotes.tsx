import { useEffect, useState } from "react";
import { useBoard } from "../lib/board";
import { flagText, staleChipText } from "../lib/memory.mjs";
import { editNote, pinNote, refreshMemory, retireNote, useMemory, wireMemory } from "../lib/memorystore";

/** Keeps the notes loaded for the folder on screen. Renders nothing. */
export function useMemoryFeed(): void {
  const root = useBoard((s) => s.localRoot) || "";
  useEffect(() => {
    wireMemory(() => useBoard.getState().localRoot || "");
    void refreshMemory(root);
  }, [root]);
}

/** On the board: how many notes need a person. Nothing when none do. */
export function StaleNotesChip() {
  const text = staleChipText(useMemory((s) => s.notes));
  return text ? <span className="memory-chip" data-stale="true" title="pinned notes whose file moved">{"notes: " + text}</span> : null;
}

/** In the file view: this file's notes, each flagged, with edit / re-pin / retire. */
export function PinnedNotes({ path }: { path: string }) {
  const root = useBoard((s) => s.localRoot) || "";
  const notes = useMemory((s) => s.notes).filter((n) => n.path === path);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  if (!root) return null;
  return (
    <div className="pinned-notes">
      {notes.map((n) => (
        <div className="pinned-note" key={n.id} data-stale={n.stale}>
          {flagText(n) ? <span className="memory-chip" data-stale="true">{flagText(n)}</span> : null}
          {editing && editing.id === n.id ? (
            <>
              <textarea value={editing.text} onChange={(e) => setEditing({ id: n.id, text: e.target.value })} />
              <button type="button" onClick={() => { void editNote(root, n.id, editing.text); setEditing(null); }}>Save</button>
              <button type="button" onClick={() => setEditing(null)}>Cancel</button>
            </>
          ) : (
            <>
              <span className="pinned-text">{n.text}</span>
              <span className="pinned-who">{n.author}</span>
              <button type="button" onClick={() => setEditing({ id: n.id, text: n.text })}>Edit</button>
              {n.stale === "stale" ? <button type="button" onClick={() => void editNote(root, n.id, n.text, true)}>Still true</button> : null}
              <button type="button" onClick={() => void retireNote(root, n.id)}>Retire</button>
            </>
          )}
        </div>
      ))}
      <form
        className="pinned-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) void pinNote(root, path, draft).then(() => setDraft(""));
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Pin a note" aria-label="Pin a note" />
        <button type="submit">Pin</button>
      </form>
    </div>
  );
}
