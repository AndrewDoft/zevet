"use strict";
// Plan-step ownership (D-087). One owner per (session, step text); the
// FIRST claim wins. Pure like claims.js: main.js supplies the clock and the
// doc-sync room sender (the room seals it, the hub relays ciphertext).
//
// Across machines the order is decided by (at, actor): every machine converges
// on the earliest claim, so a loser that briefly believed it had won is
// corrected when the winner's frame arrives. Advisory, like path claims.

const TTL_MS = 4 * 60 * 60 * 1000;
const MAX = 500;
const room = (repo) => `steps:${String(repo || "").replace(/[^A-Za-z0-9._-]/g, "_") || "_"}`;
const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 200);
const keyOf = (session, step) => `${session}\u0000${norm(step)}`;
const earlier = (a, b) => a.at < b.at || (a.at === b.at && a.actor < b.actor);

function createStepClaims({ now = () => Date.now(), send = () => {}, onChange = () => {} } = {}) {
  const by = new Map();
  const live = () => {
    for (const [k, e] of by) if (now() - e.at > TTL_MS) by.delete(k);
  };
  return {
    room,
    /** {ok:true, claim} for the first claimant (or the same actor again); {ok:false, holder} otherwise. */
    claim({ repo = "", session, step, actor }) {
      live();
      const s = String(session || "");
      const text = String(step || "").trim().slice(0, 200);
      const who = String(actor || "").trim().slice(0, 40);
      if (!s || !text || !who) return { ok: false, error: "session, step and an actor are required" };
      const have = by.get(keyOf(s, text));
      if (have) return have.actor.toLowerCase() === who.toLowerCase() ? { ok: true, claim: have, already: true } : { ok: false, holder: have.actor, claim: have };
      const claim = { repo: String(repo), session: s, step: text, actor: who, at: now() };
      by.set(keyOf(s, text), claim);
      while (by.size > MAX) by.delete(by.keys().next().value);
      send(room(repo), Buffer.from(JSON.stringify(claim), "utf8"));
      onChange();
      return { ok: true, claim };
    },
    /** A teammate's claim, already opened by doc-sync. The earlier of two wins. */
    applyRemote(bytes) {
      let c;
      try {
        c = JSON.parse(Buffer.from(bytes).toString("utf8"));
      } catch {
        return false;
      }
      if (!c || typeof c.session !== "string" || typeof c.step !== "string" || typeof c.actor !== "string" || !Number.isFinite(c.at)) return false;
      live();
      const next = { repo: String(c.repo || ""), session: c.session, step: c.step.slice(0, 200), actor: c.actor.slice(0, 40), at: c.at };
      const have = by.get(keyOf(next.session, next.step));
      if (have && !earlier(next, have)) return false;
      by.set(keyOf(next.session, next.step), next);
      onChange();
      return true;
    },
    ownerOf(session, step) {
      live();
      const e = by.get(keyOf(session, step));
      return e ? e.actor : "";
    },
    all() {
      live();
      return [...by.values()].map((e) => ({ session: e.session, step: e.step, actor: e.actor, repo: e.repo }));
    },
  };
}

module.exports = { createStepClaims, room, norm, TTL_MS };
