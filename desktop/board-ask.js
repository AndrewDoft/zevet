"use strict";
// Ask the board window to do something and wait for its answer. The control API
// (agent-api.js) uses it to start and message agents through the board's own
// actions, the way a person's Send does. null means nobody answered -- no
// window, or none within `timeoutMs` -- and the caller falls back.
const { randomUUID } = require("node:crypto");

function createBoardAsk({ send, timeoutMs = 10000 }) {
  const waiting = new Map();
  return {
    /** `send(reqId, kind, payload)` -> false when there is no window to send to. */
    ask(kind, payload) {
      const reqId = randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => { waiting.delete(reqId); resolve(null); }, timeoutMs);
        waiting.set(reqId, (r) => { clearTimeout(timer); resolve(r); });
        if (!send(reqId, kind, payload)) { clearTimeout(timer); waiting.delete(reqId); resolve(null); }
      });
    },
    reply(reqId, result) {
      const done = waiting.get(String(reqId));
      if (!done) return false;
      waiting.delete(String(reqId));
      done(result && typeof result === "object" ? result : { ok: false, error: "empty reply" });
      return true;
    },
  };
}

module.exports = { createBoardAsk };
