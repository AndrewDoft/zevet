// The task board's wire: one doc-sync room, one state, nothing else. `doc` is
// the bridge (window.zevetDoc in the board, a DocSync adapter in the tests), so
// frames are sealed in the main process and the hub relays ciphertext only.
//
// Persistence is the room's: the hub replays its log to a late joiner, and every
// (re)connect answers "ready" with this client's whole state, so an offline
// edit or a restarted hub converges without a server-side copy.
import { apply, cards, decode, emptyState, encode, merge, roomName } from "./tasks.mjs";

export function createTasksSync({ doc, team, me, roleOf, now = Date.now, onChange = () => {} }) {
  const room = roomName(team);
  let state = emptyState();
  const send = (bytes, opts) => doc.send(room, bytes, opts);

  const off = doc.onMessage((m) => {
    if (!m || m.room !== room) return;
    if (m.kind === "ready") send(encode(state));
    else if (m.kind === "snapshot-due") send(encode(state), { snapshot: true });
    else if (m.kind === "update" && m.bytes) {
      const delta = decode(m.bytes);
      if (!delta) return;
      const r = merge(state, delta, { roleOf });
      if (r.changed) {
        state = r.state;
        onChange();
      }
    }
  });
  const joined = doc.join(room);

  return {
    room,
    joined,
    get state() {
      return state;
    },
    cards: () => cards(state),
    /** Run one local op under my current role; sends only on success. */
    do(op) {
      const r = apply(state, op, { by: me, role: roleOf(me), now });
      if (!r.ok) return r;
      state = r.state;
      send(encode(r.delta));
      onChange();
      return { ok: true };
    },
    close() {
      off();
      doc.leave?.(room);
    },
  };
}
