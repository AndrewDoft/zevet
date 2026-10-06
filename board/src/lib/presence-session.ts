/**
 * Presence for the ONE open editor: agent ranges, anchored comments.
 *
 * board.ts calls `attachPresence` when a shared editor mounts and
 * `presenceDiskChanged` when an agent's write lands; everything else lives here
 * so that file stays untouched. The comments panel (components/comments.tsx)
 * reads this store through `useComments`.
 */
import { useSyncExternalStore } from "react";
import { AgentPresence } from "./presence-agents.mjs";
import { agentRanges } from "./presence.mjs";
import { addComment, exportUnresolved, listComments, replyTo, setResolved, COMMENTS_KEY } from "./presence-comments.mjs";
import type { Comment } from "./presence-comments.mjs";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PresenceCtx {
  E: { Y: any; Awareness: any; awarenessProtocol: any };
  ydoc: any;
  awareness: any;
  room: string;
  relPath: string;
  handle: { view: any; setCommentMarkers?: (m: unknown[]) => void; onCommentClick?: ((ids: string[]) => void) | null };
  getText: () => string;
  /** Send raw awareness bytes to the room. */
  sendAwareness: (bytes: Uint8Array) => void;
  colorOf: (actor: string) => string;
  me: () => string;
}

export interface CommentsState {
  room: string | null;
  comments: Comment[];
  focus: string[];
}

const EMPTY: CommentsState = { room: null, comments: [], focus: [] };
let state: CommentsState = EMPTY;
let active: { ctx: PresenceCtx; agents: AgentPresence } | null = null;
const listeners = new Set<() => void>();

function set(next: CommentsState): void {
  state = next;
  listeners.forEach((l) => l());
}

export function useComments(): CommentsState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Only publish to ~/.zevet/comments when what agents would read has changed. */
let lastExport = "";

export function attachPresence(ctx: PresenceCtx): () => void {
  detach();
  const agents = new AgentPresence({
    Y: ctx.E.Y,
    Awareness: ctx.E.Awareness,
    awarenessProtocol: ctx.E.awarenessProtocol,
    ydoc: ctx.ydoc,
    awareness: ctx.awareness,
    send: ctx.sendAwareness,
  });
  active = { ctx, agents };
  lastExport = "";

  let queued = false;
  const refresh = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (active?.ctx !== ctx) return;
      const list = listComments(ctx.ydoc, ctx.E.Y);
      const byLine = new Map<number, { ids: string[]; resolved: boolean }>();
      for (const c of list) {
        if (c.line == null) continue;
        const g = byLine.get(c.line) || { ids: [], resolved: true };
        g.ids.push(c.id);
        g.resolved = g.resolved && Boolean(c.resolvedAt);
        byLine.set(c.line, g);
      }
      ctx.handle.setCommentMarkers?.([...byLine].map(([line, g]) => ({ line, ...g })));
      set({ room: ctx.room, comments: list, focus: state.room === ctx.room ? state.focus : [] });
      exportFile(ctx, list);
    });
  };
  const arr = ctx.ydoc.getArray(COMMENTS_KEY);
  const text = ctx.ydoc.getText("content");
  arr.observeDeep(refresh);
  text.observe(refresh);
  ctx.handle.onCommentClick = (ids) => set({ ...state, focus: ids });
  refresh();

  return detach;
}

function exportFile(ctx: PresenceCtx, list: Comment[]): void {
  try {
    const data = exportUnresolved(list, ctx.getText(), ctx.room);
    const key = JSON.stringify(data.comments);
    if (key === lastExport) return;
    lastExport = key;
    (window as any).zevetDoc?.comments?.(ctx.room, data);
  } catch {
    /* the file is a nicety; the shared doc is the truth */
  }
}

export function detach(): void {
  if (!active) return;
  const { ctx, agents } = active;
  active = null;
  agents.clear();
  try { ctx.handle.onCommentClick = null; } catch { /* view gone */ }
  set(EMPTY);
}

/**
 * An agent's write landed and was folded into the document. `payload.hints` is
 * what the hook spooled (client/hook.mjs); the range is found in the text AS IT
 * IS NOW, and anything that cannot be found exactly once is not shown.
 */
export function presenceDiskChanged(payload: { hints?: unknown[] }): void {
  if (!active) return;
  const { ctx, agents } = active;
  try {
    for (const r of agentRanges((payload.hints || []) as any, ctx.relPath, ctx.getText())) {
      agents.show(r, ctx.colorOf(r.actor));
    }
  } catch {
    /* presence must never break the editor */
  }
}

export function addAtCursor(text: string): string | null {
  if (!active || !text.trim()) return null;
  const { ctx } = active;
  const index = ctx.handle.view?.state?.selection?.main?.head ?? 0;
  return addComment(ctx.ydoc, ctx.E.Y, { author: ctx.me(), text: text.trim(), index });
}

export function reply(id: string, text: string): void {
  if (active && text.trim()) replyTo(active.ctx.ydoc, id, { author: active.ctx.me(), text: text.trim() });
}

export function resolve(id: string, resolved: boolean): void {
  if (active) setResolved(active.ctx.ydoc, id, resolved);
}

/** Scroll the editor to a comment's line. */
export function reveal(c: Comment): void {
  const v = active?.ctx.handle.view;
  if (!v || c.index == null) return;
  try {
    v.dispatch({ selection: { anchor: c.index }, scrollIntoView: true });
    v.focus();
  } catch { /* mid-update */ }
}
