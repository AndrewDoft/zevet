/**
 * Team chat's live state for the React side: one chat-sync per team, joined on
 * first use. Roles come from the same hub whoami table the task board reads.
 */
import { useSyncExternalStore } from "react";
import { bridge } from "./bridge";
import { useBoard } from "./board";
import { createChatSync } from "./team-chat-sync.mjs";
import { countByCard, newId, readMark, unread, type Msg, type Op } from "./team-chat.mjs";
import { roleTable } from "./tasks-room";

/* eslint-disable @typescript-eslint/no-explicit-any */
let sync: ReturnType<typeof createChatSync> | null = null;
let syncTeam = "";
let snapshot: { messages: Msg[]; unread: number; byCard: Record<string, number>; error: string } = { messages: [], unread: 0, byCard: {}, error: "" };
const listeners = new Set<() => void>();

const markKey = () => `zevet.chat.lastRead.${syncTeam}`;
function lastRead(): number {
  try {
    return Number(localStorage.getItem(markKey())) || 0;
  } catch {
    return 0;
  }
}
const emit = (error = snapshot.error) => {
  snapshot = sync
    ? { messages: sync.messages(), unread: unread(sync.state, lastRead(), roleTable().me), byCard: countByCard(sync.state), error }
    : { messages: [], unread: 0, byCard: {}, error };
  listeners.forEach((l) => l());
};

/** Join the team's chat room (safe to call on every render). */
export function ensureChat(): void {
  const who = useBoard.getState().who.state;
  const team = who?.team || "";
  if (!bridge.canShare || !team || !who?.login) return;
  if (sync && syncTeam === team) return;
  closeChat();
  const me = roleTable().me;
  // Re-read on every call, so a demotion takes effect on the next post.
  sync = createChatSync({ doc: (window as any).zevetDoc, team, me, roleOf: (l) => (String(l).toLowerCase().replace(/^@/, "") === me ? roleTable().mine() : roleTable().roleOf(l)), onChange: () => emit() });
  syncTeam = team;
  emit();
}

export function closeChat(): void {
  sync?.close();
  sync = null;
  syncTeam = "";
  emit("");
}

export function useChat() {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => snapshot,
  );
}

/** Post one message; the returned string is the refusal, shown as-is, or "". */
export function postChat(text: string, extra: { replyTo?: string; cardId?: string } = {}): string {
  if (!sync) return "not connected";
  const op: Op = { op: "post", id: newId(), text, ...extra };
  const r = sync.do(op);
  if (r.ok) markRead();
  else emit(r.error);
  return r.ok ? "" : r.error;
}

/** Everything shown counts as read. */
export function markRead(): void {
  if (!sync) return;
  try {
    localStorage.setItem(markKey(), String(readMark(sync.state)));
  } catch {
    /* no storage: the badge stays until reload */
  }
  emit("");
}
