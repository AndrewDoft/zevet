// Single sign-in through <family dir>/sso.json (desktop/sso.js): Voice signed in -> Zevet signed in, Zevet signed
// in -> published for Voice, sign-out both ways, replay/forgery/other-hub refused, nothing breaks signed out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const sso = createRequire(import.meta.url)(`${ROOT}/desktop/sso.js`);
const HUB = "https://hub.example";
const KEY = "00112233445566778899aabbccddeeff".repeat(2);
const noRestrict = () => {};

// Sealed by zevet-voice masora_dictation/sso.py (key KEY, nonce 0..11): proves the two implementations agree.
const FROM_PYTHON = { v: 1, alg: "A256GCM", nonce: "AAECAwQFBgcICQoL", ct: "kzZ9xuOwplF4QkxBuQW5RyJ/7KL4WpRMRavbvfQKpb1TrlN68ERwtbsh+du9cIpHuKKcLZF3tlKKsGgnETA/+3hxngPIlxp3VJT3gKu5sbTBGNxGkurvPSS/LKy9H8go/0x2lU7zqVFBJRokkRubyl2s6Lb7vVpx6jJRFsFhqiDyDM1tX7Mvs0mnR6nfOiVMSAir23IVLCFgoPZ90JE=" };

function familyWithKey() {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-sso-"));
  writeFileSync(path.join(dir, "family.key"), KEY, { mode: 0o600 });
  return dir;
}

/** A whoami that knows one live token. */
function hub(live = { "tok-voice": "ana@example.com" }, calls = []) {
  return async (url, opts) => {
    calls.push(url);
    const login = live[opts.headers["x-zevet-token"]];
    if (!url.endsWith("/auth/whoami")) return new Response("{}", { status: 404 });
    return login ? Response.json({ ok: true, login, team: "acme", owner: false }) : Response.json({ error: "no" }, { status: 401 });
  };
}

function app(dir, { session = null, fetchImpl = hub(), now = () => Date.now() } = {}) {
  const state = { session, adopted: [], ended: 0 };
  const s = new sso.Sso({
    dir,
    hub: () => HUB,
    session: () => state.session,
    adopt: (p, who) => {
      state.adopted.push({ p, who });
      state.session = { token: p.token, login: who.login };
    },
    endSession: async () => {
      state.ended++;
      state.session = null;
    },
    fetchImpl,
    now,
  });
  return { s, state };
}

const voicePublishes = (dir, state, fields = {}, at = Date.now()) =>
  writeFileSync(path.join(dir, sso.FILE), JSON.stringify(sso.seal(Buffer.from(KEY), { v: 1, state, hub: HUB, issued_at: at, by: "voice", ...fields })));

test("opens an envelope Voice's Python sealed", () => {
  assert.deepEqual(sso.unseal(Buffer.from(KEY), FROM_PYTHON), {
    v: 1, state: "signed_in", hub: HUB, issued_at: 1760000000000, by: "voice", token: "tok-fixture", login: "ana@example.com",
  });
});

test("a tampered envelope, or one under another key, is not authentic", () => {
  const ct = Buffer.from(FROM_PYTHON.ct, "base64");
  ct[5] ^= 1;
  assert.equal(sso.unseal(Buffer.from(KEY), { ...FROM_PYTHON, ct: ct.toString("base64") }), null);
  assert.equal(sso.unseal(Buffer.from("f".repeat(64)), FROM_PYTHON), null);
  assert.equal(sso.unseal(Buffer.from(KEY), { ...FROM_PYTHON, alg: "none" }), null);
});

test("Voice signed in -> Zevet signs in on the next sync, with the hub's login, after the hub confirms the token", async () => {
  const dir = familyWithKey();
  const calls = [];
  const { s, state } = app(dir, { fetchImpl: hub(undefined, calls) });
  voicePublishes(dir, "signed_in", { token: "tok-voice", login: "claimed@evil.example", provider: "google", secret: "TEAM" });
  assert.equal(await s.sync(), "signed_in");
  assert.equal(state.adopted.length, 1);
  assert.equal(state.adopted[0].p.token, "tok-voice");
  assert.equal(state.adopted[0].p.secret, "TEAM");
  assert.equal(state.adopted[0].who.login, "ana@example.com"); // the hub's answer, not the envelope's claim
  assert.deepEqual(calls, [`${HUB}/auth/whoami`]);
  assert.equal(await s.sync(), null, "the same envelope is applied once");
});

test("Zevet signed in -> published encrypted for Voice; the token never appears in the file", () => {
  const dir = familyWithKey();
  const { s } = app(dir, { session: { token: "tok-zevet-secret-value", login: "ana", provider: "github", secret: "TEAM" } });
  const p = s.publish("signed_in");
  assert.equal(p.state, "signed_in");
  const raw = readFileSync(path.join(dir, sso.FILE), "utf8");
  assert.ok(!raw.includes("tok-zevet-secret-value") && !raw.includes("TEAM"));
  const back = sso.read(dir).payload;
  assert.equal(back.token, "tok-zevet-secret-value");
  assert.equal(back.by, "zevet");
  assert.equal(back.hub, HUB);
});

test("with no envelope yet, a signed-in Zevet seeds one; a signed-out Zevet writes nothing", async () => {
  const dir = familyWithKey();
  assert.equal(await app(dir).s.sync(), null);
  assert.equal(existsSync(path.join(dir, sso.FILE)), false);
  assert.equal(await app(dir, { session: { token: "tok-z", login: "ana" } }).s.sync(), "published");
  assert.equal(sso.read(dir).payload.token, "tok-z");
});

test("sign-out in Voice signs Zevet out; an older envelope replayed afterwards is ignored", async () => {
  const dir = familyWithKey();
  const { s, state } = app(dir);
  const t0 = Date.now() - 10_000;
  voicePublishes(dir, "signed_in", { token: "tok-voice" }, t0);
  const oldEnvelope = readFileSync(path.join(dir, sso.FILE), "utf8");
  assert.equal(await s.sync(), "signed_in");
  voicePublishes(dir, "signed_out", {}, t0 + 1);
  assert.equal(await s.sync(), "signed_out");
  assert.equal(state.ended, 1);
  assert.equal(state.session, null);
  writeFileSync(path.join(dir, sso.FILE), oldEnvelope); // replay
  assert.equal(await s.sync(), null);
  assert.equal(state.session, null);
});

test("Zevet's own sign-out is published, and Zevet does not re-apply its own envelope", async () => {
  const dir = familyWithKey();
  const { s, state } = app(dir, { session: { token: "tok-z" } });
  s.publish("signed_in");
  state.session = null;
  s.publish("signed_out");
  assert.equal(sso.read(dir).payload.state, "signed_out");
  assert.equal(await s.sync(), null);
  assert.equal(state.ended, 0);
});

test("a revoked token is not adopted; an unreachable hub is asked again later, not every poll", async () => {
  const dir = familyWithKey();
  const refused = app(dir, { fetchImpl: hub({}) });
  voicePublishes(dir, "signed_in", { token: "tok-dead" });
  assert.equal(await refused.s.sync(), null);
  assert.equal(refused.state.adopted.length, 0);

  let t = Date.now();
  let calls = 0;
  const down = app(dir, { now: () => t, fetchImpl: async () => { calls++; throw new Error("offline"); } });
  assert.equal(await down.s.sync(), null);
  assert.equal(await down.s.sync(), null);
  assert.equal(calls, 1);
  t += 31_000;
  down.s.fetchImpl = hub({ "tok-dead": "ana" });
  assert.equal(await down.s.sync(), "signed_in");
});

test("a session for another hub, a future stamp, or an envelope with no family.key is never used", async () => {
  const dir = familyWithKey();
  const calls = [];
  const { s, state } = app(dir, { fetchImpl: hub(undefined, calls) });
  writeFileSync(path.join(dir, sso.FILE), JSON.stringify(sso.seal(Buffer.from(KEY), { v: 1, state: "signed_in", hub: "https://evil.example", issued_at: Date.now(), token: "tok-voice" })));
  assert.equal(await s.sync(), null);
  voicePublishes(dir, "signed_in", { token: "tok-voice" }, Date.now() + 5 * 60_000);
  assert.equal(await s.sync(), null);
  assert.deepEqual(calls, [], "the token was never sent anywhere");
  assert.equal(state.adopted.length, 0);

  const bare = mkdtempSync(path.join(tmpdir(), "zevet-sso-"));
  writeFileSync(path.join(bare, sso.FILE), readFileSync(path.join(dir, sso.FILE)));
  assert.equal(await app(bare, { session: { token: "tok-z" } }).s.sync(), null, "exists but unreadable: not overwritten");
});

test("signed out with no family dir at all, nothing throws", async () => {
  const dir = path.join(tmpdir(), `zevet-sso-missing-${process.pid}-${Date.now()}`);
  const { s } = app(dir);
  assert.equal(await s.sync(), null);
  assert.equal(s.publish("signed_in"), null, "nothing to publish signed out");
});

test("a publish that cannot write is swallowed: the sign-in itself stands", () => {
  const dir = familyWithKey();
  writeFileSync(path.join(dir, "blocker"), "");
  const logs = [];
  const s = new sso.Sso({ dir: path.join(dir, "blocker", "sub"), hub: () => HUB, session: () => ({ token: "t" }), adopt() {}, endSession() {}, log: (m) => logs.push(m) });
  assert.equal(s.publish("signed_in"), null);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes("t\""));
});

test("ensureKey: creates a 64-hex key restricted before it is written, and keeps an existing one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-sso-"));
  const seen = [];
  const k = sso.ensureKey(dir, { restrict: (f) => seen.push(readFileSync(f, "utf8")) });
  assert.match(k.toString(), /^[0-9a-f]{64}$/);
  assert.deepEqual(seen, [""], "restricted while still empty");
  assert.equal(sso.ensureKey(dir, { restrict: noRestrict }).toString(), k.toString());
  const masora = familyWithKey();
  assert.equal(sso.ensureKey(masora, { restrict: noRestrict }).toString(), KEY);
});
