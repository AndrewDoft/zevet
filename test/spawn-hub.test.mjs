// Starting an agent on a teammate's machine, hub side (D-060). Adversarial:
// it starts a new process with somebody else's credentials, so every refusal
// is pinned — paths for repos, smuggled modes and flags, policy=off, replay,
// forged `from`, oversize, a flood of cards, wrong-person statuses, `started`
// before `accepted`, rate limits — and the "started by" mark on the board.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { startHub, post, TOKEN } from "./helpers.mjs";
import { Accounts } from "../hub/accounts.mjs";

const hubs = [];
const streams = [];
after(async () => {
  for (const s of streams) s.close();
  await Promise.all(hubs.map((h) => h.stop()));
});

async function team(env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-spawn-"));
  const file = path.join(dir, "accounts.json");
  const seed = new Accounts({ file });
  const andrew = seed.signIn({ login: "AndrewDoft", id: "1001" }).token; // owner
  seed.allow("bob");
  const bob = seed.signIn({ login: "bob", id: "2002" }).token;
  seed.allow("mallory");
  const mallory = seed.signIn({ login: "mallory", id: "3003" }).token;
  const hub = await startHub({ ZEVET_ACCOUNTS: file, ...env });
  hubs.push(hub);
  return { hub, andrew, bob, mallory };
}

async function channel(base, token) {
  const ctl = new AbortController();
  const frames = [];
  const res = await fetch(`${base}/events?steer=1`, { headers: { "x-zevet-token": token }, signal: ctl.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const f = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const e = /^event:\s*(.+)$/m.exec(f);
          const d = /^data:\s*(.+)$/m.exec(f);
          if (e && d) frames.push({ name: e[1].trim(), data: JSON.parse(d[1]) });
        }
      }
    } catch {
      /* closed */
    }
  })();
  const s = { frames, close: () => ctl.abort() };
  streams.push(s);
  await waitFor(() => frames.some((f) => f.name === "hello"));
  return s;
}

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 15));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 250));

function spawn(base, token, body) {
  return fetch(`${base}/api/spawn`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zevet-token": token },
    body: JSON.stringify({ id: randomUUID(), to: "bob", repo: "zevet", agent: "codex", sealed: Buffer.from("ciphertext").toString("base64"), ...body }),
  });
}
const setPolicy = (base, token, steer) => fetch(`${base}/api/policy`, { method: "PUT", headers: { "content-type": "application/json", "x-zevet-token": token }, body: JSON.stringify({ steer }) });
const status = (base, token, body) => fetch(`${base}/api/steer/status`, { method: "POST", headers: { "content-type": "application/json", "x-zevet-token": token }, body: JSON.stringify(body) });

describe("spawn: what the hub refuses", () => {
  test("a repo that is a path, not a folder name", async () => {
    const { hub, andrew } = await team({ ZEVET_SPAWN_RATE_MAX: "100" });
    for (const repo of ["../zevet", "..", ".", "a/b", "a\\b", "C:\\dev\\zevet", "/etc", "~/zevet", ".ssh", "a..b", "", "x".repeat(101), "zevet\u0000"]) {
      assert.equal((await spawn(hub.base, andrew, { repo })).status, 400, JSON.stringify(repo));
    }
  });

  test("a mode, a permission or a flag smuggled in the body", async () => {
    const { hub, andrew } = await team({ ZEVET_SPAWN_RATE_MAX: "100" });
    for (const extra of [{ mode: "dangerous" }, { permissionMode: "bypassPermissions" }, { dangerouslySkipPermissions: true }, { permissions: ["*"] }, { allowedTools: ["Bash"] }, { args: ["--yolo"] }, { cwd: "C:\\" }, { env: { X: "1" } }, { engine: "engine2" }, { systemPrompt: "x" }]) {
      const r = await spawn(hub.base, andrew, extra);
      assert.equal(r.status, 400, JSON.stringify(extra));
    }
  });

  test("an agent that is not claude, codex or opencode, and a model that is not a name", async () => {
    const { hub, andrew } = await team();
    for (const extra of [{ agent: "bash" }, { agent: "" }, { model: "--dangerously-skip-permissions" }, { model: "a b" }]) {
      assert.equal((await spawn(hub.base, andrew, extra)).status, 400, JSON.stringify(extra));
    }
  });

  test("policy=off: refused, nothing reaches them", async () => {
    const { hub, andrew, bob } = await team();
    await setPolicy(hub.base, andrew, "off");
    const ch = await channel(hub.base, bob);
    const r = await spawn(hub.base, andrew, {});
    assert.equal(r.status, 403);
    assert.equal((await r.json()).status, "refused-by-policy");
    await settle();
    assert.equal(ch.frames.filter((f) => f.name === "spawn").length, 0);
  });

  test("replay, oversize, shared token", async () => {
    const { hub, andrew, bob } = await team();
    await channel(hub.base, bob);
    const id = randomUUID();
    assert.equal((await spawn(hub.base, andrew, { id })).status, 200);
    assert.equal((await spawn(hub.base, andrew, { id })).status, 409);
    assert.equal((await spawn(hub.base, andrew, { sealed: "A".repeat(16 * 1024 + 4) })).status, 413);
    assert.equal((await spawn(hub.base, TOKEN, {})).status, 401);
  });

  test("a flood of cards: at most three waiting on one person", async () => {
    const { hub, andrew, mallory, bob } = await team();
    await channel(hub.base, bob);
    for (let i = 0; i < 3; i++) assert.equal((await spawn(hub.base, i < 2 ? andrew : mallory, {})).status, 200);
    assert.equal((await spawn(hub.base, andrew, {})).status, 429);
  });

  test("the sender is rate limited", async () => {
    const { hub, andrew } = await team({ ZEVET_SPAWN_RATE_MAX: "2" });
    assert.notEqual((await spawn(hub.base, andrew, {})).status, 429);
    assert.notEqual((await spawn(hub.base, andrew, {})).status, 429);
    assert.equal((await spawn(hub.base, andrew, {})).status, 429);
  });

  test("offline when they have no channel open", async () => {
    const { hub, andrew } = await team();
    const r = await spawn(hub.base, andrew, {});
    assert.equal(r.status, 200);
    assert.equal((await r.json()).status, "offline");
  });
});

describe("spawn: what the hub relays", () => {
  test("only to the target, flagged for approval under ask, from stamped by the hub, prompt sealed", async () => {
    const { hub, mallory, bob, andrew } = await team();
    const bobCh = await channel(hub.base, bob);
    const andrewCh = await channel(hub.base, andrew);
    const r = await spawn(hub.base, mallory, { from: "AndrewDoft", model: "gpt-5.4" });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).approval, true);
    await waitFor(() => bobCh.frames.some((f) => f.name === "spawn"));
    const msg = bobCh.frames.find((f) => f.name === "spawn").data;
    assert.equal(msg.from, "mallory", "a forged from is ignored");
    assert.deepEqual([msg.repo, msg.agent, msg.model, msg.approval], ["zevet", "codex", "gpt-5.4", true]);
    assert.deepEqual(Object.keys(msg).sort(), ["agent", "approval", "at", "from", "id", "model", "repo", "sealed", "to"]);
    await settle();
    assert.equal(andrewCh.frames.filter((f) => f.name === "spawn").length, 0, "never broadcast");
  });

  test("statuses: started only after accepted, only by the target, then marked on everyone's board", async () => {
    const { hub, andrew, bob, mallory } = await team();
    await post(hub.base, { actor: "bob", kind: "prompt", detail: "x", agent: "codex", repo: "zevet", session: "new-sess-1" });
    const andrewCh = await channel(hub.base, andrew);
    await channel(hub.base, bob);
    const id = randomUUID();
    await spawn(hub.base, andrew, { id });
    assert.equal((await status(hub.base, mallory, { id, status: "started", session: "x" })).status, 403);
    assert.equal((await status(hub.base, bob, { id, status: "delivered" })).status, 200);
    assert.equal((await status(hub.base, bob, { id, status: "started", session: "new-sess-1" })).status, 409, "not before accepted");
    assert.equal((await status(hub.base, bob, { id, status: "unknown-agent" })).status, 400);
    assert.equal((await status(hub.base, bob, { id, status: "accepted" })).status, 200);
    assert.equal((await status(hub.base, bob, { id, status: "started", session: "new-sess-1" })).status, 200);
    assert.equal((await status(hub.base, bob, { id, status: "declined" })).status, 409, "started is final");
    await waitFor(() => andrewCh.frames.filter((f) => f.name === "steer-status").length >= 3);
    const seen = andrewCh.frames.filter((f) => f.name === "steer-status").map((f) => f.data);
    assert.deepEqual(seen.map((d) => d.status), ["delivered", "accepted", "started"]);
    assert.equal(seen[2].kind, "spawn");
    assert.equal(seen[2].session, "new-sess-1");
    const state = await fetch(`${hub.base}/api/state`, { headers: { "x-zevet-token": mallory } }).then((r) => r.json());
    const agent = state.agents.find((a) => a.session === "new-sess-1");
    assert.equal(agent.startedBy, "AndrewDoft");
  });

  test("start-failed follows started only, once, and only for a spawn", async () => {
    const { hub, andrew, bob } = await team();
    const andrewCh = await channel(hub.base, andrew);
    await channel(hub.base, bob);
    const id = randomUUID();
    await spawn(hub.base, andrew, { id });
    assert.equal((await status(hub.base, bob, { id, status: "start-failed", reason: "not signed in" })).status, 409, "not before started");
    await status(hub.base, bob, { id, status: "accepted" });
    assert.equal((await status(hub.base, bob, { id, status: "start-failed" })).status, 409, "not straight after accepted");
    assert.equal((await status(hub.base, bob, { id, status: "started", session: "s-f1" })).status, 200);
    assert.equal((await status(hub.base, bob, { id, status: "start-failed", reason: "not signed in", session: "s-f1" })).status, 200);
    assert.equal((await status(hub.base, bob, { id, status: "start-failed" })).status, 409, "final");
    assert.equal((await status(hub.base, bob, { id, status: "declined" })).status, 409, "final");
    await waitFor(() => andrewCh.frames.some((f) => f.name === "steer-status" && f.data.status === "start-failed"));
    const last = andrewCh.frames.filter((f) => f.name === "steer-status").at(-1).data;
    assert.deepEqual([last.kind, last.reason], ["spawn", "not signed in"]);
  });

  test("no-such-repo is a status the owner can report, and it settles", async () => {
    const { hub, andrew, bob } = await team();
    const andrewCh = await channel(hub.base, andrew);
    await channel(hub.base, bob);
    const id = randomUUID();
    await spawn(hub.base, andrew, { id, repo: "nothere" });
    assert.equal((await status(hub.base, bob, { id, status: "no-such-repo", reason: "no open folder named nothere" })).status, 200);
    assert.equal((await status(hub.base, bob, { id, status: "accepted" })).status, 409);
    await waitFor(() => andrewCh.frames.some((f) => f.name === "steer-status"));
    assert.equal(andrewCh.frames.find((f) => f.name === "steer-status").data.status, "no-such-repo");
  });

  test("a steer still cannot report spawn statuses", async () => {
    const { hub, andrew, bob } = await team();
    await post(hub.base, { actor: "bob", kind: "prompt", detail: "x", agent: "codex", repo: "zevet", session: "s1" });
    await channel(hub.base, bob);
    const id = randomUUID();
    await fetch(`${hub.base}/api/steer`, { method: "POST", headers: { "content-type": "application/json", "x-zevet-token": andrew }, body: JSON.stringify({ id, to: "bob", session: "s1", sealed: "QUJD" }) });
    assert.equal((await status(hub.base, bob, { id, status: "started", session: "s1" })).status, 400);
  });
});
