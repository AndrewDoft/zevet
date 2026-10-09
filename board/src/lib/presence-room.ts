/**
 * The repo-wide presence room: an awareness-only room (`<repo>:.zevet-presence`)
 * that carries each person's live composer draft. It reuses the editor rooms'
 * transport, so frames are sealed in the main process (desktop/doc-sync.js,
 * AES-256-GCM with the room name as AAD) and the hub relays ciphertext.
 *
 * The draft is always shared. Module state with a tiny store so the composer
 * and the people pane stay in step without touching the big board store.
 */
import { useSyncExternalStore } from "react";
import { bridge } from "./bridge";
import { draftField, liveDrafts, DRAFT_DEBOUNCE_MS, DRAFT_STALE_MS } from "./presence-drafts.mjs";
import type { DraftField } from "./presence-drafts.mjs";
import { hueOf, useBoard } from "./board";

/* eslint-disable @typescript-eslint/no-explicit-any */
const MSG_AWARENESS = 1;

interface Store {
  drafts: Record<string, DraftField>;
}

let store: Store = { drafts: {} };
const listeners = new Set<() => void>();
const emit = (next: Store) => {
  store = next;
  listeners.forEach((l) => l());
};

export function usePresenceStore(): Store {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => store,
  );
}

interface Room {
  repo: string;
  name: string;
  awareness: any;
  E: any;
  off: Array<() => void>;
}
let current: Room | null = null;
let timer: number | null = null;

function publish(r: Room, field: DraftField | null): void {
  r.awareness.setLocalStateField("draft", field);
}

/** Join (or stay in) the presence room for `repo`. Safe to call on every render. */
export function ensurePresenceRoom(repo: string | null): void {
  if (!repo || !bridge.canShare) return;
  if (current && current.repo === repo) return;
  leavePresenceRoom();
  const E = (window as any).zevetEditor;
  const doc = (window as any).zevetDoc;
  if (!E || !doc) return;

  const name = `${repo}:.zevet-presence`;
  const ydoc = new E.Y.Doc();
  const awareness = new E.Awareness(ydoc);
  const actor = useBoard.getState().myActor || "me";
  const color = (() => {
    const v = /^var\((--[a-z0-9-]+)\)$/.exec(hueOf(actor));
    return (v && getComputedStyle(document.documentElement).getPropertyValue(v[1]).trim()) || "#2f6f8f";
  })();
  awareness.setLocalStateField("user", { name: actor, color });
  const r: Room = { repo, name, awareness, E, off: [] };
  current = r;

  const tag = (bytes: Uint8Array) => {
    const out = new Uint8Array(bytes.length + 1);
    out[0] = MSG_AWARENESS;
    out.set(bytes, 1);
    return out;
  };
  const recompute = () => emit({ ...store, drafts: liveDrafts(awareness.getStates(), awareness.clientID) });

  r.off.push(doc.onMessage((m: { room?: string; kind?: string; bytes?: Uint8Array }) => {
    if (current !== r || m.room !== name) return;
    if (m.kind === "ready") {
      doc.send(name, tag(E.awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID])));
    } else if (m.kind === "update" && m.bytes && m.bytes.length && m.bytes[0] === MSG_AWARENESS) {
      E.awarenessProtocol.applyAwarenessUpdate(awareness, m.bytes.subarray(1), "remote");
    }
  }));
  const onUpdate = (c: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    recompute();
    if (origin === "remote") return;
    const ids = c.added.concat(c.updated, c.removed);
    if (ids.length) doc.send(name, tag(E.awarenessProtocol.encodeAwarenessUpdate(awareness, ids)));
  };
  awareness.on("update", onUpdate);
  r.off.push(() => awareness.off("update", onUpdate));
  // A peer that vanished stops refreshing; sweep so its ghost bubble goes.
  const sweep = window.setInterval(recompute, DRAFT_STALE_MS / 4);
  r.off.push(() => window.clearInterval(sweep));

  void doc.join(name);
}

export function leavePresenceRoom(): void {
  const r = current;
  if (!r) return;
  current = null;
  if (timer) window.clearTimeout(timer);
  timer = null;
  try {
    r.E.awarenessProtocol.removeAwarenessStates(r.awareness, [r.awareness.clientID], "local");
    const gone = r.E.awarenessProtocol.encodeAwarenessUpdate(r.awareness, [r.awareness.clientID]);
    const out = new Uint8Array(gone.length + 1);
    out[0] = MSG_AWARENESS;
    out.set(gone, 1);
    (window as any).zevetDoc?.send?.(r.name, out);
  } catch { /* socket already gone */ }
  r.off.forEach((f) => { try { f(); } catch { /* detached */ } });
  try { (window as any).zevetDoc?.leave?.(r.name); } catch { /* ditto */ }
  r.awareness.destroy();
  emit({ ...store, drafts: {} });
}

/** The composer calls this on every change; the wire is hit at most once per DRAFT_DEBOUNCE_MS. */
export function setMyDraft(text: string, target: string | null): void {
  const r = current;
  if (!r) return;
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    if (current === r) publish(r, draftField({ text, target, hidden: false }));
  }, DRAFT_DEBOUNCE_MS);
}
