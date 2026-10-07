// Advisory path claims (D-070): the store's lifecycle, the sealed relay through
// a REAL hub to a teammate, and that the hub never holds a path in clear.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { startHub, post } from "./helpers.mjs";
import { Accounts } from "../hub/accounts.mjs";
import * as docCrypto from "../client/doc-crypto.mjs";

const require = createRequire(import.meta.url);
const { ClaimStore, applyFrame, claimBody, claimsAsActive, openClaim } = require("../desktop/claims.js");
const { classifyOverlap } = require("../desktop/overlap-check.js");

const SECRET_PATH = "secret-project/payroll/db.ts";
const key = randomBytes(32);

describe("claim lifecycle", () => {
  test("a claim broadcasts the session's whole set; release and session end broadcast the removal", () => {
    const now = 1000;
    const sent = [];
    const store = new ClaimStore({ now: () => now, broadcast: (actor, session, entry) => sent.push({ actor, session, paths: entry && entry.paths }) });
    store.claim({ paths: ["src/a.ts"], session: "s1", actor: "andrew" });
    store.claim({ path: "src/b.ts", session: "s1", actor: "andrew" });
    assert.deepEqual(sent.at(-1).paths, ["src/a.ts", "src/b.ts"]);
    store.release({ session: "s1", path: "src/a.ts" });
    assert.deepEqual(sent.at(-1).paths, ["src/b.ts"]);
    assert.equal(store.isClaimed("src/a.ts"), false);
    store.endSession("s1");
    assert.equal(sent.at(-1).paths, null, "a release is broadcast, not just forgotten");
    assert.equal(store.claims().length, 0);
  });

  test("a claim expires after its timeout, and the expiry is broadcast too", () => {
    let now = 1000;
    const sent = [];
    const store = new ClaimStore({ now: () => now, broadcast: (a, s, entry) => sent.push(entry) });
    store.claim({ path: "src/a.ts", session: "s2", actor: "andrew", timeoutMs: 5000 });
    now = 5999;
    assert.equal(store.isClaimed("src/a.ts"), true);
    now = 6001;
    assert.equal(store.isClaimed("src/a.ts"), false);
    assert.equal(sent.at(-1), null);
  });

  test("a claim never outlives the hour cap, whatever timeout is asked for", () => {
    const store = new ClaimStore({ now: () => 0 });
    assert.equal(store.claim({ path: "a.ts", session: "s", timeoutMs: 1e12 }).expiresAt, 60 * 60 * 1000);
  });
});

describe("sealing", () => {
  test("the sealed frame opens for its session only, and not under another key", () => {
    const body = claimBody(docCrypto, key, "andrew", "s1", entryOf({ session: "s1" }));
    assert.doesNotMatch(JSON.stringify(body), /payroll|secret-project/);
    assert.deepEqual(openClaim(docCrypto, key, body).paths, [SECRET_PATH]);
    assert.equal(openClaim(docCrypto, key, { ...body, session: "s2" }), null, "replayed under another session");
    assert.equal(openClaim(docCrypto, randomBytes(32), body), null, "a different team secret");
  });
});

/* ---- through a real hub -------------------------------------------------- */

const hubs = [];
const streams = [];
after(async () => {
  for (const s of streams) s.close();
  await Promise.all(hubs.map((h) => h.stop()));
});

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

async function team() {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-claims-"));
  const file = path.join(dir, "accounts.json");
  const seed = new Accounts({ file });
  const andrew = seed.signIn({ login: "AndrewDoft", id: "1001" }).token;
  seed.allow("bob");
  const bob = seed.signIn({ login: "bob", id: "2002" }).token;
  const events = path.join(dir, "events.jsonl");
  const hub = await startHub({ ZEVET_ACCOUNTS: file, ZEVET_EVENTS: events });
  hubs.push(hub);
  return { hub, andrew, bob, events };
}

function entryOf(over = {}) {
  return { actor: "andrew", session: "sess-a", repo: "zevet", paths: [SECRET_PATH], expiresAt: Date.now() + 60000, ...over };
}
const send = (hub, body) => post(hub.base, body);
const stateOf = (hub, token) => fetch(`${hub.base}/api/state`, { headers: { "x-zevet-token": token } }).then((r) => r.json());

describe("through the hub", () => {
  test("a claim is sealed, relayed, and a teammate's app opens it; release and a late joiner follow", async () => {
    const { hub, bob } = await team();
    const mine = await channel(hub.base, bob);
    const store = new ClaimStore();
    const feed = (ch, name) => ch.frames.filter((f) => f.name === name).forEach((f) => applyFrame(store, name, f.data, { docCrypto, key }));

    assert.equal((await send(hub, claimBody(docCrypto, key, "andrew", "sess-a", entryOf()))).status, 200);
    await waitFor(() => mine.frames.some((f) => f.name === "claim"));
    feed(mine, "claim");
    assert.deepEqual(store.claims().map((c) => [c.actor, c.session, c.paths]), [["andrew", "sess-a", [SECRET_PATH]]]);

    // Somebody who connects later still learns of it.
    const late = await channel(hub.base, bob);
    await waitFor(() => late.frames.some((f) => f.name === "claim"));

    assert.equal((await send(hub, claimBody(docCrypto, key, "andrew", "sess-a", null))).status, 200);
    await waitFor(() => mine.frames.some((f) => f.name === "claim-release"));
    feed(mine, "claim-release");
    assert.equal(store.claims().length, 0, "a release disappears for the teammate");

    const after = await channel(hub.base, bob);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(after.frames.some((f) => f.name === "claim"), false, "and for someone who joins afterwards");
  });

  test("the hub never holds a path in clear: not on the wire, not in its log, not on the board", async () => {
    const { hub, bob, andrew, events } = await team();
    const ch = await channel(hub.base, bob);
    await send(hub, claimBody(docCrypto, key, "andrew", "sess-a", entryOf()));
    await waitFor(() => ch.frames.some((f) => f.name === "claim"));
    const wire = JSON.stringify(ch.frames);
    const state = JSON.stringify(await stateOf(hub, andrew));
    let log = "";
    try {
      log = readFileSync(events, "utf8");
    } catch {
      /* no log is fine: it holds nothing */
    }
    for (const [where, text] of [["the wire", wire], ["the board", state], ["the event log", log]]) {
      assert.doesNotMatch(text, /payroll|secret-project|db\.ts/, `a path reached ${where}`);
    }
  });

  test("a claim is not an agent turn: no event, and a real agent's state is untouched", async () => {
    const { hub, andrew } = await team();
    await send(hub, { actor: "andrew", kind: "turn_end", repo: "zevet", session: "sess-a", agent: "claude-code", machine: "m" });
    const before = await stateOf(hub, andrew);
    await send(hub, claimBody(docCrypto, key, "andrew", "sess-a", entryOf()));
    await send(hub, claimBody(docCrypto, key, "andrew", "sess-other", entryOf({ session: "sess-other" })));
    const now = await stateOf(hub, andrew);
    assert.equal(now.events.length, before.events.length);
    assert.deepEqual(now.agents.map((a) => [a.session, a.ended]), before.agents.map((a) => [a.session, a.ended]));
  });

  test("a claim must be a sealed base64 blob for a session; anything else is refused", async () => {
    const { hub } = await team();
    const bad = [
      { kind: "claim", actor: "a", session: "s" },
      { kind: "claim", actor: "a", session: "s", claim: "not base64!" },
      { kind: "claim", actor: "a", claim: "QUJD" },
      { kind: "claim", actor: "a", session: "s", claim: "A".repeat(40000) },
    ];
    for (const b of bad) assert.equal((await send(hub, b)).status, 400, JSON.stringify(b).slice(0, 60));
  });

  test("advisory: another agent's write to a claimed file is accepted and shown", async () => {
    const { hub, andrew } = await team();
    await send(hub, claimBody(docCrypto, key, "andrew", "sess-a", entryOf({ paths: ["src/db.ts"] })));
    const r = await send(hub, { actor: "bob", kind: "tool", tool: "Edit", target: "src/db.ts", repo: "zevet", session: "sess-b", machine: "m2" });
    assert.equal(r.status, 200);
    const s = await stateOf(hub, andrew);
    assert.ok(s.events.some((e) => e.actor === "bob" && e.target === "src/db.ts"));
  });
});

describe("claims feed the overlap check", () => {
  test("a teammate's claim on a planned path is overlapping; my own session's is not", async () => {
    const store = new ClaimStore();
    store.put({ actor: "Kai", session: "s-kai", repo: "zevet", paths: ["src/db.ts"], expiresAt: Date.now() + 1000 });
    store.put({ actor: "me", session: "s-me", repo: "zevet", paths: ["src/db.ts"], expiresAt: Date.now() + 1000 });
    const run = (skip, repo = "zevet") =>
      classifyOverlap({ task: "fix db", plannedPaths: ["src/db.ts"], active: claimsAsActive(store.claims(), { skip, repo }) });
    const hits = await run("s-me");
    assert.deepEqual(hits.map((h) => [h.actor, h.label, h.claimed]), [["Kai", "overlapping", true]]);
    assert.equal((await run("s-me", "other-repo")).length, 0, "another repo's db.ts is not this one");
    store.drop("Kai", "s-kai");
    assert.equal((await run("s-me")).length, 0, "a released claim stops overlapping");
  });

  test("a claim in the same folder is adjacent, not overlapping", async () => {
    const hits = await classifyOverlap({
      task: "x",
      plannedPaths: ["src/a.ts"],
      active: claimsAsActive([{ actor: "Kai", session: "k", repo: "", paths: ["src/b.ts"] }]),
    });
    assert.equal(hits[0].label, "adjacent");
  });
});
