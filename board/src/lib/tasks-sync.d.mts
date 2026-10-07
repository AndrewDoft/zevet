import type { Card, Op, Role, TaskState } from "./tasks.mjs";
export interface TaskDoc {
  join: (room: string) => unknown;
  send: (room: string, bytes: Uint8Array, opts?: { snapshot?: boolean }) => unknown;
  leave?: (room: string) => unknown;
  onMessage: (fn: (m: { room?: string; kind?: string; bytes?: Uint8Array }) => void) => () => void;
}
export function createTasksSync(o: { doc: TaskDoc; team: string; me: string; roleOf: (login: string) => Role | null | undefined; now?: () => number; onChange?: () => void }): {
  room: string;
  joined: unknown;
  readonly state: TaskState;
  cards: () => Card[];
  do: (op: Op) => { ok: true } | { ok: false; error: string };
  close: () => void;
};
