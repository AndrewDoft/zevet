import type { Card, Op, Role, TaskState } from "./tasks.mjs";
import type { RoomDoc } from "./room-sync.mjs";
export type TaskDoc = RoomDoc;
export function createTasksSync(o: { doc: TaskDoc; team: string; me: string; roleOf: (login: string) => Role | null | undefined; now?: () => number; onChange?: () => void }): {
  room: string;
  joined: unknown;
  readonly state: TaskState;
  cards: () => Card[];
  do: (op: Op) => { ok: true } | { ok: false; error: string };
  close: () => void;
};
