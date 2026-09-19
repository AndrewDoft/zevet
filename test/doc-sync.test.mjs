// The main process's half of document sync: a socket per room, sealed on the
// way out and opened on the way in.
//
// The end-to-end tests here run against a REAL hub on a real port, with two
// independent DocSync instances standing in for two machines. That is the only
// arrangement that can establish the thing that actually matters — that what
// the hub receives is ciphertext and what the other side receives is the
// plaintext that was sent. A test with one instance, or with a stubbed socket,
// would pass with the encryption removed.
//
// ⚠️ STILL NOT VERIFIED BY ANYTHING HERE: two real machines, a real network, a
// reconnection after a genuine outage, or the hub behind Caddy. Both "machines"
// are in this process, on loopback, against a hub started 200ms ago.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startHub } from "./helpers.mjs";
import { deriveAuthToken, deriveDocKey } from "../client/secret.mjs";
import { open as openSealed } from "../client/doc-crypto.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { DocSync, socketUrl, backoffFor, BACKOFF_MS } = require(
  path.join(ROOT, "desktop", "doc-sync.js"),
);

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_SECRET = "fedcba9876543210fedcba9876543210fedcba9876543210";

describe("the socket URL", () => {
  test("http becomes ws and https becomes wss", () => {
    assert.equal(socketUrl("http://127.0.0.1:8787", "r").toString(), "ws://127.0.0.1:8787/ws");
    assert.equal(socketUrl("https://hub.example", "r").toString(), "wss://hub.example/ws");
  });

  test("a path on the hub URL is replaced, not appended to", () => {
    // A hub configured as `https://host/zevet` would otherwise produce
    // `/zevet/ws`, which the hub does not serve and which 400s with no clue.
    assert.equal(socketUrl("https://hub.example/board", "r").pathname, "/ws");
  });

  test("a query or fragment on the hub URL is dropped", () => {
    // `?token=` lives in config for some people. Carrying it through would put
    // a stale token on the socket ahead of the one this code sets.
    const u = socketUrl("https://hub.example/?token=stale#x", "r");
    assert.equal(u.search, "");
    assert.equal(u.hash, "");
  });

  test("a protocol that is not http or https is named, not guessed at", () => {
    assert.throws(() => socketUrl("ftp://hub.example", "r"), /http or https/);
  });
});

describe("backoff", () => {
  test("it grows and then plateaus", () => {
    assert.ok(backoffFor(0) < backoffFor(3));
    assert.ok(backoffFor(99) <= BACKOFF_MS[BACKOFF_MS.length - 1] * 1.3);
  });

  test("it is jittered, so a team does not reconnect in lockstep", () => {
    const seen = new Set();
    for (let i = 0; i < 40; i++) seen.add(backoffFor(2));
    assert.ok(seen.size > 1, "backoff is deterministic — a hub restart would be a thundering herd");
  });
});

describe("construction", () => {
  test("a legacy install is refused with an instruction, not a crash", () => {
    // There is no master secret to derive a document key from, and deriving one
    // from the raw token would hand the hub the key. The message has to say
    // what to do about it.
    assert.throws(
      () => new DocSync({ hub: "http://127.0.0.1:1", secret: "" }),
      /legacy token.*re-run setup/,
    );
  });

  test("a malformed secret is refused before any socket is opened", () => {
    assert.throws(() => new DocSync({ hub: "http://127.0.0.1:1", secret: "zzz" }), /unusable/);
  });
});

describe("end to end against a real hub", () => {
  let hub;
  const sockets = [];

  before(async () => {
    // The hub is given the DERIVED token. It never sees SECRET, which is the
    // entire point of the scheme and is enforced here by construction.
    hub = await startHub({ ZEVET_TOKEN: deriveAuthToken(SECRET) });
  });

  after(async () => {
    for (const s of sockets) s.destroy();
    await hub.stop();
  });

  /** A DocSync plus a promise-shaped way to wait for what it emits. */
  function machine(secret = SECRET) {
    const events = [];
    const waiters = [];
    const statuses = [];
    const s = new DocSync({
      hub: hub.base,
      secret,
      onEvent: (room, payload) => {
        events.push({ room, ...payload });
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].match(events[events.length - 1])) waiters.splice(i, 1)[0].resolve(events[events.length - 1]);
        }
      },
      onStatus: (room, state, detail) => statuses.push({ room, state, detail }),
    });
    sockets.push(s);
    return {
      sync: s,
      statuses,
      events,
      /** Resolves with the first event matching, past or future. */
      until(match, ms = 5000) {
        const hit = events.find(match);
        if (hit) return Promise.resolve(hit);
        return new Promise((resolve, reject) => {
          const t = setTimeout(
            () => reject(new Error(`timed out waiting; saw ${JSON.stringify(events)} / ${JSON.stringify(statuses)}`)),
            ms,
          );
          waiters.push({ match, resolve: (v) => (clearTimeout(t), resolve(v)) });
        });
      },
    };
  }

  test("a machine connects and is told it may send its state", async () => {
    const a = machine();
    a.sync.join("repo:src/db.ts");
    const ready = await a.until((e) => e.kind === "ready");
    assert.equal(ready.room, "repo:src/db.ts");
    assert.ok(a.statuses.some((s) => s.state === "open"));
  });

  test("an update sent by one machine arrives as plaintext at the other", async () => {
    const room = "repo:src/relay.ts";
    const a = machine();
    const b = machine();
    a.sync.join(room);
    b.sync.join(room);
    await a.until((e) => e.kind === "ready");
    await b.until((e) => e.kind === "ready");

    const payload = new Uint8Array([1, 2, 3, 250, 0, 99]);
    a.sync.send(room, payload);

    const got = await b.until((e) => e.kind === "update");
    assert.deepEqual(new Uint8Array(got.bytes), payload);
  });

  test("the sender does not receive its own update back", async () => {
    const room = "repo:src/noecho.ts";
    const a = machine();
    const b = machine();
    a.sync.join(room);
    b.sync.join(room);
    await a.until((e) => e.kind === "ready");
    await b.until((e) => e.kind === "ready");

    a.sync.send(room, new Uint8Array([7]));
    await b.until((e) => e.kind === "update");
    // b has it, so the round trip has definitely completed by now.
    assert.equal(a.events.filter((e) => e.kind === "update").length, 0);
  });

  test("a machine on a different master secret cannot even connect", async () => {
    // Worth stating because it is easy to assume otherwise: the auth token and
    // the document key come from the SAME secret, so a teammate with the wrong
    // one does not get as far as undecipherable traffic. The hub refuses the
    // upgrade and the socket closes. There is no partial membership.
    const b = machine(OTHER_SECRET);
    b.sync.join("repo:src/wrongkey.ts");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(b.events.filter((e) => e.kind === "ready").length, 0);
    assert.ok(
      b.statuses.some((s) => s.state === "retrying"),
      `expected a failed connection, saw ${JSON.stringify(b.statuses)}`,
    );
  });

  test("a frame forged by something holding only the hub token is rejected", async () => {
    // THE threat the encryption exists for. Anything that can reach the hub and
    // present its token -- the hub itself, first of all -- can put bytes into a
    // room. It cannot produce bytes that open under the document key, and this
    // is the assertion that says so.
    //
    // Two further things are checked because both are ways to get this wrong:
    // the receiver must NOT tear its socket down (otherwise one forged frame
    // disconnects the whole team, a denial of service with extra steps), and it
    // must still accept a legitimate update afterwards.
    const room = "repo:src/forged.ts";
    const a = machine(SECRET);
    const b = machine(SECRET);
    a.sync.join(room);
    b.sync.join(room);
    await a.until((e) => e.kind === "ready");
    await b.until((e) => e.kind === "ready");

    await new Promise((resolve) => {
      const u = new URL(hub.base.replace(/^http/, "ws") + "/ws");
      u.searchParams.set("token", deriveAuthToken(SECRET));
      const ws = new WebSocket(u.toString());
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "join", room }));
        // A well-formed sealed frame in every respect except that it was not
        // sealed with the key: right version byte, right lengths, wrong bytes.
        const forged = Buffer.concat([Buffer.from([1]), Buffer.alloc(12, 7), Buffer.alloc(24, 9)]);
        ws.send(forged);
        setTimeout(() => (ws.close(), resolve()), 300);
      });
    });

    assert.equal(b.events.filter((e) => e.kind === "update").length, 0, "a forged frame was accepted");
    assert.ok(
      b.statuses.some((s) => s.state === "undecipherable"),
      `expected an undecipherable status, saw ${JSON.stringify(b.statuses)}`,
    );

    // The socket survived it, and real traffic still flows.
    a.sync.send(room, new Uint8Array([42]));
    const got = await b.until((e) => e.kind === "update");
    assert.deepEqual(new Uint8Array(got.bytes), new Uint8Array([42]));
  });

  test("rooms are isolated from each other", async () => {
    const a = machine();
    const b = machine();
    a.sync.join("repo:one.ts");
    b.sync.join("repo:two.ts");
    await a.until((e) => e.kind === "ready");
    await b.until((e) => e.kind === "ready");
    a.sync.send("repo:one.ts", new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(b.events.filter((e) => e.kind === "update").length, 0);
  });

  test("a late joiner is replayed what it missed", async () => {
    const room = "repo:src/replay.ts";
    const a = machine();
    a.sync.join(room);
    await a.until((e) => e.kind === "ready");
    a.sync.send(room, new Uint8Array([10]));
    a.sync.send(room, new Uint8Array([20]));
    await new Promise((r) => setTimeout(r, 300));

    const b = machine();
    b.sync.join(room);
    await b.until((e) => e.kind === "ready");
    await b.until((e) => e.kind === "update" && e.bytes[0] === 20);
    const seen = b.events.filter((e) => e.kind === "update").map((e) => e.bytes[0]);
    // Order matters: CRDT updates are commutative, but a replay that reorders
    // is a reason to distrust everything else the relay does.
    assert.deepEqual(seen, [10, 20]);
  });

  test("what the hub actually holds is ciphertext", async () => {
    // The claim on the product page is that the hub never sees file contents.
    // This is the test of it: put a recognisable string through, then read the
    // room back from a fresh joiner's raw frames and assert the plaintext is
    // not in what crossed the wire, while the key does open it.
    const room = "repo:src/secrets.ts";
    const a = machine();
    a.sync.join(room);
    await a.until((e) => e.kind === "ready");
    const secretText = Buffer.from("const API_KEY = 'hunter2';");
    a.sync.send(room, new Uint8Array(secretText));
    await new Promise((r) => setTimeout(r, 300));

    // Join the room as a raw socket -- no DocSync, no key -- exactly as the hub
    // itself sees the data.
    const raw = await new Promise((resolve, reject) => {
      const u = new URL(hub.base.replace(/^http/, "ws") + "/ws");
      u.searchParams.set("token", deriveAuthToken(SECRET));
      const ws = new WebSocket(u.toString());
      ws.binaryType = "arraybuffer";
      const frames = [];
      ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "join", room })));
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string") frames.push(Buffer.from(ev.data));
      });
      setTimeout(() => {
        ws.close();
        frames.length ? resolve(frames) : reject(new Error("no frames replayed"));
      }, 600);
    });

    const onTheWire = Buffer.concat(raw);
    assert.ok(!onTheWire.includes(secretText), "the plaintext crossed the hub");
    // And the same bytes do open with the key, so this is encryption and not
    // an assertion that passes because nothing was sent.
    assert.deepEqual(openSealed(deriveDocKey(SECRET), room, raw[0]), secretText);
  });

  test("leaving stops the room and joining again works", async () => {
    const room = "repo:src/leave.ts";
    const a = machine();
    a.sync.join(room);
    await a.until((e) => e.kind === "ready");
    assert.equal(a.sync.leave(room), true);
    assert.equal(a.sync.leave(room), false);
    a.sync.join(room);
    await a.until((e) => e.kind === "ready");
  });

  test("a room name the hub would refuse is refused here first", () => {
    const a = machine();
    assert.throws(() => a.sync.join(""), /1\.\.256/);
    assert.throws(() => a.sync.join("x".repeat(257)), /1\.\.256/);
  });

  test("sending to a room that was never joined is an error, not a silent drop", () => {
    const a = machine();
    assert.throws(() => a.sync.send("never", new Uint8Array([1])), /not joined/);
  });
});
