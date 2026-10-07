/**
 * The task board's live state for the React side: one tasks-sync per team,
 * joined on first use. Roles come from the hub's whoami (`role`, `people[].role`);
 * nothing here is a second source of truth for who may do what.
 */
import { useSyncExternalStore } from "react";
import { bridge } from "./bridge";
import { useBoard } from "./board";
import { createTasksSync } from "./tasks-sync.mjs";
import { newId, type Card, type Op, type Role } from "./tasks.mjs";

/* eslint-disable @typescript-eslint/no-explicit-any */
let sync: ReturnType<typeof createTasksSync> | null = null;
let syncTeam = "";
let snapshot: { cards: Card[]; error: string } = { cards: [], error: "" };
const listeners = new Set<() => void>();
const emit = (error = snapshot.error) => {
  snapshot = { cards: sync ? sync.cards() : [], error };
  listeners.forEach((l) => l());
};

const clean = (n: unknown) => String(n || "").toLowerCase().replace(/^@/, "");

/** The people the hub reports, keyed by login and every linked name. Read live. */
export function roleTable(): { me: string; roleOf: (login: string) => Role | null; mine: () => Role | null } {
  const who = useBoard.getState().who.state;
  const me = clean(who?.login);
  const table = new Map<string, Role>();
  for (const p of who?.people || []) {
    for (const n of [p.login, ...(p.aliases || []), ...(p.identities || []).map((i) => i.login)]) {
      if (n) table.set(clean(n), (p.role || "editor") as Role);
    }
  }
  return { me, roleOf: (l) => table.get(clean(l)) || null, mine: () => ((who?.role as Role) || table.get(me) || null) };
}

export function myRole(): Role | null {
  return roleTable().mine();
}

/** Join the team's task room (safe to call on every render). */
export function ensureTasks(): void {
  const who = useBoard.getState().who.state;
  const team = who?.team || "";
  if (!bridge.canShare || !team || !who?.login) return;
  if (sync && syncTeam === team) return;
  closeTasks();
  const doc = (window as any).zevetDoc;
  const me = roleTable().me;
  // Re-read on every call, so a demotion takes effect on the next action.
  sync = createTasksSync({ doc, team, me, roleOf: (l) => (clean(l) === me ? roleTable().mine() : roleTable().roleOf(l)), onChange: () => emit() });
  syncTeam = team;
  emit();
}

export function closeTasks(): void {
  sync?.close();
  sync = null;
  syncTeam = "";
  emit("");
}

export function useTasks() {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => snapshot,
  );
}

/** Run one op; the returned string is the refusal, shown as-is, or "". */
export function doTask(op: Op): string {
  if (!sync) return "not connected";
  const r = sync.do(op);
  emit(r.ok ? "" : r.error);
  return r.ok ? "" : r.error;
}

export { newId };
