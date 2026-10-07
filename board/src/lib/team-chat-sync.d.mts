import type { Msg, Op, Role, ChatState } from "./team-chat.mjs";
import type { RoomDoc } from "./room-sync.mjs";
export function createChatSync(o: { doc: RoomDoc; team: string; me: string; roleOf: (login: string) => Role | null | undefined; now?: () => number; onChange?: () => void }): {
  room: string;
  joined: unknown;
  readonly state: ChatState;
  messages: () => Msg[];
  do: (op: Op) => { ok: true } | { ok: false; error: string };
  close: () => void;
};
