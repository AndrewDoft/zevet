"use strict";
// Ask the board window to do something and wait for its answer. The control API
// (agent-api.js) uses it to start and message agents through the board's own
// actions, the way a person's Send does. null means nobody answered -- no
// window, or none within `timeoutMs` -- and the caller falls back.
//
// TWO PHASES, so a slow start is never doubled. The board acknowledges at once
// ({accepted: true}); only a request nobody acknowledged falls back. Once
// accepted, the board's own start may take as long as it takes (a Masora brief
// fetch, a worktree) up to `finishMs`, and running out of THAT is an error, not
// a fallback -- falling back then would start the same agent a second time.
const { randomUUID } = require("node:crypto");

function createBoardAsk({ send, timeoutMs = 10000, finishMs = 180000 }) {
  const waiting = new Map();
  return {
    /** `send(reqId, kind, payload)` -> false when there is no window to send to. */
    ask(kind, payload) {
      const reqId = randomUUID();
      return new Promise((resolve) => {
        let timer = setTimeout(() => { waiting.delete(reqId); resolve(null); }, timeoutMs);
        const done = (r) => { clearTimeout(timer); resolve(r); };
        done.accept = () => {
          clearTimeout(timer);
          timer = setTimeout(() => { waiting.delete(reqId); resolve({ ok: false, error: "the board accepted it but did not finish" }); }, finishMs);
        };
        waiting.set(reqId, done);
        if (!send(reqId, kind, payload)) { clearTimeout(timer); waiting.delete(reqId); resolve(null); }
      });
    },
    reply(reqId, result) {
      const done = waiting.get(String(reqId));
      if (!done) return false;
      if (result && result.accepted === true) {
        done.accept();
        return true;
      }
      waiting.delete(String(reqId));
      done(result && typeof result === "object" ? result : { ok: false, error: "empty reply" });
      return true;
    },
  };
}

module.exports = { createBoardAsk };
