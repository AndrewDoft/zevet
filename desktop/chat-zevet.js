// Zevet Chat's "Zevet" provider: a chat turn answered by the router
// (zevet-router.js) instead of one CLI. Contract: chat-claude.js.
//
// The router is the same one Code starts as agent "zevet"; it picks the rung
// per turn and falls to the next on a rate limit. Each rung is opened through
// the ordinary chat provider for its CLI (`inner`), so the folder posture,
// system prompt, Masora MCP and per-chat session binding are exactly what a
// direct pick of that CLI gets. The router tags every event with the CLI that
// produced it (`evt.agent`); replyOf/endsTurn read the payload with that CLI's.
"use strict";

const { startRouted } = require("./zevet-router.js");

/** Finished exchanges of a saved chat, as the router's handoff reads them. */
function turnsOf(messages) {
  const out = [];
  for (let i = 0; i + 1 < (messages || []).length; i += 2) {
    if (messages[i].role === "user" && messages[i + 1].role === "assistant") {
      out.push({ user: String(messages[i].text), answer: String(messages[i + 1].text) });
    }
  }
  return out;
}

function createZevetChat({ inner, ladder, isPrivate }) {
  const via = (evt) => inner[evt && evt.agent];
  return {
    id: "zevet-router",
    agent: "zevet",
    trainsOnPrompts: false, // the router keeps Muse (which may train) out of private folders and drops the brief for it
    replyOf: (p, evt) => (via(evt) ? via(evt).replyOf(p) : ""),
    endsTurn: (p, evt) => Boolean(via(evt) && via(evt).endsTurn(p)),
    open({ chat, mcpConfig, mode, effort, folder, env, onEvent }) {
      const routed = startRouted({
        id: chat.id,
        onEvent,
        ladder,
        isPrivate: isPrivate ? () => isPrivate(folder) : undefined,
        history: turnsOf(chat.messages),
        start: (rung, extra) =>
          inner[rung.agent].open({
            chat,
            mcpConfig: rung.agent === "claude" ? mcpConfig : null,
            model: rung.model,
            mode,
            effort,
            folder,
            env,
            onEvent: extra.onEvent,
          }),
      });
      // The router carries its own history, so `prior` stops here; the brief goes on.
      return { ...routed, send: (text, { brief = null } = {}) => routed.send(text, brief ? { brief } : undefined) };
    },
  };
}

module.exports = { createZevetChat, turnsOf };
