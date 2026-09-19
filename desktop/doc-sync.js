// Document sync: the main process owns the socket and the key, the renderer
// owns the CRDT.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE SOCKET IS HERE AND NOT IN THE PAGE
//
// The board window loads its HTML from the hub (`openBoard()` in main.js). If
// the renderer held the document key, then the hub — which serves that
// renderer's JavaScript — would effectively hold it too, and the encryption
// would be defending against nobody. Keeping the key and the socket in the main
// process does not fix that completely (a hostile hub page can still call this
// bridge and use it as an oracle, which `client/secret.mjs` says outright), but
// it does mean the key material itself never becomes a readable value in a
// context the hub controls. That is a real difference, and it is the strongest
// available without moving the board's HTML out of the hub — which is the
// actual fix and has not been done.
//
// So the split is:
//
//   renderer   Y.Doc, CodeMirror, awareness      plaintext Yjs updates
//      │  ipc: doc:send / doc:message            ▲
//      ▼                                         │
//   main       seal / open, one socket per room  │  ciphertext
//      │                                         │
//      ▼  wss                                    │
//   hub        an opaque blob it relays ─────────┘
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ ONE SOCKET PER ROOM, and that is the hub's protocol, not a choice made
// here. `hub/server.mjs` takes a single `{"type":"join","room":…}` as the first
// text frame on a connection and thereafter treats every binary frame on that
// connection as belonging to that room. Multiplexing several documents down one
// socket would need a protocol the hub does not speak. A person with a dozen
// files open holds a dozen sockets; if that ever becomes a problem the fix is a
// framing change on both ends, not a workaround here.
//
// ⚠️ NO DEPENDENCY. `WebSocket` is a global in Node 22, which is what Electron
// 38 embeds, so the client side needs nothing installed. It is feature-detected
// below rather than assumed, because the failure without a check is a
// ReferenceError deep inside a click handler.
//
// ⚠️ NOT VERIFIED: nothing in this file has connected to the deployed hub, and
// no two machines have ever exchanged a document. It is written against
// `hub/server.mjs` as committed and against `test/hub-ws.test.mjs`'s account of
// what that server does.
"use strict";

const path = require("node:path");

/**
 * Crypto comes from the copy that SHIPPED WITH THE APP, never from
 * `~/.zevet/client`.
 *
 * That directory is the hub's update channel — the hub pushes client files
 * there and they are picked up automatically, which is exactly the right model
 * for the hook and exactly the wrong one for key derivation. A hub that can
 * replace `secret.mjs` can make `deriveDocKey` return whatever it likes, and
 * every document on the team is readable. So this resolution order deliberately
 * does NOT include the synced copy, and must not grow one.
 *
 * Packaged: electron-builder copies `../client/*.mjs` to `resources/client`
 * (see `extraResources` in desktop/package.json). Development: the checkout.
 */
function cryptoModulePaths(name) {
  const out = [];
  if (process.resourcesPath) out.push(path.join(process.resourcesPath, "client", name));
  out.push(path.join(__dirname, "..", "client", name));
  return out;
}

function loadCrypto() {
  // Node 22 can `require()` an ES module synchronously as long as it has no
  // top-level await. secret.mjs and doc-crypto.mjs have none, deliberately.
  const tried = [];
  for (const name of ["secret.mjs", "doc-crypto.mjs"]) {
    let loaded = null;
    for (const p of cryptoModulePaths(name)) {
      try {
        loaded = require(p);
        break;
      } catch (err) {
        tried.push(`${p}: ${err.message}`);
      }
    }
    if (!loaded) {
      throw new Error(`cannot load ${name} — document sync is unavailable.\n  ${tried.join("\n  ")}`);
    }
    if (name === "secret.mjs") loadCrypto.secret = loaded;
    else loadCrypto.docCrypto = loaded;
  }
  return { secret: loadCrypto.secret, docCrypto: loadCrypto.docCrypto };
}

/** ws:// for an http hub, wss:// for https. Anything else is a configuration
 *  error worth naming rather than a socket that fails obscurely. */
function socketUrl(hub, room) {
  const u = new URL(hub);
  if (u.protocol === "https:") u.protocol = "wss:";
  else if (u.protocol === "http:") u.protocol = "ws:";
  else throw new Error(`hub must be http or https, got ${u.protocol}`);
  u.pathname = "/ws";
  // The token goes in the query string. The hub accepts it there as a last
  // resort (the cookie path is for the browser, the header for the hook), and a
  // WebSocket client cannot set request headers — the browser API has no
  // argument for them and Node's global matches the browser API. This is why
  // the value in the URL is the DERIVED token and never the master secret: a
  // token in a URL can end up in a proxy log, and the derived token is exactly
  // the thing we are content for the hub's side of the world to hold.
  u.search = "";
  u.hash = "";
  return u;
}

/** Backoff for a hub that is down: fast at first, then patient, with jitter so
 *  a team whose hub restarts does not reconnect in lockstep and hammer it. */
const BACKOFF_MS = [500, 1000, 2000, 5000, 10000, 30000];
function backoffFor(attempt) {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  return base + Math.floor(Math.random() * base * 0.3);
}

/**
 * How often a client offers to compact its room's log.
 *
 * The hub keeps an append-only log per room and drops the oldest entries past
 * 4 MiB. Dropping the oldest Yjs updates would lose history a late joiner needs,
 * so a client periodically sends `{"type":"snapshot"}` followed by its whole
 * document state, and the hub replaces the log with that one blob. Any client
 * may do it and there is no election: two clients snapshotting at once is
 * harmless, because each blob is a complete state and the second simply wins.
 *
 * Jittered for the same reason as the backoff.
 */
const SNAPSHOT_EVERY_MS = 60_000;

class Room {
  constructor(sync, name) {
    this.sync = sync;
    this.name = name;
    this.ws = null;
    this.attempt = 0;
    this.closed = false;
    /** Sealed frames written while the socket was down. Bounded: a client that
     *  edits for an hour offline should reconnect and send ONE state, not
     *  replay every keystroke, and the snapshot on connect does exactly that. */
    this.pending = [];
    this.snapshotTimer = null;
    this.reconnectTimer = null;
  }

  connect() {
    if (this.closed || this.ws) return;
    let url;
    try {
      url = socketUrl(this.sync.hub, this.name);
    } catch (err) {
      return this.sync.status(this.name, "error", err.message);
    }
    url.searchParams.set("token", this.sync.token);

    let ws;
    try {
      ws = new WebSocket(url.toString());
    } catch (err) {
      return this.retry(err.message);
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.sync.status(this.name, "connecting");

    ws.addEventListener("open", () => {
      this.attempt = 0;
      // Join first, then everything else. The hub requires the join to be the
      // first text frame on the connection and will close the socket otherwise.
      ws.send(JSON.stringify({ type: "join", room: this.name }));
      this.sync.status(this.name, "open");
      // The renderer is told it may now send its full state, which is what
      // gets offline edits to everyone else and what seeds an empty room.
      this.sync.emit(this.name, { kind: "ready" });
      for (const frame of this.pending.splice(0)) this.rawSend(frame);
      this.startSnapshots();
    });

    ws.addEventListener("message", (ev) => {
      // Text frames are the hub's own, not a peer's. There are none today; a
      // future ack would arrive here and being quiet about it beats throwing.
      if (typeof ev.data === "string") return;
      let plain;
      try {
        plain = this.sync.docCrypto.open(this.sync.key, this.name, new Uint8Array(ev.data));
      } catch (err) {
        // A frame we cannot open is dropped and the connection kept. It means a
        // teammate on a different master secret, or a relay that altered or
        // misrouted it — the room name is authenticated, so a replay into the
        // wrong room lands exactly here. Tearing the socket down would let
        // anyone who can reach the hub disconnect the whole team.
        return this.sync.status(this.name, "undecipherable", err.message);
      }
      this.sync.emit(this.name, { kind: "update", bytes: plain });
    });

    ws.addEventListener("close", (ev) => {
      this.ws = null;
      this.stopSnapshots();
      if (this.closed) return;
      // 1013 is the hub saying every room is occupied; retrying instantly would
      // be the worst thing to do with that answer.
      this.retry(`socket closed (${ev.code})`);
    });

    ws.addEventListener("error", () => {
      // The browser API gives no detail here on purpose; `close` follows and
      // carries the code, so the retry is driven from there.
    });
  }

  retry(why) {
    if (this.closed) return;
    const wait = backoffFor(this.attempt++);
    this.sync.status(this.name, "retrying", `${why}; retrying in ${Math.round(wait / 1000)}s`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), wait);
  }

  startSnapshots() {
    this.stopSnapshots();
    const every = SNAPSHOT_EVERY_MS + Math.floor(Math.random() * SNAPSHOT_EVERY_MS * 0.4);
    this.snapshotTimer = setInterval(() => this.sync.emit(this.name, { kind: "snapshot-due" }), every);
    // unref so a pending timer cannot keep the process alive at quit.
    if (this.snapshotTimer.unref) this.snapshotTimer.unref();
  }

  stopSnapshots() {
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.snapshotTimer = null;
  }

  rawSend(frame) {
    try {
      this.ws.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  /** Seal a plaintext update and send it, or hold it until the socket is back. */
  send(plaintext, { snapshot = false } = {}) {
    let frame;
    try {
      frame = this.sync.docCrypto.seal(this.sync.key, this.name, plaintext);
    } catch (err) {
      return this.sync.status(this.name, "error", `cannot seal: ${err.message}`);
    }
    if (!this.ws || this.ws.readyState !== 1) {
      // Only the most recent full state is worth keeping while offline; a queue
      // of deltas is both larger and, after a snapshot, redundant.
      if (snapshot) this.pending = [frame];
      else if (this.pending.length < 64) this.pending.push(frame);
      return;
    }
    if (snapshot) this.ws.send(JSON.stringify({ type: "snapshot" }));
    this.rawSend(frame);
  }

  close() {
    this.closed = true;
    this.stopSnapshots();
    clearTimeout(this.reconnectTimer);
    this.pending.length = 0;
    if (this.ws) {
      try {
        this.ws.close(1000, "left");
      } catch {
        // Already gone. Nothing to do and nothing worth logging.
      }
      this.ws = null;
    }
  }
}

/**
 * One of these per board window.
 *
 * `onEvent(room, payload)` is how plaintext reaches the renderer, and
 * `onStatus(room, state, detail)` is how the UI learns the socket is down —
 * an editor that silently stops syncing is the failure this project calls its
 * worst, so the status is a first-class output and not a log line.
 */
class DocSync {
  constructor({ hub, secret, onEvent, onStatus }) {
    const { secret: secretMod, docCrypto } = loadCrypto();
    if (typeof WebSocket !== "function") {
      throw new Error(
        "this Node/Electron build has no global WebSocket, so document sync cannot run",
      );
    }
    const auth = secretMod.resolveAuth({ env: {}, file: { secret } });
    if (auth.error) throw new Error(`master secret is unusable: ${auth.error}`);
    if (!auth.secret) {
      // A legacy install: a raw token and no master secret. There is nothing to
      // derive a document key from, and inventing one from the token would hand
      // the hub the key. Editing is simply unavailable until setup is re-run.
      throw new Error(
        "this machine has a legacy token and no master secret — re-run setup to enable the editor",
      );
    }
    this.hub = String(hub || "").replace(/\/+$/, "");
    this.token = auth.token;
    this.key = secretMod.deriveDocKey(auth.secret);
    this.docCrypto = docCrypto;
    this.onEvent = typeof onEvent === "function" ? onEvent : () => {};
    this.onStatus = typeof onStatus === "function" ? onStatus : () => {};
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
  }

  emit(room, payload) {
    this.onEvent(room, payload);
  }

  status(room, state, detail) {
    this.onStatus(room, state, detail || "");
  }

  join(room) {
    if (typeof room !== "string" || !room || room.length > 256) {
      throw new Error("room must be a string of 1..256 characters");
    }
    let r = this.rooms.get(room);
    if (!r) {
      r = new Room(this, room);
      this.rooms.set(room, r);
    }
    r.connect();
    return room;
  }

  send(room, bytes, opts) {
    const r = this.rooms.get(room);
    if (!r) throw new Error(`not joined: ${room}`);
    r.send(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), opts);
  }

  leave(room) {
    const r = this.rooms.get(room);
    if (!r) return false;
    r.close();
    this.rooms.delete(room);
    return true;
  }

  destroy() {
    for (const r of this.rooms.values()) r.close();
    this.rooms.clear();
  }
}

module.exports = { DocSync, socketUrl, backoffFor, SNAPSHOT_EVERY_MS, BACKOFF_MS };
