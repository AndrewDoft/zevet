export interface RoomDoc {
  join: (room: string) => unknown;
  send: (room: string, bytes: Uint8Array, opts?: { snapshot?: boolean }) => unknown;
  leave?: (room: string) => unknown;
  onMessage: (fn: (m: { room?: string; kind?: string; bytes?: Uint8Array }) => void) => () => void;
}
type Role = "viewer" | "commenter" | "editor" | "owner";
export interface RoomModel<S, O, D = S> {
  empty: () => S;
  apply: (state: S, op: O, o: { by: string; role: Role | null | undefined; now?: () => number }) => { ok: true; state: S; delta: D } | { ok: false; error: string; role?: Role | null };
  merge: (state: S, delta: D, o: { roleOf: (login: string) => Role | null | undefined }) => { state: S; changed: boolean };
  encode: (d: S | D) => Uint8Array;
  decode: (bytes: Uint8Array) => D | null;
}
export function createRoomSync<S, O, D = S>(o: { doc: RoomDoc; room: string; model: RoomModel<S, O, D>; me: string; roleOf: (login: string) => Role | null | undefined; now?: () => number; onChange?: () => void }): {
  room: string;
  joined: unknown;
  readonly state: S;
  do: (op: O) => { ok: true } | { ok: false; error: string };
  close: () => void;
};
