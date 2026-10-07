"use strict";
// Advisory path claims (D-070). Pure: main.js supplies the clock, the document
// key and the hub. A claim is a session's set of paths, sealed as ONE frame
// with the document key (doc-crypto) so the hub relays an opaque blob and sees
// only what it already sees on every event: who, and which session. A claim
// never blocks a write; it only feeds the overlap check and the board's chips.

const TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_PATHS = 200;

const norm = (p) => String(p || "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
const keyOf = (actor, session) => `${String(actor || "").toLowerCase()}\u0000${session}`;

/** GCM additional data: a sealed claim opens only for the session it names. */
const aadFor = (session) => `claim\u0000${session}`;

function sealClaim(docCrypto, key, session, entry) {
  const body = { repo: entry.repo || "", paths: entry.paths, expiresAt: entry.expiresAt };
  return docCrypto.seal(key, aadFor(session), Buffer.from(JSON.stringify(body), "utf8")).toString("base64");
}

/** The entry a frame carries, or null when it does not open or is malformed. */
function openClaim(docCrypto, key, frame) {
  try {
    const session = String(frame.session || "");
    const body = JSON.parse(docCrypto.open(key, aadFor(session), Buffer.from(String(frame.claim || ""), "base64")).toString("utf8"));
    const paths = Array.isArray(body.paths) ? body.paths.map(norm).filter(Boolean).slice(0, MAX_PATHS) : [];
    if (!session || !paths.length || !Number.isFinite(body.expiresAt)) return null;
    return { actor: String(frame.actor || ""), session, repo: String(body.repo || ""), paths, expiresAt: body.expiresAt };
  } catch {
    return null;
  }
}

/** What goes to the hub for one session: the sealed set, or a release. */
function claimBody(docCrypto, key, actor, session, entry) {
  if (!entry) return { kind: "claim", actor, session, release: true };
  return { kind: "claim", actor, session, claim: sealClaim(docCrypto, key, session, entry) };
}

class ClaimStore {
  #by = new Map();
  /** broadcast(actor, session, entryOrNull) runs after each change of MY claims. */
  constructor({ now = () => Date.now(), broadcast = () => {}, timeoutMs = TIMEOUT_MS } = {}) {
    this.now = now;
    this.broadcast = broadcast;
    this.timeoutMs = timeoutMs;
  }
  claim({ paths, path, session, actor = "", repo = "", timeoutMs = this.timeoutMs }) {
    const add = (paths || [path]).map(norm).filter(Boolean);
    if (!session || !add.length) return null;
    const k = keyOf(actor, session);
    const prev = this.#by.get(k);
    const merged = [...new Set([...(prev ? prev.paths : []), ...add])].slice(-MAX_PATHS);
    const entry = { actor: String(actor), session: String(session), repo: String(repo || (prev && prev.repo) || ""), paths: merged, expiresAt: this.now() + Math.min(Math.max(timeoutMs, 1000), MAX_TIMEOUT_MS) };
    this.#by.set(k, entry);
    this.broadcast(entry.actor, entry.session, entry);
    return entry;
  }
  /** One path, or every path when `path` is omitted. */
  release({ session, path }) {
    for (const prev of [...this.#by.values()]) {
      if (prev.session !== session) continue;
      const k = keyOf(prev.actor, session);
      const left = path == null ? [] : prev.paths.filter((p) => p !== norm(path));
      if (left.length) {
        const entry = { ...prev, paths: left };
        this.#by.set(k, entry);
        this.broadcast(entry.actor, session, entry);
      } else {
        this.#by.delete(k);
        this.broadcast(prev.actor, session, null);
      }
    }
  }
  /** The session ended: everything it claimed goes, for me and for teammates. */
  endSession(session) {
    this.release({ session });
  }
  clear() {
    this.#by.clear();
  }
  /** Teammate side: take or drop an entry received from the hub. Never broadcasts. */
  put(entry) {
    this.#by.set(keyOf(entry.actor, entry.session), entry);
  }
  drop(actor, session) {
    this.#by.delete(keyOf(actor, session));
  }
  /** True when something expired. */
  expire() {
    let any = false;
    for (const e of [...this.#by.values()]) {
      if (e.expiresAt > this.now()) continue;
      any = true;
      this.#by.delete(keyOf(e.actor, e.session));
      this.broadcast(e.actor, e.session, null);
    }
    return any;
  }
  isClaimed(path) {
    return this.claims().some((e) => e.paths.includes(norm(path)));
  }
  claims() {
    this.expire();
    return [...this.#by.values()];
  }
}

/** One frame from the hub's channel into the teammates' store. Returns true when
 *  something changed. `isMine(session)` drops my own frames coming back round. */
function applyFrame(store, name, data, { docCrypto, key, isMine = () => false }) {
  if (name === "hello") {
    // A fresh connection replays every live claim; start from none so a
    // release missed while offline cannot linger.
    store.clear();
    return true;
  }
  if ((name !== "claim" && name !== "claim-release") || !data || isMine(String(data.session || ""))) return false;
  if (name === "claim-release") {
    store.drop(data.actor, data.session);
    return true;
  }
  const entry = openClaim(docCrypto, key, data);
  if (entry) store.put(entry);
  return Boolean(entry);
}

/** Claims as the overlap check's `active` rows: a path-only agent. `skip` is the
 *  session the prompt is going to (its own claims are not a conflict) and `repo`
 *  keeps `src/db.ts` in one repo from colliding with another's. */
function claimsAsActive(entries, { skip = "", repo = "" } = {}) {
  return entries
    .filter((e) => e.session !== skip && (!repo || !e.repo || e.repo.toLowerCase() === repo.toLowerCase()))
    .map((e) => ({ actor: e.actor, session: e.session, branch: "", openPaths: e.paths, plannedPaths: [], task: "", claimed: true }));
}

module.exports = { applyFrame, ClaimStore, claimBody, openClaim, sealClaim, claimsAsActive, aadFor, TIMEOUT_MS, MAX_TIMEOUT_MS, MAX_PATHS };
