// The Masora Forum bridge: Masora acts on the hub AS a signed-in member (hub/masora-bridge.mjs, GET /masora/board,
// POST /masora/steer, POST /masora/approval). Pinned: the assertion gate, that nothing is created for a stranger, that a
// sealed steer / answer opens with the CLIENT's own crypto and AAD, and that the hub's policy, role and arbitration
// still apply because the cores are shared with /api/steer and /api/approval/answer.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHub, post } from "./helpers.mjs";
import { Accounts } from "../hub/accounts.mjs";
import { deriveDocKey } from "../client/secret.mjs";
import * as docCrypto from "../client/doc-crypto.mjs";
import * as bridge from "../hub/masora-bridge.mjs";

const require = createRequire(import.meta.url);
const ap = require("../desktop/agent-approval.js");
const st = require("../desktop/agent-steer.js");

const SECRET = "m".repeat(40);
const hubs = [];
const streams = [];
after(async () => {
  for (const s of streams) s.close();
  await Promise.all(hubs.map((h) => h.stop()));
});

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function assertion(email, over = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { typ: "zevet_hub_assertion", aud: "zevet-hub", iat: now, exp: now + 30, jti: randomUUID(), sub: "p", email, name: email, wid: "W1", workspace: "Acme", ...over };
  const head = b64({ alg: "HS256", typ: "JWT" }), body = b64(claims);
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}
const call = (hub, who, route, body, over) =>
  fetch(`${hub.base}/masora/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-masora-assertion": who.startsWith("ey") ? who : assertion(who, over) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function team(env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-bridge-"));
  const file = path.join(dir, "accounts.json");
  const seed = new Accounts({ file });
  const andrew = seed.signIn({ login: "AndrewDoft", id: "1001", emails: ["andrew@acme.test"] }).token; // owner
  seed.allow("bob");
  const bob = seed.signIn({ login: "bob", id: "2002", emails: ["bob@acme.test"] }).token;
  seed.allow("viewer");
  seed.signIn({ login: "viewer", id: "3003", emails: ["viewer@acme.test"] });
  seed.setRole("viewer", "viewer", "test");
  const key = deriveDocKey(seed.secret);
  const hub = await startHub({ ZEVET_ACCOUNTS: file, ZEVET_MASORA_SECRET: SECRET, ZEVET_MASORA_TEAMS: "W1=default", ...env });
  hubs.push(hub);
  await post(hub.base, { actor: "bob", kind: "prompt", detail: "fix retry", agent: "codex", repo: "zevet", session: "sess-bob-1", machine: "bobpc" });
  await post(hub.base, { actor: "AndrewDoft", kind: "prompt", detail: "ship it", agent: "claude-code", repo: "masora", session: "sess-andrew-1", machine: "apc" });
  return { hub, file, key, andrew, bob };
}

async function channel(base, token) {
  const ctl = new AbortController();
  const frames = [];
  const res = await fetch(`${base}/events?steer=1`, { headers: { "x-zevet-token": token }, signal: ctl.signal });
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
    } catch { /* closed */ }
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
const put = (hub, tok, body) => fetch(`${hub.base}/api/policy`, { method: "PUT", headers: { "content-type": "application/json", "x-zevet-token": tok }, body: JSON.stringify(body) });

describe("masora-bridge crypto is the client's", () => {
  const secret = "ab".repeat(24);
  test("the document key is the client's", () => {
    assert.deepEqual(bridge.docKeyOf(secret), deriveDocKey(secret));
    assert.equal(bridge.docKeyOf("zz"), null);
  });
  test("seal and open interoperate in both directions", () => {
    const key = deriveDocKey(secret);
    const mine = bridge.seal(key, "room", "héllo");
    assert.equal(docCrypto.open(key, "room", Buffer.from(mine, "base64")).toString("utf8"), "héllo");
    assert.equal(bridge.open(key, "room", docCrypto.seal(key, "room", "back").toString("base64")), "back");
    assert.throws(() => bridge.open(key, "other", mine));
  });
  test("the AADs are the desktop's", () => {
    assert.equal(bridge.steerAad({ id: "i", to: "@Bob", session: "s" }), st._internals.aadFor({ id: "i", to: "@Bob", session: "s" }));
    assert.equal(bridge.cardAad({ id: "i", session: "s" }), ap._internals.cardAad({ id: "i", session: "s" }));
    assert.equal(bridge.answerAad({ id: "i", session: "s", hash: "h" }), ap._internals.answerAad({ id: "i", session: "s", hash: "h" }));
  });
});

describe("the gate", () => {
  test("off without the shared secret", async () => {
    const { hub } = await team({ ZEVET_MASORA_SECRET: "" });
    assert.equal((await call(hub, "andrew@acme.test", "board")).status, 503);
  });
  test("a forged, expired or replayed assertion is 401", async () => {
    const { hub } = await team();
    const good = assertion("andrew@acme.test");
    assert.equal((await call(hub, good, "board")).status, 200);
    assert.equal((await call(hub, good, "board")).status, 401, "replay");
    assert.equal((await call(hub, "andrew@acme.test", "board", undefined, { exp: 1 })).status, 401);
    assert.equal((await call(hub, assertion("andrew@acme.test").slice(0, -3) + "AAA", "board")).status, 401);
    assert.equal((await fetch(`${hub.base}/masora/board`)).status, 401);
  });
  test("a workspace without a team is 404 and nobody is created", async () => {
    const { hub, file } = await team();
    assert.equal((await call(hub, "andrew@acme.test", "board", undefined, { wid: "W9" })).status, 404);
    assert.equal(new Accounts({ file }).refByEmail("nobody@acme.test"), null);
  });
  test("an email that is not a signed-in member is 403 and creates nobody", async () => {
    const { hub, file } = await team();
    assert.equal((await call(hub, "stranger@acme.test", "board")).status, 403);
    assert.equal((await call(hub, "stranger@acme.test", "steer", { actor: "bob", session: "sess-bob-1", text: "hi" })).status, 403);
    assert.equal(new Accounts({ file }).refByEmail("stranger@acme.test"), null);
  });
});

describe("GET /masora/board", () => {
  test("agents carry their person's proven emails and logins; events come with them", async () => {
    const { hub } = await team();
    const b = await (await call(hub, "andrew@acme.test", "board")).json();
    const bob = b.agents.find((a) => a.session === "sess-bob-1");
    assert.deepEqual(bob.emails, ["bob@acme.test"]);
    assert.deepEqual(bob.logins, ["bob"]);
    assert.equal(bob.approval, null);
    assert.equal(bob.mission, "fix retry");
    assert.ok(b.events.some((e) => e.session === "sess-bob-1"));
  });
  test("an actor name nobody owns carries no identity", async () => {
    const { hub } = await team();
    await post(hub.base, { actor: "ghost", kind: "prompt", detail: "x", agent: "codex", repo: "r", session: "sess-ghost", machine: "g" });
    const b = await (await call(hub, "andrew@acme.test", "board")).json();
    assert.deepEqual(b.agents.find((a) => a.session === "sess-ghost").emails, []);
  });
});

describe("POST /masora/steer", () => {
  test("seals as the caller, attributed to them, and the desktop opens it", async () => {
    const { hub, key, andrew, bob } = await team();
    assert.equal((await put(hub, andrew, { steer: "on" })).status, 200);
    const ch = await channel(hub.base, bob);
    const r = await call(hub, "andrew@acme.test", "steer", { actor: "bob", session: "sess-bob-1", text: "use the retry helper" });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.status, "queued");
    assert.equal(out.approval, false);
    await waitFor(() => ch.frames.some((f) => f.name === "steer"));
    const f = ch.frames.find((x) => x.name === "steer").data;
    assert.equal(f.from, "AndrewDoft", "stamped from the assertion's member, not the body");
    assert.equal(f.to, "bob");
    assert.equal(st._internals.open(docCrypto, key, { id: f.id, to: f.to, session: f.session }, f.sealed), "use the retry helper");
  });
  test("policy off, viewer role, unknown agent, offline owner and bad bodies are refused, not dropped", async () => {
    const { hub, andrew, bob } = await team();
    const steer = (who, over) => call(hub, who, "steer", { actor: "bob", session: "sess-bob-1", text: "x", ...over });
    await put(hub, andrew, { steer: "off" });
    assert.equal((await steer("andrew@acme.test")).status, 403);
    await put(hub, andrew, { steer: "on" });
    assert.equal((await steer("viewer@acme.test")).status, 403, "role gate");
    assert.equal((await steer("andrew@acme.test", { session: "nope" })).status, 404);
    assert.equal((await (await steer("andrew@acme.test")).json()).status, "offline", "no desktop channel open");
    assert.equal((await steer("andrew@acme.test", { text: "" })).status, 400);
    assert.equal((await steer("andrew@acme.test", { text: "x".repeat(4001) })).status, 400);
  });
  test("policy ask relays it flagged for the owner's approval", async () => {
    const { hub, andrew, bob } = await team();
    const ch = await channel(hub.base, bob);
    const out = await (await call(hub, "andrew@acme.test", "steer", { actor: "bob", session: "sess-bob-1", text: "x" })).json();
    assert.equal(out.approval, true);
    await waitFor(() => ch.frames.some((f) => f.name === "steer"));
    assert.equal(ch.frames.find((f) => f.name === "steer").data.approval, true);
  });
});

describe("POST /masora/approval", () => {
  const CMD = { command: "rm -rf build/" };
  /** The card bob's desktop publishes. */
  async function openCard(hub, bob, key, id = randomUUID()) {
    const hash = ap.actionHash("Bash", CMD);
    const nonce = "n".repeat(16);
    const sealed = ap.sealCard(docCrypto, key, { id, session: "sess-bob-1" }, { tool: "Bash", arguments: JSON.stringify(CMD), hash, nonce, agent: "codex", repo: "zevet" });
    const r = await fetch(`${hub.base}/api/approval/open`, { method: "POST", headers: { "content-type": "application/json", "x-zevet-token": bob }, body: JSON.stringify({ id, session: "sess-bob-1", repo: "zevet", sealed }) });
    assert.equal(r.status, 200);
    return { id, hash, nonce };
  }

  test("the board shows the open card as text on its agent", async () => {
    const { hub, key, andrew, bob } = await team();
    await put(hub, andrew, { approve: "on" });
    const c = await openCard(hub, bob, key);
    const b = await (await call(hub, "andrew@acme.test", "board")).json();
    const agent = b.agents.find((a) => a.session === "sess-bob-1");
    assert.equal(agent.approval.id, c.id);
    assert.match(agent.approval.text, /^Bash .*rm -rf build/);
  });
  test("an answer the desktop accepts: sealed with the card's nonce and hash, once, first wins", async () => {
    const { hub, key, andrew, bob } = await team();
    await put(hub, andrew, { approve: "on" });
    const ch = await channel(hub.base, bob);
    const c = await openCard(hub, bob, key);
    const ok = await call(hub, "andrew@acme.test", "approval", { id: c.id, decision: "allow" });
    assert.equal(ok.status, 200);
    await waitFor(() => ch.frames.some((f) => f.name === "approval-answer"));
    const f = ch.frames.find((x) => x.name === "approval-answer").data;
    assert.equal(f.by, "AndrewDoft");
    const opened = ap.openAnswer(docCrypto, key, { id: c.id, session: "sess-bob-1", hash: c.hash }, f.sealed);
    assert.deepEqual(opened, { nonce: c.nonce, hash: c.hash, decision: "allow" });
    assert.equal((await call(hub, "andrew@acme.test", "approval", { id: c.id, decision: "deny" })).status, 409, "already decided");
  });
  test("policy off, viewer role, own agent, unknown id and a bad decision are refused", async () => {
    const { hub, key, andrew, bob } = await team();
    await put(hub, andrew, { approve: "on" });
    const c = await openCard(hub, bob, key);
    await put(hub, andrew, { approve: "off" });
    assert.equal((await call(hub, "andrew@acme.test", "approval", { id: c.id, decision: "allow" })).status, 403, "policy off");
    await put(hub, andrew, { approve: "on" });
    assert.equal((await call(hub, "viewer@acme.test", "approval", { id: c.id, decision: "allow" })).status, 403);
    assert.equal((await call(hub, "bob@acme.test", "approval", { id: c.id, decision: "allow" })).status, 400, "your own agent");
    assert.equal((await call(hub, "andrew@acme.test", "approval", { id: "nope", decision: "allow" })).status, 404);
    assert.equal((await call(hub, "andrew@acme.test", "approval", { id: c.id, decision: "maybe" })).status, 400);
  });
});
