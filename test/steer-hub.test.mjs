// Steering a teammate's agent through the hub, and the team policy that
// governs it (D-058). Adversarial on purpose: a steer is remote prompt
// injection into somebody else's machine, so every refusal is pinned —
// non-admin policy writes, policy=off, replay, oversize, forged `from`,
// unknown agents, wrong recipients, rate limits, shared tokens.
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
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-steer-"));
  const file = path.join(dir, "accounts.json");
  const seed = new Accounts({ file });
  const andrew = seed.signIn({ login: "AndrewDoft", id: "1001" }).token; // owner
  seed.allow("bob");
  const bob = seed.signIn({ login: "bob", id: "2002" }).token;
  seed.allow("mallory");
  const mallory = seed.signIn({ login: "mallory", id: "3003" }).token;
  const hub = await startHub({ ZEVET_ACCOUNTS: file, ...env });
  hubs.push(hub);
  // Bob's codex agent is on the board, as his hook reports it.
  await post(hub.base, { actor: "bob", kind: "prompt", detail: "fix retry", agent: "codex", repo: "zevet", session: "sess-bob-1", machine: "bobpc" });
  return { hub, file, andrew, bob, mallory };
}

/** A desktop's steer channel: every (event, data) frame it receives. */
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

function steer(base, token, body) {
  return fetch(`${base}/api/steer`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zevet-token": token },
    body: JSON.stringify({ id: randomUUID(), to: "bob", session: "sess-bob-1", repo: "zevet", sealed: Buffer.from("ciphertext").toString("base64"), ...body }),
  });
}

function setPolicy(base, token, body) {
  return fetch(`${base}/api/policy`, { method: "PUT", headers: { "content-type": "application/json", "x-zevet-token": token }, body: JSON.stringify(body) });
}

function status(base, token, body) {
  return fetch(`${base}/api/steer/status`, { method: "POST", headers: { "content-type": "application/json", "x-zevet-token": token }, body: JSON.stringify(body) });
}

describe("team policy", () => {
  test("defaults to ask, and every member can read it", async () => {
    const { hub, bob, andrew } = await team();
    const r = await fetch(`${hub.base}/api/policy`, { headers: { "x-zevet-token": bob } }).then((x) => x.json());
    assert.equal(r.policy.steer, "ask");
    assert.equal(r.admin, false);
    const o = await fetch(`${hub.base}/api/policy`, { headers: { "x-zevet-token": andrew } }).then((x) => x.json());
    assert.equal(o.admin, true);
  });

  test("a non-admin PUT is refused and changes nothing", async () => {
    const { hub, bob } = await team();
    const r = await setPolicy(hub.base, bob, { steer: "on" });
    assert.equal(r.status, 403);
    const now = await fetch(`${hub.base}/api/policy`, { headers: { "x-zevet-token": bob } }).then((x) => x.json());
    assert.equal(now.policy.steer, "ask");
  });

  test("a shared-token caller can neither read nor write it", async () => {
    const { hub } = await team();
    assert.equal((await fetch(`${hub.base}/api/policy`, { headers: { "x-zevet-token": TOKEN } })).status, 401);
    assert.equal((await setPolicy(hub.base, TOKEN, { steer: "on" })).status, 401);
  });

  test("only the three values, and only known keys, are accepted", async () => {
    const { hub, andrew } = await team();
    for (const bad of [{ steer: "ON" }, { steer: "maybe" }, { steer: true }, { steer: ["on"] }, { steer: "on", other: "x" }, {}, []]) {
      assert.equal((await setPolicy(hub.base, andrew, bad)).status, 400, JSON.stringify(bad));
    }
    const now = await fetch(`${hub.base}/api/policy`, { headers: { "x-zevet-token": andrew } }).then((x) => x.json());
    assert.equal(now.policy.steer, "ask", "a rejected batch must not half-apply");
  });

  test("the owner's change is stored, survives a reload, and is audited", async () => {
    const { hub, andrew, file } = await team();
    const r = await setPolicy(hub.base, andrew, { steer: "off" });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).policy.steer, "off");
    const reread = new Accounts({ file });
    assert.equal(reread.policy.steer, "off");
    const last = reread.audit.at(-1);
    assert.equal(last.what, "policy.steer");
    assert.equal(last.from, "ask");
    assert.equal(last.to, "off");
    assert.equal(last.by, "andrewdoft");
  });
});

describe("steering", () => {
  test("policy=off: refused by the hub, and nothing reaches the target", async () => {
    const { hub, andrew, bob } = await team();
    await setPolicy(hub.base, andrew, { steer: "off" });
    const ch = await channel(hub.base, bob);
    const r = await steer(hub.base, andrew, {});
    assert.equal(r.status, 403);
    assert.equal((await r.json()).status, "refused-by-policy");
    await settle();
    assert.equal(ch.frames.filter((f) => f.name === "steer").length, 0);
  });

  test("policy=ask: relayed to the target's channel only, flagged for approval, ciphertext only", async () => {
    const { hub, andrew, bob, mallory } = await team();
    const bobCh = await channel(hub.base, bob);
    const malCh = await channel(hub.base, mallory);
    const id = randomUUID();
    const r = await steer(hub.base, andrew, { id });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, "queued");
    assert.equal(body.approval, true);
    await waitFor(() => bobCh.frames.some((f) => f.name === "steer"));
    const msg = bobCh.frames.find((f) => f.name === "steer").data;
    assert.equal(msg.id, id);
    assert.equal(msg.approval, true);
    assert.equal(msg.agent, "codex");
    assert.equal(msg.sealed, Buffer.from("ciphertext").toString("base64"));
    assert.equal(Object.keys(msg).includes("text"), false);
    await settle();
    assert.equal(malCh.frames.filter((f) => f.name === "steer").length, 0, "a steer is never broadcast to the team");
  });

  test("policy=on: relayed without the approval flag", async () => {
    const { hub, andrew, bob } = await team();
    await setPolicy(hub.base, andrew, { steer: "on" });
    const ch = await channel(hub.base, bob);
    const r = await steer(hub.base, andrew, {}).then((x) => x.json());
    assert.equal(r.approval, false);
    await waitFor(() => ch.frames.some((f) => f.name === "steer"));
    assert.equal(ch.frames.find((f) => f.name === "steer").data.approval, false);
  });

  test("a forged `from` is ignored: the hub stamps the caller's own name", async () => {
    const { hub, mallory, bob } = await team();
    const ch = await channel(hub.base, bob);
    await steer(hub.base, mallory, { from: "AndrewDoft" });
    await waitFor(() => ch.frames.some((f) => f.name === "steer"));
    assert.equal(ch.frames.find((f) => f.name === "steer").data.from, "mallory");
  });

  test("replay: one id is relayed once", async () => {
    const { hub, andrew, bob } = await team();
    const ch = await channel(hub.base, bob);
    const id = randomUUID();
    assert.equal((await steer(hub.base, andrew, { id })).status, 200);
    assert.equal((await steer(hub.base, andrew, { id })).status, 409);
    await settle();
    assert.equal(ch.frames.filter((f) => f.name === "steer").length, 1);
  });

  test("oversize: a sealed body past the cap is refused, before or after parsing", async () => {
    const { hub, andrew } = await team();
    assert.equal((await steer(hub.base, andrew, { sealed: "A".repeat(16 * 1024 + 4) })).status, 413);
    assert.equal((await steer(hub.base, andrew, { sealed: "A".repeat(64 * 1024) })).status, 413);
  });

  test("malformed: no id, a bad id, no session, non-base64", async () => {
    const { hub, andrew } = await team();
    for (const bad of [{ id: "" }, { id: "../../x" }, { session: "" }, { sealed: "<script>" }, { to: "" }]) {
      assert.equal((await steer(hub.base, andrew, bad)).status, 400, JSON.stringify(bad));
    }
  });

  test("an agent the board has never seen is refused", async () => {
    const { hub, andrew, bob } = await team();
    await channel(hub.base, bob);
    const r = await steer(hub.base, andrew, { session: "sess-nobody" });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).status, "unknown-agent");
    // Right session, wrong person: still unknown.
    assert.equal((await steer(hub.base, andrew, { to: "mallory" })).status, 404);
  });

  test("no open channel for the target is an honest `offline`", async () => {
    const { hub, andrew } = await team();
    const r = await steer(hub.base, andrew, {});
    assert.equal(r.status, 200);
    assert.equal((await r.json()).status, "offline");
  });

  test("a shared-token caller cannot steer", async () => {
    const { hub } = await team();
    assert.equal((await steer(hub.base, TOKEN, {})).status, 401);
  });

  test("statuses: only the target may report, they reach the sender, and a settled steer stays settled", async () => {
    const { hub, andrew, bob, mallory } = await team();
    const andrewCh = await channel(hub.base, andrew);
    await channel(hub.base, bob);
    const id = randomUUID();
    await steer(hub.base, andrew, { id });
    assert.equal((await status(hub.base, mallory, { id, status: "accepted" })).status, 403, "not sent to mallory");
    assert.equal((await status(hub.base, andrew, { id, status: "accepted" })).status, 403, "the sender cannot accept their own steer");
    assert.equal((await status(hub.base, bob, { id, status: "queued" })).status, 400, "not an owner-side status");
    assert.equal((await status(hub.base, bob, { id, status: "delivered" })).status, 200);
    assert.equal((await status(hub.base, bob, { id, status: "accepted" })).status, 200);
    assert.equal((await status(hub.base, bob, { id, status: "declined" })).status, 409, "accepted is final");
    assert.equal((await status(hub.base, bob, { id: randomUUID(), status: "accepted" })).status, 404);
    await waitFor(() => andrewCh.frames.filter((f) => f.name === "steer-status").length >= 2);
    const seen = andrewCh.frames.filter((f) => f.name === "steer-status").map((f) => f.data.status);
    assert.deepEqual(seen, ["delivered", "accepted"]);
  });

  test("the sender is rate limited", async () => {
    const { hub, andrew } = await team({ ZEVET_STEER_RATE_MAX: "3" });
    for (let i = 0; i < 3; i++) assert.notEqual((await steer(hub.base, andrew, {})).status, 429);
    assert.equal((await steer(hub.base, andrew, {})).status, 429);
  });
});
