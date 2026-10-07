// Team chat (D-NEXT-W2-15B). Model under each role, the cap, card links, unread
// counts, and, against a REAL hub, ciphertext-only relay, re-send on reconnect and
// the hub's role gate on a chat: room. Each test is one the change must make pass.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Accounts } from "../hub/accounts.mjs";
import { startHub, ROOT } from "./helpers.mjs";
import { deriveAuthToken, deriveDocKey } from "../client/secret.mjs";
import { open as openSealed } from "../client/doc-crypto.mjs";
import { apply, countByCard, decode, emptyState, LIMITS, merge, messages, readMark, unread } from "../board/src/lib/team-chat.mjs";
import { createChatSync } from "../board/src/lib/team-chat-sync.mjs";

const require = createRequire(import.meta.url);
const { DocSync } = require(path.join(ROOT, "desktop", "doc-sync.js"));

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const ROLES = { ann: "editor", bo: "commenter", cy: "viewer" };
const roleOf = (l) => ROLES[l] || null;
let clock = 1000;
const now = () => ++clock;
const post = (state, op, by) => apply(state, { op: "post", ...op }, { by, role: roleOf(by), now });

describe("post, read and role gates", () => {
  test("an Editor and a Commenter post and everyone reads in order; a Viewer cannot post", () => {
    let s = post(emptyState(), { id: "m1", text: "hello" }, "ann").state;
    s = post(s, { id: "m2", text: "hi", replyTo: "m1" }, "bo").state;
    assert.deepEqual(messages(s).map((m) => [m.by, m.text, m.replyTo]), [["ann", "hello", undefined], ["bo", "hi", "m1"]]);
    const r = post(s, { id: "m3", text: "may I" }, "cy");
    assert.equal(r.ok, false);
    assert.match(r.error, /commenter role required/);
    assert.equal(post(s, { id: "m4", text: "x" }, "nobody").ok, false);
  });

  test("a received message from a Viewer or an unknown author is dropped; a Commenter's lands", () => {
    const forged = (by) => ({ msgs: { f1: { text: "forged", by, t: 5 } } });
    assert.equal(messages(merge(emptyState(), forged("cy"), { roleOf }).state).length, 0, "viewer");
    assert.equal(messages(merge(emptyState(), forged("nobody"), { roleOf }).state).length, 0, "unknown");
    assert.equal(messages(merge(emptyState(), forged("bo"), { roleOf }).state).length, 1, "commenter");
  });

  test("messages are append-only: a replayed id never overwrites; distinct messages merge in any order", () => {
    const a = post(emptyState(), { id: "m1", text: "first" }, "ann");
    const b = post(a.state, { id: "m2", text: "second" }, "bo");
    const evil = { msgs: { m1: { text: "rewritten", by: "ann", t: 9999 } } };
    const fwd = [a.delta, b.delta, evil].reduce((s, d) => merge(s, d, { roleOf }).state, emptyState());
    assert.equal(fwd.msgs.m1.text, "first");
    const rev = [b.delta, a.delta, b.delta].reduce((s, d) => merge(s, d, { roleOf }).state, emptyState());
    assert.deepEqual(rev, fwd);
    assert.equal(merge(a.state, a.delta, { roleOf }).changed, false);
  });
});

describe("the cap", () => {
  test("text over the cap is refused locally", () => {
    const r = post(emptyState(), { id: "m1", text: "x".repeat(LIMITS.text + 1) }, "ann");
    assert.equal(r.ok, false);
    assert.match(r.error, /4000/);
    assert.equal(post(emptyState(), { id: "m1", text: "x".repeat(LIMITS.text) }, "ann").ok, true);
  });

  test("text over the cap is truncated on receipt", () => {
    const big = "x".repeat(LIMITS.text + 1);
    const got = merge(emptyState(), { msgs: { m1: { text: big, by: "ann", t: 1 } } }, { roleOf }).state;
    assert.equal(got.msgs.m1.text.length, LIMITS.text);
  });

  test("the log keeps the newest messages, and a message older than the window is not resurrected", () => {
    const delta = { msgs: {} };
    for (let i = 0; i < LIMITS.messages + 20; i++) delta.msgs[`m${i}`] = { text: `n${i}`, by: "ann", t: i + 1 };
    const one = merge(emptyState(), delta, { roleOf }).state;
    assert.equal(Object.keys(one.msgs).length, LIMITS.messages);
    assert.ok(one.msgs[`m${LIMITS.messages + 19}`], "newest kept");
    assert.ok(!one.msgs.m0, "oldest dropped");
    const late = merge(one, { msgs: { old: { text: "ancient", by: "ann", t: 0 } } }, { roleOf });
    assert.equal(late.changed, false);
  });

  test("text is data: markup stays the same characters, and the panel never sets HTML", () => {
    const s = post(emptyState(), { id: "m1", text: "<img src=x onerror=alert(1)>" }, "ann").state;
    assert.equal(messages(s)[0].text, "<img src=x onerror=alert(1)>");
    const src = readFileSync(path.join(ROOT, "board/src/components/team-chat.tsx"), "utf8");
    assert.equal(/dangerouslySetInnerHTML|innerHTML/.test(src), false);
  });
});

describe("card linking", () => {
  test("a message carries a cardId and counts group by card", () => {
    let s = post(emptyState(), { id: "m1", text: "on it", cardId: "c1" }, "ann").state;
    s = post(s, { id: "m2", text: "also", cardId: "c1" }, "bo").state;
    s = post(s, { id: "m3", text: "other", cardId: "c2" }, "bo").state;
    s = post(s, { id: "m4", text: "none" }, "bo").state;
    assert.deepEqual(countByCard(s), { c1: 2, c2: 1 });
    assert.equal(messages(s)[0].cardId, "c1");
  });

  test("a malformed cardId or replyTo is refused", () => {
    const s = post(emptyState(), { id: "m1", text: "x" }, "ann").state;
    assert.equal(post(s, { id: "m5", text: "bad", cardId: "../x" }, "ann").ok, false);
    assert.equal(post(s, { id: "m6", text: "bad", replyTo: "a b" }, "ann").ok, false);
  });
});

describe("unread counts", () => {
  test("others' messages newer than the last-read marker count; my own and read ones do not", () => {
    let s = post(emptyState(), { id: "m1", text: "a" }, "ann").state;
    s = post(s, { id: "m2", text: "b" }, "bo").state;
    s = post(s, { id: "m3", text: "c" }, "bo").state;
    assert.equal(unread(s, 0, "ann"), 2, "bo's two, not ann's own");
    assert.equal(unread(s, s.msgs.m2.t, "ann"), 1, "marker at m2");
    assert.equal(unread(s, readMark(s), "ann"), 0, "all read");
    s = post(s, { id: "m4", text: "d" }, "bo").state;
    assert.equal(unread(s, s.msgs.m3.t, "ann"), 1, "one new since");
  });
});

describe("the wire", () => {
  test("on (re)connect a client re-sends its whole log, and a snapshot offer carries it too", () => {
    const sent = [];
    let handler;
    const doc = { join: () => true, send: (r, b, o) => sent.push({ r, b, o }), onMessage: (h) => ((handler = h), () => {}) };
    const t = createChatSync({ doc, team: "t", me: "ann", roleOf, now });
    t.do({ op: "post", id: "m1", text: "kept" });
    sent.length = 0;
    handler({ room: "chat:t", kind: "ready" });
    assert.equal(sent.length, 1);
    assert.equal(decode(sent[0].b).msgs.m1.text, "kept");
    handler({ room: "chat:t", kind: "snapshot-due" });
    assert.equal(sent[1].o.snapshot, true);
    handler({ room: "tasks:t", kind: "ready" });
    assert.equal(sent.length, 2, "another room is none of its business");
  });

  test("a local post is sent; a refused one sends nothing", () => {
    const sent = [];
    const doc = { join: () => true, send: (...a) => sent.push(a), onMessage: () => () => {} };
    const ok = createChatSync({ doc, team: "t", me: "ann", roleOf, now });
    assert.equal(ok.do({ op: "post", id: "m1", text: "x" }).ok, true);
    assert.equal(sent.length, 1);
    const no = createChatSync({ doc, team: "t", me: "cy", roleOf, now });
    assert.equal(no.do({ op: "post", id: "m2", text: "x" }).ok, false);
    assert.equal(sent.length, 1);
  });
});

describe("through a real hub", () => {
  const hubs = [];
  const syncs = [];
  after(async () => {
    for (const s of syncs) s.destroy();
    for (const h of hubs) await h.stop();
  });

  function bridge(hub, token) {
    const handlers = new Set();
    const sync = new DocSync({
      hub: hub.base,
      secret: SECRET,
      onEvent: (room, p) => handlers.forEach((h) => h({ room, kind: p.kind, bytes: p.bytes && new Uint8Array(p.bytes) })),
    });
    if (token) sync.token = token;
    syncs.push(sync);
    return { sync, join: (r) => sync.join(r), send: (r, b, o) => sync.send(r, b, o), leave: (r) => sync.leave(r), onMessage: (h) => (handlers.add(h), () => handlers.delete(h)) };
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
    const t = createChatSync({ doc: b, team: "default", me, roleOf: roles, now });
    t.sync = b.sync;
    return t;
  };

  test("the hub relays ciphertext only, and a teammate reads the message", async () => {
    const hub = await startHub({ ZEVET_TOKEN: deriveAuthToken(SECRET) });
    hubs.push(hub);
    const spy = [];
    const raw = new WebSocket(`${hub.base.replace("http", "ws")}/ws?token=${deriveAuthToken(SECRET)}`);
    raw.binaryType = "arraybuffer";
    raw.onmessage = (e) => typeof e.data !== "string" && spy.push(new Uint8Array(e.data));
    await new Promise((r) => (raw.onopen = r));
    raw.send(JSON.stringify({ type: "join", room: "chat:default" }));
    const ann = board(hub, "ann");
    const bo = board(hub, "bo");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ann.do({ op: "post", id: "m1", text: "Secret launch date" }).ok, true);
    await until(() => bo.messages().length === 1, "bo reads the message");
    assert.equal(bo.messages()[0].text, "Secret launch date");
    await until(() => spy.length > 0, "spy saw frames");
    for (const frame of spy) {
      assert.equal(Buffer.from(frame).includes("Secret launch"), false, "plaintext on the relay");
      assert.throws(() => openSealed(deriveDocKey(SECRET), "chat:wrong", frame));
    }
    assert.ok(spy.some((f) => Buffer.from(openSealed(deriveDocKey(SECRET), "chat:default", f)).includes("Secret launch")), "holders of the key can read it");
    raw.close();
  });

  test("a late joiner and a machine that was offline both converge (re-send on reconnect)", async () => {
    const hub = await startHub({ ZEVET_TOKEN: deriveAuthToken(SECRET) });
    hubs.push(hub);
    const ann = board(hub, "ann");
    await new Promise((r) => setTimeout(r, 300));
    ann.do({ op: "post", id: "m1", text: "one" });
    await new Promise((r) => setTimeout(r, 200));
    const late = board(hub, "bo");
    await until(() => late.messages().length === 1, "late joiner converged");
    ann.sync.rooms.get(ann.room).ws.close();
    ann.do({ op: "post", id: "m2", text: "while away" });
    await until(() => late.messages().length === 2, "offline post delivered after reconnect");
    assert.equal(late.messages()[1].text, "while away");
  });

  test("a Viewer's session socket cannot write a chat room; a Commenter's can; a demotion bites", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zevet-chat-"));
    const file = path.join(dir, "accounts.json");
    const a = new Accounts({ file });
    const ownerTok = a.signIn({ login: "AndrewDoft", id: "1" }).token;
    a.allow("cy");
    const cyTok = a.signIn({ login: "cy", id: "2" }).token;
    a.setRole("cy", "viewer", "AndrewDoft");
    const hub = await startHub({ ZEVET_TOKEN: deriveAuthToken(SECRET), ZEVET_ACCOUNTS: file });
    hubs.push(hub);
    const watcher = board(hub, "ann", ownerTok, () => "editor");
    const viewer = board(hub, "cy", cyTok, () => "editor"); // a desktop that LIES about its role
    await new Promise((r) => setTimeout(r, 300));
    viewer.do({ op: "post", id: "v1", text: "from a viewer" });
    watcher.do({ op: "post", id: "e1", text: "from an editor" });
    await until(() => viewer.messages().some((m) => m.id === "e1"), "the viewer still READS the room");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(watcher.messages().some((m) => m.id === "v1"), false, "a viewer's frame reached the room");
    const setRole = (role) => fetch(`${hub.base}/auth/role`, { method: "POST", headers: { "content-type": "application/json", "x-zevet-token": ownerTok }, body: JSON.stringify({ login: "cy", role }) });
    assert.equal((await setRole("commenter")).status, 200);
    viewer.do({ op: "post", id: "k1", text: "now allowed" });
    await until(() => watcher.messages().some((m) => m.id === "k1"), "commenter frame relayed");
    await setRole("viewer");
    viewer.do({ op: "post", id: "k2", text: "after demotion" });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(watcher.messages().some((m) => m.id === "k2"), false);
  });
});
