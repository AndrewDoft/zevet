// Zevet Chat's first model provider: the Claude CLI Zevet Code already
// drives, headless, from the chat's neutral folder (flags: chat.js).
//
// THE PROVIDER CONTRACT, so another model is one more file like this one and
// the thread UI never changes:
//
//   id                 stable name, stored on every assistant message
//   trainsOnPrompts    true = main.js skips the Masora brief step for it
//   agent              the CLI name agent-console.js knows: claude|codex|opencode
//   open({ chat, mcpConfig, model, mode, folder, env, onEvent })
//     -> { ok: true, send(text, { brief, prior }), stop() } | { ok: false, error }
//   replyOf(payload)   the text of the reply a payload carries, or ""
//   endsTurn(payload)  true when the payload is the end of a turn (claude's
//                      `result`; the one-shot CLIs end with their process)
//   onEvent(evt)       evt is { type: "agent", payload } in the CLI's OWN
//                      shape, or { type: "exit", code, ... }. The board reads
//                      it with the `agent` it sent the turn to: the same
//                      transcript.mjs Code uses, so there is one reader.
//
// `folder` is what makes a chat a WORK chat: the agent runs there with its
// tools. Without one it runs in the chat's neutral folder and cannot touch
// anything (claude: tools off; the others: their read-only posture).
"use strict";

const chats = require("./chat.js");

function createClaudeCli({ startConsole }) {
  return {
    id: "claude-cli",
    agent: "claude",
    trainsOnPrompts: false,
    replyOf(p) {
      return p && p.type === "assistant" && p.message && Array.isArray(p.message.content)
        ? p.message.content.filter((b) => b && b.type === "text").map((b) => b.text).join("")
        : "";
    },
    endsTurn: (p) => Boolean(p && p.type === "result"),
    open({ chat, mcpConfig, model, mode, folder, env, onEvent }) {
      // This machine's session for the chat, from where it runs. With history
      // but no session here (a handed-over chat, or a new folder), the first
      // send replays it.
      const cwd = folder || chats.dirOf(chat.id);
      const sess = chats.session(chat.id, cwd);
      let replay = !sess.started;
      const started = startConsole({
        agent: "claude",
        cwd,
        env,
        args: chats.chatArgs({ sessionId: sess.sessionId, started: sess.started, mcpConfig, model, mode, work: Boolean(folder) }),
        onEvent: (evt) => {
          const p = evt && evt.type === "agent" ? evt.payload : null;
          if (p && p.type === "system" && p.subtype === "init") chats.markStarted(chat.id, cwd);
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
