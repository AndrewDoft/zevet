"use strict";
// Pinned memory (D-NEXT-W2-10): a note about one file, written against the
// hash the file had at the time. When the file's hash moves the note is STALE,
// and the board says so; a person can edit or retire it. Item 9's agent tool
// "record memory" calls create() here and nothing else.
//
// Pure like claims.js: main.js supplies the doc key, the clock and the room
// sender. Every note is sealed with the document key (doc-crypto), on disk and
// on the wire, so the hub relays ciphertext and learns neither path nor text.
// Staleness is computed HERE, from the working tree, never by the hub (which
// could not: it sees no path and no hash).
//
// PUBLIC API
//   const mem = createMemory({ dir, docCrypto, key, now, send, hashOf });
//   mem.create({ repo, path, text, root, author })  -> note   (hash read from `root`)
//   mem.list({ repo, path?, root?, retired? })      -> note[] (each with `stale`)
//   mem.edit(id, { text, rehash?, root? })          -> note|null
//   mem.retire(id)                                  -> note|null
//   mem.applyRemote(repo, plaintextBytes)           -> boolean (a teammate's sealed-then-opened note)
//   room(repo)                                      -> the doc-sync room the notes ride on

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const MAX_TEXT = 2000;
const MAX_NOTES = 500; // per repo; oldest retired go first, then oldest

const room = (repo) => `memory:${repo}`;
const norm = (p) => String(p || "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
/** GCM additional data: a sealed note opens only as the note it is. */
const aadFor = (repo, id) => `memory\u0000${repo}\u0000${id}`;
const safeName = (repo) => String(repo || "").replace(/[^A-Za-z0-9._-]/g, "_") || "_";

/** What the code at `rel` is right now: sha256 of its bytes, or null when the
 *  file is gone. `kind: "commit"` reads the last commit that touched it. */
function currentHash(root, rel, kind = "content") {
  try {
    if (kind === "commit") {
      const out = execFileSync("git", ["log", "-1", "--format=%H", "--", rel], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000 }).trim();
      return out || null;
    }
    return crypto.createHash("sha256").update(fs.readFileSync(path.join(root, rel))).digest("hex");
  } catch {
    return null;
  }
}

/** "fresh" while the hash still matches; "stale" once it moved; "missing" when
 *  the file is gone (also flagged: the note describes code that is not there). */
function stalenessOf(note, current) {
  if (current == null) return "missing";
  return note.hash === current ? "fresh" : "stale";
}

function createMemory({ dir, docCrypto, key, now = () => Date.now(), send = () => {}, hashOf = currentHash, id = () => crypto.randomUUID() }) {
  const file = (repo) => path.join(dir, `${safeName(repo)}.memory.json`);

  function load(repo) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file(repo), "utf8"));
    } catch {
      return new Map();
    }
    const out = new Map();
    for (const [nid, frame] of Object.entries((raw && raw.notes) || {})) {
      try {
        const note = JSON.parse(docCrypto.open(key, aadFor(repo, nid), Buffer.from(String(frame), "base64")).toString("utf8"));
        if (note && note.id === nid) out.set(nid, note);
      } catch {
        // A frame that does not open (another key, a tampered file) is skipped, not fatal.
      }
    }
    return out;
  }

  function save(repo, notes) {
    const sealed = {};
    for (const n of notes.values()) sealed[n.id] = docCrypto.seal(key, aadFor(repo, n.id), Buffer.from(JSON.stringify(n), "utf8")).toString("base64");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file(repo), JSON.stringify({ v: 1, notes: sealed }));
  }

  function trim(notes) {
    if (notes.size <= MAX_NOTES) return;
    const order = [...notes.values()].sort((a, b) => Number(Boolean(b.retired)) - Number(Boolean(a.retired)) || a.updatedAt - b.updatedAt);
    for (const n of order.slice(0, notes.size - MAX_NOTES)) notes.delete(n.id);
  }

  function put(note, { share }) {
    const notes = load(note.repo);
    notes.set(note.id, note);
    trim(notes);
    save(note.repo, notes);
    if (share) send(room(note.repo), Buffer.from(JSON.stringify(note), "utf8"));
    return note;
  }

  const find = (nid) => {
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!f.endsWith(".memory.json")) continue;
      // The repo name is inside each sealed note, but the AAD needs it up front, so try the file's own name.
      const repo = f.slice(0, -".memory.json".length);
      const n = load(repo).get(nid);
      if (n) return n;
    }
    return null;
  };

  return {
    room,
    create({ repo, path: rel, text, root, hash, author = "" }) {
      const p = norm(rel);
      const t = String(text || "").trim().slice(0, MAX_TEXT);
      if (!repo || !p || !t) return null;
      const h = hash || (root ? hashOf(root, p) : null);
      if (!h) return null; // a note is written against something; no file, no note
      const ts = now();
      return put({ id: id(), repo: safeName(repo), path: p, text: t, hash: h, author: String(author), createdAt: ts, updatedAt: ts, retired: false }, { share: true });
    },
    /** Notes for a repo (and one path), each flagged against the tree at `root`. */
    list({ repo, path: rel, root, retired = false }) {
      const want = rel ? norm(rel) : "";
      return [...load(safeName(repo)).values()]
        .filter((n) => (retired || !n.retired) && (!want || n.path === want))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((n) => ({ ...n, stale: root ? stalenessOf(n, hashOf(root, n.path)) : "unknown" }));
    },
    /** Change the text; `rehash` re-pins it to the code as it is now (a person confirming it still holds). */
    edit(nid, { text, rehash = false, root }) {
      const n = find(nid);
      if (!n) return null;
      const next = { ...n, updatedAt: now() };
      if (typeof text === "string" && text.trim()) next.text = text.trim().slice(0, MAX_TEXT);
      if (rehash && root) next.hash = hashOf(root, n.path) || n.hash;
      return put(next, { share: true });
    },
    retire(nid) {
      const n = find(nid);
      return n ? put({ ...n, retired: true, updatedAt: now() }, { share: true }) : null;
    },
    /** A teammate's note, already opened by doc-sync. Last write wins; true when it changed anything. */
    applyRemote(repo, bytes) {
      let n;
      try {
        n = JSON.parse(Buffer.from(bytes).toString("utf8"));
      } catch {
        return false;
      }
      if (!n || typeof n.id !== "string" || n.repo !== safeName(repo) || !norm(n.path) || typeof n.text !== "string" || typeof n.hash !== "string" || !Number.isFinite(n.updatedAt)) return false;
      const have = load(n.repo).get(n.id);
      if (have && have.updatedAt >= n.updatedAt) return false;
      put({ id: n.id, repo: n.repo, path: norm(n.path), text: n.text.slice(0, MAX_TEXT), hash: n.hash, author: String(n.author || ""), createdAt: Number(n.createdAt) || n.updatedAt, updatedAt: n.updatedAt, retired: n.retired === true }, { share: false });
      return true;
    },
  };
}

module.exports = { createMemory, currentHash, stalenessOf, room, aadFor, MAX_TEXT, MAX_NOTES };
