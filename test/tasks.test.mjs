// Team task board (D-089). Model under each role, the start-agent gate,
// and, against a REAL hub, that the relay carries ciphertext only, that a late
// or reconnecting machine converges, and that a Viewer's session socket cannot
// write a tasks room. Each test is one the change must make pass.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Accounts } from "../hub/accounts.mjs";
import { startHub, ROOT } from "./helpers.mjs";
import { deriveAuthToken, deriveDocKey } from "../client/secret.mjs";
import { open as openSealed } from "../client/doc-crypto.mjs";
import { apply, cards, emptyState, merge, handoff, may, decode } from "../board/src/lib/tasks.mjs";
import { createTasksSync } from "../board/src/lib/tasks-sync.mjs";

const require = createRequire(import.meta.url);
const { DocSync } = require(path.join(ROOT, "desktop", "doc-sync.js"));

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const ROLES = { ann: "editor", bo: "commenter", cy: "viewer" };
const roleOf = (l) => ROLES[l] || null;
let clock = 1000;
const now = () => ++clock;
const run = (state, op, by) => apply(state, op, { by, role: roleOf(by), now });

describe("the model under each role", () => {
  test("an Editor creates, moves and assigns; a Commenter and Viewer cannot", () => {
    let s = emptyState();
    const made = run(s, { op: "create", id: "c1", title: "Fix login" }, "ann");
    assert.equal(made.ok, true);
    s = made.state;
    s = run(s, { op: "move", id: "c1", status: "doing" }, "ann").state;
    s = run(s, { op: "assign", id: "c1", owner: "@bo" }, "ann").state;
    assert.deepEqual(cards(s).map((c) => [c.title, c.status, c.owner]), [["Fix login", "doing", "bo"]]);
    for (const by of ["bo", "cy"]) {
      for (const op of [{ op: "create", id: "c2", title: "x" }, { op: "move", id: "c1", status: "done" }, { op: "assign", id: "c1", owner: "cy" }, { op: "remove", id: "c1" }]) {
        const r = run(s, op, by);
        assert.equal(r.ok, false, `${by} ${op.op}`);
        assert.match(r.error, /editor role required/);
      }
    }
  });

  test("a Commenter and an Editor comment, a Viewer cannot", () => {
    let s = run(emptyState(), { op: "create", id: "c1", title: "t" }, "ann").state;
    s = run(s, { op: "comment", id: "c1", cid: "m1", text: "on it" }, "bo").state;
    s = run(s, { op: "comment", id: "c1", cid: "m2", text: "ok" }, "ann").state;
    assert.deepEqual(cards(s)[0].comments.map((m) => m.by), ["bo", "ann"]);
    const r = run(s, { op: "comment", id: "c1", cid: "m3", text: "hi" }, "cy");
    assert.equal(r.ok, false);
    assert.match(r.error, /commenter role required/);
  });

  test("a received edit from a Viewer or an unknown author is dropped", () => {
    const base = run(emptyState(), { op: "create", id: "c1", title: "t" }, "ann").state;
    const forged = (by) => ({ cards: { c1: { f: { status: { v: "done", t: 99999, by } }, c: { x1: { text: "hi", by, t: 5 } } } } });
    for (const by of ["cy", "bo", "nobody"]) {
      const r = merge(base, forged(by), { roleOf });
      assert.equal(cards(r.state)[0].status, "todo", `status from ${by}`);
    }
    // a Commenter's comment lands, a Viewer's does not
    assert.equal(cards(merge(base, forged("bo"), { roleOf }).state)[0].comments.length, 1);
    assert.equal(cards(merge(base, forged("cy"), { roleOf }).state)[0].comments.length, 0);
  });

  test("merge is order-independent and idempotent (last writer wins per field)", () => {
    const a = run(emptyState(), { op: "create", id: "c1", title: "t" }, "ann");
    const m1 = run(a.state, { op: "move", id: "c1", status: "doing" }, "ann");
    const m2 = run(m1.state, { op: "move", id: "c1", status: "done" }, "ann");
    const fwd = [a.delta, m1.delta, m2.delta].reduce((s, d) => merge(s, d, { roleOf }).state, emptyState());
    const rev = [m2.delta, m1.delta, m2.delta, a.delta].reduce((s, d) => merge(s, d, { roleOf }).state, emptyState());
    assert.deepEqual(fwd, rev);
    assert.equal(cards(fwd)[0].status, "done");
  });

  test("junk is refused: bad status, bad link; a bad frame decodes to null", () => {
    const s = run(emptyState(), { op: "create", id: "c1", title: "t" }, "ann").state;
    assert.equal(run(s, { op: "move", id: "c1", status: "banana" }, "ann").ok, false);
    assert.equal(run(s, { op: "edit", id: "c1", link: { kind: "url", ref: "x" } }, "ann").ok, false);
    assert.equal(cards(run(s, { op: "edit", id: "c1", link: { kind: "path", ref: "src/a.ts" } }, "ann").state)[0].link.ref, "src/a.ts");
    assert.equal(decode(new TextEncoder().encode("not json")), null);
  });
});

describe("start agent on this", () => {
  const card = { title: "Fix login", link: { kind: "path", ref: "src/login.ts" } };
  test("Editor and Owner may; Commenter and Viewer are refused", () => {
    assert.equal(handoff(card, "editor").ok, true);
    assert.equal(handoff(card, "owner").ok, true);
    assert.match(handoff(card, "editor").prompt, /Fix login.*src\/login\.ts/);
    for (const role of ["commenter", "viewer", null]) {
      const r = handoff(card, role);
      assert.equal(r.ok, false, String(role));
      assert.match(r.error, /editor role required/);
    }
    assert.equal(may("commenter", "handoff"), false);
  });
});

describe("the wire", () => {
  test("on (re)connect a client re-sends its whole state, and a snapshot offer carries it too", () => {
    const sent = [];
    let handler;
    const doc = { join: () => true, send: (r, b, o) => sent.push({ r, b, o }), onMessage: (h) => ((handler = h), () => {}) };
    const t = createTasksSync({ doc, team: "t", me: "ann", roleOf, now });
    t.do({ op: "create", id: "c1", title: "kept" });
    sent.length = 0;
    handler({ room: "tasks:t", kind: "ready" });
    assert.equal(sent.length, 1);
    assert.equal(decode(sent[0].b).cards.c1.f.title.v, "kept");
    handler({ room: "tasks:t", kind: "snapshot-due" });
    assert.equal(sent[1].o.snapshot, true);
    handler({ room: "tasks:other", kind: "ready" });
    assert.equal(sent.length, 2, "another room is none of its business");
  });

  test("a refused local op sends nothing", () => {
    const sent = [];
    const doc = { join: () => true, send: (...a) => sent.push(a), onMessage: () => () => {} };
    const t = createTasksSync({ doc, team: "t", me: "cy", roleOf, now });
    assert.equal(t.do({ op: "create", id: "c1", title: "x" }).ok, false);
    assert.equal(sent.length, 0);
  });
});

describe("through a real hub", () => {
  const hubs = [];
  const syncs = [];
  after(async () => {
    for (const s of syncs) s.destroy();
    for (const h of hubs) await h.stop();
  });

  /** A DocSync dressed as window.zevetDoc, the way main.js hands it to the board. */
  function bridge(hub, token) {
    const handlers = new Set();
    const sync = new DocSync({
      hub: hub.base,
      secret: SECRET,
      onEvent: (room, p) => handlers.forEach((h) => h({ room, kind: p.kind, bytes: p.bytes && new Uint8Array(p.bytes) })),
    });
    if (token) sync.token = token;
    syncs.push(sync);
    return {
      sync,
      join: (r) => sync.join(r),
      send: (r, b, o) => sync.send(r, b, o),
      leave: (r) => sync.leave(r),
      onMessage: (h) => (handlers.add(h), () => handlers.delete(h)),
    };
  }
  const until = async (fn, what) => {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.fail(`timed out: ${what}`);
  };
  const board = (hub, me, token, roles = roleOf) => {
    const b = bridge(hub, token);
    const t = createTasksSync({ doc: b, team: "default", me, roleOf: roles, now });
    t.sync = b.sync;
    return t;
  };

  test("the hub relays ciphertext only, and a teammate reads the card", async () => {
    const hub = await startHub({ ZEVET_TOKEN: deriveAuthToken(SECRET) });
    hubs.push(hub);
    // A spy on the hub side: a raw socket in the room that never holds the key.
    const spy = [];
    const raw = new WebSocket(`${hub.base.replace("http", "ws")}/ws?token=${deriveAuthToken(SECRET)}`);
    raw.binaryType = "arraybuffer";
    raw.onmessage = (e) => typeof e.data !== "string" && spy.push(new Uint8Array(e.data));
    await new Promise((r) => (raw.onopen = r));
    raw.send(JSON.stringify({ type: "join", room: "tasks:default" }));

    const ann = board(hub, "ann");
    const bo = board(hub, "bo");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ann.do({ op: "create", id: "c1", title: "Secret roadmap item" }).ok, true);
    await until(() => bo.cards().length === 1, "bo sees the card");
    assert.equal(bo.cards()[0].title, "Secret roadmap item");
    await until(() => spy.length > 0, "spy saw frames");
    for (const frame of spy) {
      assert.equal(Buffer.from(frame).includes("Secret roadmap"), false, "plaintext on the relay");
      assert.throws(() => openSealed(deriveDocKey(SECRET), "tasks:wrong", frame)); // the room name is bound in
    }
    assert.ok(spy.some((f) => Buffer.from(openSealed(deriveDocKey(SECRET), "tasks:default", f)).includes("Secret roadmap")), "holders of the key can read it");
    raw.close();
  });

  test("a late joiner and a machine that was offline both converge (persistence across reconnect)", async () => {
    const hub = await startHub({ ZEVET_TOKEN: deriveAuthToken(SECRET) });
    hubs.push(hub);
    const ann = board(hub, "ann");
    await new Promise((r) => setTimeout(r, 300));
    ann.do({ op: "create", id: "c1", title: "one" });
    ann.do({ op: "move", id: "c1", status: "doing" });
    await new Promise((r) => setTimeout(r, 200));
    // Joins after the fact: the hub's log replay carries it.
    const late = board(hub, "bo");
    await until(() => late.cards().length === 1 && late.cards()[0].status === "doing", "late joiner converged");
    // Offline edit: ann's socket drops, she edits, the reconnect delivers it.
    ann.sync.rooms.get(ann.room).ws.close();
    ann.do({ op: "comment", id: "c1", cid: "m1", text: "while away" });
    await until(() => late.cards()[0].comments.length === 1, "offline edit delivered after reconnect");
    assert.equal(late.cards()[0].comments[0].text, "while away");
  });

  test("a Viewer's session socket cannot write a tasks room; a Commenter's can; a demotion bites", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zevet-tasks-"));
    const file = path.join(dir, "accounts.json");
    const a = new Accounts({ file });
    const ownerTok = a.signIn({ login: "AndrewDoft", id: "1" }).token;
    a.allow("cy");
    const cyTok = a.signIn({ login: "cy", id: "2" }).token;
    a.setRole("cy", "viewer", "AndrewDoft");
    const hub = await startHub({ ZEVET_TOKEN: deriveAuthToken(SECRET), ZEVET_ACCOUNTS: file });
    hubs.push(hub);
    const watcher = board(hub, "ann", ownerTok, () => "editor"); // permissive receiver: only the HUB can stop v1
    const viewer = board(hub, "cy", cyTok, () => "editor"); // a desktop that LIES about its role
    await new Promise((r) => setTimeout(r, 300));
    // The lying client sends; the hub refuses before the room sees it.
    viewer.do({ op: "create", id: "v1", title: "from a viewer" });
    watcher.do({ op: "create", id: "e1", title: "from an editor" });
    // roleOf of the receiver knows cy is a viewer? Both clients trust "editor" here, so only the hub can stop v1.
    await until(() => viewer.cards().some((c) => c.id === "e1"), "the viewer still READS the room");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(watcher.cards().some((c) => c.id === "v1"), false, "a viewer's frame reached the room");
    const setRole = (role) => fetch(`${hub.base}/auth/role`, { method: "POST", headers: { "content-type": "application/json", "x-zevet-token": ownerTok }, body: JSON.stringify({ login: "cy", role }) });
    assert.equal((await setRole("commenter")).status, 200);
    viewer.do({ op: "comment", id: "e1", cid: "k1", text: "now allowed" });
    await until(() => watcher.cards().find((c) => c.id === "e1")?.comments.length === 1, "commenter frame relayed");
    await setRole("viewer");
    viewer.do({ op: "comment", id: "e1", cid: "k2", text: "after demotion" });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(watcher.cards().find((c) => c.id === "e1").comments.length, 1);
  });
});
