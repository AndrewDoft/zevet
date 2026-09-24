// Zevet Chat's other providers: the codex and opencode CLIs Zevet Code
// already drives (agent-console.js), run headless from the chat's folder.
// Contract: chat-claude.js.
//
// ONE-SHOT. Both CLIs read the prompt to EOF and exit (agent-console.js facts
// 4 and 5), so a turn is a process: main.js opens a new one per send, and the
// conversation continues through the CLI's own session id, captured off the
// stream and kept per chat and folder (chat.js § agentSession):
//
//   codex     {"type":"thread.started","thread_id":…}     -> `exec resume <id>`
//   opencode  `sessionID` on every event                   -> `run -s <id>`
//
// Argv is agent-console.js `invocationFor` — the one Code uses — so the model
// flag, the posture flags and the resume shape are not restated here.
"use strict";

const chats = require("./chat.js");
const { invocationFor } = require("./agent-console.js");

const trim = (v) => (typeof v === "string" ? v : "");

/** The session id a payload announces, or "". */
function sessionIdOf(agent, p) {
  if (!p || typeof p !== "object") return "";
  if (agent === "codex") return p.type === "thread.started" ? trim(p.thread_id) : "";
  return trim(p.sessionID);
}

/** The reply text a payload carries, or "". */
function replyOf(agent, p) {
  if (!p || typeof p !== "object") return "";
  if (agent === "codex") {
    return p.type === "item.completed" && p.item && p.item.type === "agent_message" ? trim(p.item.text) : "";
  }
  return p.type === "text" && p.part && p.part.type === "text" ? trim(p.part.text) : "";
}

/** Chat with no folder must not touch files: the CLIs' most restrictive posture
 *  (`plan`: codex read-only sandbox, opencode's ask-first default). */
function modeFor(folder, mode) {
  return folder ? mode || "auto" : "plan";
}

function createCli({ agent, id, startConsole }) {
  return {
    id,
    agent,
    trainsOnPrompts: false,
    replyOf: (p) => replyOf(agent, p),
    endsTurn: () => false,
    open({ chat, model, mode, folder, env, onEvent }) {
      const cwd = folder || chats.dirOf(chat.id);
      const resumeFrom = chats.agentSession(chat.id, agent, cwd);
      const started = startConsole({
        agent,
        cwd,
        env,
        // opencode takes its directory from $PWD when one is set, ahead of the
        // process cwd (measured 2026-09-24: a run spawned in a chat's folder
        // from a shell wrote to the shell's). `--dir` is in `opencode run --help`.
        args: [...invocationFor(agent, { model, mode: modeFor(folder, mode), resumeFrom }), ...(agent === "opencode" ? ["--dir", cwd] : [])],
        onEvent: (evt) => {
          const p = evt && evt.type === "agent" ? evt.payload : null;
          const sid = sessionIdOf(agent, p);
          if (sid) chats.bindAgentSession(chat.id, agent, sid, cwd);
          onEvent(evt);
        },
      });
      if (!started.ok) return { ok: false, error: started.error };
      let replay = !resumeFrom;
      return {
        ok: true,
        send(text, { brief = null, prior = null } = {}) {
          const fresh = replay;
          replay = false;
          return started.send(chats.composeTurn(text, brief, fresh ? prior : null, fresh ? (folder ? chats.WORK_PROMPT : chats.SYSTEM_PROMPT) : null));
        },
        stop: () => started.stop(),
      };
    },
  };
}

module.exports = { createCli, sessionIdOf, replyOf, modeFor };
