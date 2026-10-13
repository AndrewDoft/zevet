"use strict";
// Once-only claim on a tool call (OpenDots' pattern): (thread, toolCallId) is
// INSERT-OR-IGNORE into a file under userData, written before anything runs. The first
// claimer asks and executes; a later claim (retry, replay, restart) gets the stored
// outcome and is refused, so one tool call can never execute twice. Owner-only is
// unchanged: this only gates the local permit, a remote answer still goes through
// agent-approval.js and resolves that same permit.
// ponytail: single-process JSON file (one desktop app owns it); SQLite if two writers ever appear.

const fs = require("node:fs");
const path = require("node:path");

const MAX = 5000;
const keyOf = (thread, id) => `${thread}\u0000${id}`;

function createApprovalClaims(file) {
  let rows = {};
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    if (v && typeof v.claims === "object" && v.claims) rows = v.claims;
  } catch {
    // first run, or unreadable: start empty
  }
  function save() {
    const keys = Object.keys(rows);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete rows[k];
    const temp = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify({ version: 1, claims: rows }), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  }
  const store = {
    /** { first: true } for the one claimer; { first: false, outcome } for every later one. */
    claim(thread, id) {
      const k = keyOf(thread, id);
      if (rows[k]) return { first: false, outcome: rows[k].outcome };
      rows[k] = { outcome: "pending", at: Date.now() };
      save();
      return { first: true };
    },
    /** Record how the first claim ended ("approved" | "denied"). */
    settle(thread, id, outcome) {
      const k = keyOf(thread, id);
      if (!rows[k]) return;
      rows[k].outcome = outcome;
      save();
    },
    /** Wrap an onPermit handler: calls with a stable (run, toolUseId) run at most once. */
    guard(handler) {
      return (request) => {
        const r = request && typeof request === "object" ? request : {};
        const thread = typeof r.run === "string" ? r.run : "";
        const id = typeof r.toolUseId === "string" ? r.toolUseId : "";
        if (!thread || !id) return handler(request);
        const c = store.claim(thread, id);
        if (!c.first) return Promise.resolve({ ok: false, reason: `this tool call was already ${c.outcome === "pending" ? "asked once (outcome unknown)" : c.outcome}; not run again` });
        return Promise.resolve(handler(request)).then((answer) => {
          store.settle(thread, id, answer && answer.ok === true ? "approved" : "denied");
          return answer;
        });
      };
    },
  };
  return store;
}

module.exports = { createApprovalClaims };
