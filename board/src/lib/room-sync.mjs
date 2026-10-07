// The wire shared by every sealed doc-sync room (tasks:<team>, chat:<team>): one
// room, one state, nothing else. `doc` is the bridge (window.zevetDoc in the
// board, a DocSync adapter in the tests), so frames are sealed in the main
// process and the hub relays ciphertext only.
//
// Persistence is the room's: the hub replays its log to a late joiner, and every
// (re)connect answers "ready" with this client's whole state, so an offline
// edit or a restarted hub converges without a server-side copy.
//
// `model` is { empty, apply, merge, encode, decode }: the room's pure state.
export function createRoomSync({ doc, room, model, me, roleOf, now = Date.now, onChange = () => {} }) {
  let state = model.empty();
  const send = (bytes, opts) => doc.send(room, bytes, opts);

  const off = doc.onMessage((m) => {
    if (!m || m.room !== room) return;
    if (m.kind === "ready") send(model.encode(state));
    else if (m.kind === "snapshot-due") send(model.encode(state), { snapshot: true });
    else if (m.kind === "update" && m.bytes) {
      const delta = model.decode(m.bytes);
      if (!delta) return;
      const r = model.merge(state, delta, { roleOf });
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
    /** Run one local op under my current role; sends only on success. */
    do(op) {
      const r = model.apply(state, op, { by: me, role: roleOf(me), now });
      if (!r.ok) return r;
      state = r.state;
      send(model.encode(r.delta));
      onChange();
      return { ok: true };
    },
    close() {
      off();
      doc.leave?.(room);
    },
  };
}
