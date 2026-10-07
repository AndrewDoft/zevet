"use strict";
// Cross-machine approval cards, executing side (D-NEXT-W2-8). No Electron in
// here so node --test can drive all of it; main.js supplies the permit promise,
// the hub calls and the board.
//
// An agent on THIS machine asks permission. We publish a sealed card, a teammate
// who is an Editor may answer it through the hub, and the hub relays the sealed
// answer back here. THIS module decides whether it authorises anything:
//
//   • an answer is for EXACTLY the pending prompt: its sealed body must carry
//     the card's secret nonce and the hash of this prompt's tool + arguments,
//     which we recompute from our own copy, never from the answer;
//   • it works ONCE: the prompt is settled by the first applied answer and its
//     id is remembered, so a replayed frame finds nothing to settle;
//   • a remote answer can allow or deny this one call. It can never say
//     "always allow" (the resolved answer never carries `always`);
//   • the person at this machine always wins: a remote answer is held for
//     REMOTE_HOLD_MS before it is applied, and a local click inside that window
//     cancels it. With team policy `ask` a remote answer is only shown, never
//     applied: the person clicks.
//
// Nothing here trusts the hub's word for who answered beyond the display name.

const path = require("node:path");
const { createHash, randomBytes } = require("node:crypto");

const REMOTE_HOLD_MS = 1500;
const PENDING_TTL_MS = 120 * 1000; // the ask-server denies at the same moment
const INFLIGHT_MS = 30 * 1000; // an approval this recent may still be running
const SEEN_MAX = 1000;

let docCryptoModule;
/** Same lookup rule as agent-steer.js: the app's OWN copy of doc-crypto.mjs. */
function loadDocCrypto() {
  if (docCryptoModule !== undefined) return docCryptoModule;
  docCryptoModule = null;
  const out = [path.join(__dirname, "client", "doc-crypto.mjs")];
  if (process.resourcesPath) out.push(path.join(process.resourcesPath, "client", "doc-crypto.mjs"));
  out.push(path.join(__dirname, "..", "client", "doc-crypto.mjs"));
  for (const p of out) {
    try {
      docCryptoModule = require(p);
      break;
    } catch {
      // next
    }
  }
  return docCryptoModule;
}

/** Stable JSON: object keys sorted, so the same call hashes the same anywhere. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v === undefined ? null : v);
}

/** The identity of one action: this tool with these arguments. */
function actionHash(tool, args) {
  return createHash("sha256").update(canonical([String(tool || ""), args === undefined ? null : args])).digest("hex");
}

const cardAad = ({ id, session }) => `approval-card\u0000${id}\u0000${session}`;
const answerAad = ({ id, session, hash }) => `approval-answer\u0000${id}\u0000${session}\u0000${hash}`;

const sealJson = (docCrypto, key, aad, obj) => docCrypto.seal(key, aad, Buffer.from(JSON.stringify(obj), "utf8")).toString("base64");
const openJson = (docCrypto, key, aad, sealed) => JSON.parse(docCrypto.open(key, aad, Buffer.from(String(sealed || ""), "base64")).toString("utf8"));

const sealCard = (docCrypto, key, meta, card) => sealJson(docCrypto, key, cardAad(meta), card);
const openCard = (docCrypto, key, meta, sealed) => openJson(docCrypto, key, cardAad(meta), sealed);
/** The answerer echoes the card's nonce and hash; both bind into the AAD/body. */
const sealAnswer = (docCrypto, key, meta, ans) => sealJson(docCrypto, key, answerAad(meta), ans);
const openAnswer = (docCrypto, key, meta, sealed) => openJson(docCrypto, key, answerAad(meta), sealed);

/** Cap what a card shows: a prompt can carry a whole file. */
function clip(v, max = 3000) {
  const s = typeof v === "string" ? v : canonical(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * `deps`:
 *   publish(card) -> Promise<{ ok, status? }>   POST /api/approval/open
 *   report(id, status, via, reason) -> Promise  POST /api/approval/status
 *   openAnswer(frame, hash, session) -> object  throws when it does not open
 *   advise({ id, by, decision }) -> void        policy `ask`: show, don't apply
 * Options: { holdMs, ttlMs, inflightMs, now }.
 */
function createApprovalHost(deps, { holdMs = REMOTE_HOLD_MS, ttlMs = PENDING_TTL_MS, inflightMs = INFLIGHT_MS, now = Date.now } = {}) {
  const pending = new Map(); // id -> record
  const settled = new Set(); // ids that have been answered once
  const inflight = new Map(); // id -> at, approved and possibly still running
  const report = (id, status, via = "remote", reason = "") => Promise.resolve(deps.report(id, status, via, reason)).catch(() => {});

  function forget(p) {
    clearTimeout(p.hold);
    clearTimeout(p.ttl);
    pending.delete(p.id);
    settled.add(p.id);
    if (settled.size > SEEN_MAX) settled.delete(settled.values().next().value);
  }

  function release(p, allow, via, by) {
    forget(p);
    if (allow) {
      inflight.set(p.id, now());
      if (inflight.size > SEEN_MAX) inflight.delete(inflight.keys().next().value);
    }
    // `always` is deliberately absent: one answer, one action.
    p.resolve({ ok: allow, reason: allow ? "" : via === "remote" ? `denied by ${by}` : "refused" });
    return report(p.id, allow ? "approved" : "denied", via);
  }

  return {
    /** A permit just arrived on this machine. Returns the card id, or "" when
     *  it cannot be shared (no key); either way the local prompt is unaffected. */
    begin({ id, tool, arguments: args, session, agent = "", repo = "", resolve, canShare = true }) {
      const hash = actionHash(tool, args);
      const p = { id, hash, tool, session, nonce: randomBytes(16).toString("hex"), resolve, hold: null, ttl: null, advice: null };
      pending.set(id, p);
      p.ttl = setTimeout(() => {
        if (!pending.has(id)) return;
        forget(p);
        void report(id, "expired", "local", "nobody answered in time");
      }, ttlMs);
      if (p.ttl.unref) p.ttl.unref();
      if (canShare) {
        let sealed;
        try {
          sealed = deps.sealCard({ id, session }, { tool: String(tool || ""), arguments: clip(args), hash, nonce: p.nonce, agent, repo });
        } catch {
          sealed = "";
        }
        if (sealed) {
          Promise.resolve(deps.publish({ id, session, repo, sealed })).catch(() => {});
        }
      }
      return id;
    },

    /** The person at this machine answered (through the board). Always wins. */
    local(id, allow) {
      const p = pending.get(id);
      if (!p) return false;
      const overrode = Boolean(p.hold);
      forget(p);
      if (allow) inflight.set(id, now());
      void report(id, allow ? "approved" : "denied", "local", overrode ? "answered here first" : "");
      return true;
    },

    /** A relayed remote answer. Resolves to what became of it. */
    remote(frame) {
      const f = frame && typeof frame === "object" ? frame : {};
      const id = typeof f.id === "string" ? f.id : "";
      const p = pending.get(id);
      if (!p) return settled.has(id) ? "replay" : "unknown-id";
      if (p.hold) return "replay"; // already accepted, applying
      let ans;
      try {
        ans = deps.openAnswer(f, p.hash, p.session);
      } catch {
        void report(id, "invalid", "remote", "it did not open here");
        return "invalid";
      }
      const decision = f.decision === "allow" || f.decision === "deny" ? f.decision : "";
      // Everything must agree: the sealed body (this nonce, this action's hash)
      // and the decision bit the hub relays in the clear.
      if (!ans || ans.nonce !== p.nonce || ans.hash !== p.hash || !decision || ans.decision !== decision) {
        void report(id, "invalid", "remote", "it was for a different action");
        return "invalid";
      }
      const by = String(f.by || "a teammate").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 40);
      if (f.confirm !== false) {
        // Policy `ask` (or a frame missing the flag: the safe reading). Show it; don't apply it.
        p.advice = { by, decision };
        if (deps.advise) deps.advise({ id, by, decision });
        void report(id, "held", "remote", "waiting for the owner");
        return "held";
      }
      p.hold = setTimeout(() => {
        if (pending.get(id) === p) void release(p, decision === "allow", "remote", by);
      }, holdMs);
      if (p.hold.unref) p.hold.unref();
      return "accepted";
    },

    /** The app is going away or the channel dropped. Unanswered prompts never
     *  ran; an approval released moments ago may have — that one is unknown. */
    interrupt(reason = "this app closed") {
      const out = { expired: [], unknown: [] };
      for (const p of [...pending.values()]) {
        forget(p);
        out.expired.push(p.id);
        void report(p.id, "expired", "local", reason);
      }
      for (const [id, at] of [...inflight]) {
        inflight.delete(id);
        if (now() - at < inflightMs) {
          out.unknown.push(id);
          void report(id, "unknown", "local", reason);
        }
      }
      return out;
    },

    has: (id) => pending.has(id),
    size: () => pending.size,
  };
}

module.exports = { createApprovalHost, actionHash, sealCard, openCard, sealAnswer, openAnswer, loadDocCrypto, REMOTE_HOLD_MS, _internals: { canonical, answerAad, cardAad, clip } };
