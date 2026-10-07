// Invite into a selected session (D-090): the joiner's five checks in
// order (member, role, seat, push, agent), one actionable error, Viewer
// read-only, and the sealed session reference end to end through a real hub.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHub, post } from "./helpers.mjs";
import { Accounts } from "../hub/accounts.mjs";
import { checkJoin, createInviteStore, INVITE_TTL_MS } from "../hub/session-share.mjs";
import { deriveDocKey } from "../client/secret.mjs";
import * as docCrypto from "../client/doc-crypto.mjs";

const require = createRequire(import.meta.url);
const share = require("../desktop/session-share.js");
const KEY = deriveDocKey("cd".repeat(24));

const ROLE_RANK = { viewer: 0, commenter: 1, editor: 2, owner: 3 };
const NEED = { comment: "commenter", steer: "editor" };
const invite = (mode = "edit") => ({ mode, repo: "zevet", actor: "bob" });
/** A fully passing join; each test breaks one thing. */
const ctx = (over = {}) => {
  const role = over.role === undefined ? "editor" : over.role;
  return {
    invite: invite(),
    role,
    can: (a) => role !== null && ROLE_RANK[role] >= ROLE_RANK[NEED[a]],
    mode: "edit",
    pushAccess: true,
    agentOnBoard: true,
    agentOnline: true,
    ...over,
  };
};
const failure = (r) => (r.ok ? "ok" : `${r.check}: ${r.error}`);

describe("the five checks", () => {
  test("all pass: an Editor edits, seat is recorded as skipped", () => {
    const r = checkJoin(ctx());
    assert.deepEqual([r.ok, r.mode, r.readOnly, r.skipped], [true, "edit", false, ["seat"]]);
  });

  test("1 member: a non-member is told to join the team", () => {
    assert.equal(failure(checkJoin(ctx({ role: null }))), "member: Join the team first");
  });

  test("2 role: each mode names the role to ask for", () => {
    assert.equal(failure(checkJoin(ctx({ role: "viewer" }))), "role: Ask the owner for Editor");
    assert.equal(failure(checkJoin(ctx({ role: "commenter" }))), "role: Ask the owner for Editor");
    assert.equal(failure(checkJoin(ctx({ role: "viewer", mode: "comment" }))), "role: Ask the owner for Commenter");
    assert.equal(checkJoin(ctx({ role: "commenter", mode: "comment" })).ok, true);
    assert.equal(checkJoin(ctx({ role: "viewer", mode: "watch" })).ok, true);
  });

  test("2 role: a mode above what the invite grants is refused", () => {
    assert.equal(failure(checkJoin(ctx({ invite: invite("watch"), mode: "edit" }))), "role: This invite is watch only");
    assert.equal(failure(checkJoin(ctx({ mode: "root" }))), "role: Pick watch, comment or edit");
  });

  test("4 push: only an editing joiner is checked; false and unknown differ", () => {
    assert.equal(failure(checkJoin(ctx({ pushAccess: false }))), "push: No push access to zevet. Ask for it on GitHub");
    assert.equal(failure(checkJoin(ctx({ pushAccess: null }))), "push: Open zevet in Zevet to check push access");
    assert.equal(checkJoin(ctx({ mode: "watch", pushAccess: false })).ok, true);
    assert.equal(checkJoin(ctx({ mode: "comment", pushAccess: false, role: "commenter" })).ok, true);
  });

  test("5 agent: gone is Session ended; offline only blocks editing", () => {
    assert.equal(failure(checkJoin(ctx({ agentOnBoard: false }))), "agent: Session ended");
    assert.equal(failure(checkJoin(ctx({ agentOnline: false }))), "agent: bob is offline. Try when they are back");
    assert.equal(checkJoin(ctx({ agentOnline: false, mode: "watch" })).ok, true);
  });

  test("a Viewer joining watches read-only", () => {
    const r = checkJoin(ctx({ role: "viewer", mode: "watch", pushAccess: null, agentOnline: false }));
    assert.equal(r.ok, true);
    assert.equal(r.readOnly, true);
  });

  test("order: the first failing check wins, whatever else is wrong", () => {
    const everything = { role: null, pushAccess: false, agentOnBoard: false, agentOnline: false };
    assert.equal(failure(checkJoin(ctx(everything))), "member: Join the team first");
    assert.equal(failure(checkJoin(ctx({ ...everything, role: "viewer" }))), "role: Ask the owner for Editor");
    assert.equal(failure(checkJoin(ctx({ ...everything, role: "editor" }))), "push: No push access to zevet. Ask for it on GitHub");
    assert.equal(failure(checkJoin(ctx({ pushAccess: true, agentOnBoard: false, agentOnline: false }))), "agent: Session ended");
  });

  test("a failure is exactly one error: ok, check, error, status and nothing else", () => {
    const r = checkJoin(ctx({ role: "viewer", pushAccess: false, agentOnBoard: false }));
    assert.deepEqual(Object.keys(r).sort(), ["check", "error", "ok", "status"]);
    assert.equal(typeof r.error, "string");
  });
});

test("invites expire", () => {
  let t = 1000;
  const store = createInviteStore({ now: () => t });
  store.add("t", { id: "abcdefgh" });
  assert.ok(store.get("t", "abcdefgh"));
  t += INVITE_TTL_MS + 1;
  assert.equal(store.get("t", "abcdefgh"), null);
});

describe("through a real hub", () => {
  const hubs = [];
  const aborts = [];
  after(async () => {
    for (const a of aborts) a.abort();
    await Promise.all(hubs.map((h) => h.stop()));
  });

  async function setup() {
    const dir = mkdtempSync(path.join(tmpdir(), "zevet-session-share-"));
    const file = path.join(dir, "accounts.json");
    const a = new Accounts({ file });
    const tok = { andrew: a.signIn({ login: "AndrewDoft", id: "1001" }).token };
    for (const [login, id, role] of [["bob", "2002", "editor"], ["vic", "3003", "viewer"], ["cam", "4004", "commenter"], ["eve", "5005", "editor"]]) {
      a.allow(login);
      tok[login] = a.signIn({ login, id }).token;
      a.setRole(login, role, "AndrewDoft");
    }
    const hub = await startHub({ ZEVET_ACCOUNTS: file });
    hubs.push(hub);
    await post(hub.base, { actor: "bob", kind: "prompt", detail: "fix retry", agent: "codex", repo: "zevet", session: "sess-bob-1", machine: "bobpc" });
    const call = (token, route, body) =>
      fetch(`${hub.base}${route}`, { method: "POST", headers: { "content-type": "application/json", "x-zevet-token": token }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
    const invitation = async (mode = "edit") => {
      const r = await share.sendInvite({ hub: hub.base, token: tok.bob, key: KEY, docCrypto, session: "sess-bob-1", mode });
      assert.equal(r.ok, true, r.error);
      return r.id;
    };
    /** Bob's desktop comes online. */
    const online = async () => {
      const ctl = new AbortController();
      aborts.push(ctl);
      const res = await fetch(`${hub.base}/events?steer=1`, { headers: { "x-zevet-token": tok.bob }, signal: ctl.signal });
      assert.equal(res.status, 200);
      await new Promise((r) => setTimeout(r, 100));
    };
    return { hub, tok, call, invitation, online };
  }

  test("creating: needs Editor, a live session, and being its person or the owner", async () => {
    const { tok, call } = await setup();
    const body = { id: "11111111-aaaa", session: "sess-bob-1", mode: "watch", sealed: "AAAA" };
    assert.equal((await call(tok.vic, "/api/session-invite", body)).status, 403);
    const eve = await call(tok.eve, "/api/session-invite", body);
    assert.equal(eve.status, 403);
    assert.match(eve.error, /Only bob or the owner/);
    const gone = await call(tok.bob, "/api/session-invite", { ...body, session: "nope" });
    assert.deepEqual([gone.status, gone.error], [404, "Session ended"]);
    assert.equal((await call(tok.bob, "/api/session-invite", body)).status, 200);
    assert.equal((await call(tok.andrew, "/api/session-invite", { ...body, id: "22222222-bbbb" })).status, 200);
    assert.equal((await call(tok.bob, "/api/session-invite", { ...body, id: "33333333-cccc", mode: "root" })).status, 400);
  });

  test("a Viewer joins read-only, and is refused editing with one error", async () => {
    const { tok, call, invitation } = await setup();
    const id = await invitation("edit");
    const ro = await call(tok.vic, "/api/session-invite/join", { id, mode: "watch" });
    assert.deepEqual([ro.status, ro.ok, ro.readOnly, ro.mode, ro.session], [200, true, true, "watch", "sess-bob-1"]);
    const no = await call(tok.vic, "/api/session-invite/join", { id });
    assert.deepEqual([no.status, no.check, no.error], [403, "role", "Ask the owner for Editor"]);
    assert.deepEqual(Object.keys(no).sort(), ["check", "error", "ok", "status"]);
  });

  test("a Commenter comments; an Editor needs push, then the owner's desktop online", async () => {
    const { tok, call, invitation, online } = await setup();
    const id = await invitation("edit");
    assert.equal((await call(tok.cam, "/api/session-invite/join", { id, mode: "comment" })).ok, true);
    const none = await call(tok.eve, "/api/session-invite/join", { id });
    assert.deepEqual([none.check, none.repo], ["push", "zevet"]);
    const denied = await call(tok.eve, "/api/session-invite/join", { id, push: false });
    assert.equal(denied.error, "No push access to zevet. Ask for it on GitHub");
    const offline = await call(tok.eve, "/api/session-invite/join", { id, push: true });
    assert.deepEqual([offline.check, offline.error], ["agent", "bob is offline. Try when they are back"]);
    await online();
    const ok = await call(tok.eve, "/api/session-invite/join", { id, push: true });
    assert.deepEqual([ok.ok, ok.readOnly, ok.mode], [true, false, "edit"]);
  });

  test("an unknown or foreign invite is one error", async () => {
    const { tok, call } = await setup();
    const r = await call(tok.eve, "/api/session-invite/join", { id: "does-not-exist" });
    assert.deepEqual([r.status, r.check], [404, "invite"]);
  });

  test("the desktop: probes push only when the hub asks, then opens the sealed reference", async () => {
    const { hub, tok, invitation, online } = await setup();
    await online();
    const id = await invitation("edit");
    const probed = [];
    const join = (probe, key = KEY) =>
      share.joinInvite({ hub: hub.base, token: tok.eve, key, docCrypto, id, mode: "edit", resolveRepo: (n) => (n === "zevet" ? "/work/zevet" : null), probe: async (d) => (probed.push(d), probe) });
    const no = await join(false);
    assert.deepEqual([no.ok, no.error], [false, "No push access to zevet. Ask for it on GitHub"]);
    const yes = await join(true);
    assert.deepEqual([yes.ok, yes.mode, yes.readOnly, yes.session, yes.repo], [true, "edit", false, "sess-bob-1", "zevet"]);
    assert.deepEqual(probed, ["/work/zevet", "/work/zevet"]);
    // Watching never probes.
    probed.length = 0;
    const w = await share.joinInvite({ hub: hub.base, token: tok.vic, key: KEY, docCrypto, id, mode: "watch", probe: async (d) => (probed.push(d), true) });
    assert.deepEqual([w.ok, w.readOnly, probed.length], [true, true, 0]);
    // A different team secret cannot open the sealed reference.
    const wrong = await join(true, deriveDocKey("ef".repeat(24)));
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /did not open/);
  });
});
