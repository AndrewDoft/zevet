// Zevet Chat's first model provider: the Claude CLI Zevet Code already
// drives, headless, from the chat's neutral folder (flags: chat.js).
//
// THE PROVIDER CONTRACT, so another model is one more file like this one and
// the thread UI never changes:
//
//   id                 stable name, stored on every assistant message
//   trainsOnPrompts    true = main.js skips the Masora brief step for it
//   open({ chat, mcpConfig, onEvent })
//     -> { ok: true, send(text, { brief, prior }), stop() } | { ok: false, error }
//   onEvent(evt)       evt is { type: "agent", payload } with payload in the
//                      claude stream-json shape the board already renders
//                      (`system`/init {model}, `stream_event` text_delta,
//                      `assistant`, `result`), or { type: "exit", code, ... }.
//
// A provider that speaks another wire format translates to those payloads;
// board/src/lib/chat-stream.mjs is the only reader.
"use strict";

const chats = require("./chat.js");

function createClaudeCli({ startConsole }) {
  return {
    id: "claude-cli",
    trainsOnPrompts: false,
    open({ chat, mcpConfig, onEvent }) {
      // This machine's session for the chat. With history but no session
      // here (a handed-over chat), the first send replays it.
      const sess = chats.session(chat.id);
      let replay = !sess.started;
      const started = startConsole({
        agent: "claude",
        cwd: chats.dirOf(chat.id),
        args: chats.chatArgs({ sessionId: sess.sessionId, started: sess.started, mcpConfig }),
        onEvent: (evt) => {
          const p = evt && evt.type === "agent" ? evt.payload : null;
          if (p && p.type === "system" && p.subtype === "init") chats.markStarted(chat.id);
          onEvent(evt);
        },
      });
      if (!started.ok) return { ok: false, error: started.error };
      return {
        ok: true,
        send(text, { brief = null, prior = null } = {}) {
          const history = replay ? prior : null;
          replay = false;
          return started.send(chats.composeTurn(text, brief, history));
        },
        stop: () => started.stop(),
      };
    },
  };
}

module.exports = { createClaudeCli };
