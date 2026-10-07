// The team chat's wire: the shared room sync (room-sync.mjs) over the chat model.
import { apply, decode, emptyState, encode, merge, messages, roomName } from "./team-chat.mjs";
import { createRoomSync } from "./room-sync.mjs";

const model = { empty: emptyState, apply, merge, encode, decode };

export function createChatSync({ team, ...rest }) {
  const sync = createRoomSync({ ...rest, room: roomName(team), model });
  return {
    room: sync.room,
    joined: sync.joined,
    get state() {
      return sync.state;
    },
    messages: () => messages(sync.state),
    do: sync.do,
    close: sync.close,
  };
}
