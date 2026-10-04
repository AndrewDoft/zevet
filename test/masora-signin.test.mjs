// "Sign in with Masora": a Masora-signed assertion signs a person into their workspace's team, no second login.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHub } from "./helpers.mjs";
import { verifyAssertion, replayGuard, parseTeamMap } from "../hub/masora-auth.mjs";

const SECRET = "m".repeat(40);
const hubs = [];
after(async () => { for (const h of hubs) await h.stop(); });

const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function mint(over = {}, { secret = SECRET, alg = "HS256" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { typ: "zevet_hub_assertion", aud: "zevet-hub", iat: now, exp: now + 600, jti: Math.random().toString(36).slice(2),
    sub: "p1", email: "ann@acme.test", name: "Ann", wid: "W1", workspace: "Acme", admin: true, ...over };
  const head = b64({ alg, typ: "JWT" }), body = b64(claims);
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}

async function hub(env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-masora-"));
  const h = await startHub({ ZEVET_GITHUB_CLIENT_ID: "test-client-id", ZEVET_ACCOUNTS: path.join(dir, "accounts.json"), ZEVET_MASORA_SECRET: SECRET, ...env });
  hubs.push(h);
  return h;
}
const signIn = (h, assertion) => fetch(`${h.base}/auth/masora`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assertion }) });
const whoami = (h, token) => fetch(`${h.base}/auth/whoami`, { headers: { "x-zevet-token": token } }).then((r) => r.json());

describe("verifyAssertion", () => {
  const now = Date.now();
  test("accepts a good one and refuses each way it can be wrong", () => {
    assert.equal(verifyAssertion(mint(), SECRET, now).claims.email, "ann@acme.test");
    assert.equal(verifyAssertion(mint(), "x".repeat(40), now).error, "bad signature");
    assert.equal(verifyAssertion(mint({}, { alg: "none" }), SECRET, now).error, "malformed");
    assert.equal(verifyAssertion(mint({ aud: "other" }), SECRET, now).error, "wrong token");
    assert.equal(verifyAssertion(mint({ typ: "session" }), SECRET, now).error, "wrong token");
    assert.equal(verifyAssertion(mint({ exp: 1 }), SECRET, now).error, "expired");
    assert.equal(verifyAssertion(mint({ wid: "" }), SECRET, now).error, "incomplete");
    assert.equal(verifyAssertion("a.b", SECRET, now).error, "malformed");
    assert.equal(verifyAssertion(mint(), "", now).error, "malformed");
  });
  test("a jti is taken once, and forgotten when it would have expired", () => {
    let t = 0;
    const g = replayGuard(() => t);
    assert.equal(g.take("a", 10), true);
    assert.equal(g.take("a", 10), false);
    t = 11_000;
    assert.equal(g.take("a", 10), true);
  });
  test("the team map reads wid=team pairs", () => {
    assert.deepEqual([...parseTeamMap("W1=default, w2=tdemo")], [["w1", "default"], ["w2", "tdemo"]]);
  });
});

describe("POST /auth/masora", () => {
  test("off without the shared secret", async () => {
    const h = await hub({ ZEVET_MASORA_SECRET: "" });
    assert.equal((await signIn(h, mint())).status, 503);
  });

  test("an admin opens a team named after the workspace; a member then joins it; both are signed in", async () => {
    const h = await hub();
    const a = await (await signIn(h, mint())).json();
    assert.equal(a.ok, true);
    assert.equal(a.owner, true);
    assert.equal(a.teamName, "Acme");
    assert.ok(a.secret && a.token);
    const m = await (await signIn(h, mint({ sub: "p2", email: "bo@acme.test", name: "Bo", admin: false }))).json();
    assert.equal(m.ok, true);
    assert.equal(m.owner, false);
    assert.equal(m.team, a.team);
    assert.equal(m.secret, a.secret);
    assert.equal((await whoami(h, m.token)).teamName, "Acme");
    const again = await (await signIn(h, mint({ sub: "p2", email: "bo@acme.test", admin: false }))).json();
    assert.equal(again.team, a.team);
  });

  test("a member cannot open an unopened workspace's team", async () => {
    const h = await hub();
    const r = await signIn(h, mint({ admin: false }));
    assert.equal(r.status, 403);
  });

  test("a replayed, forged or expired assertion is 401", async () => {
    const h = await hub();
    const good = mint();
    assert.equal((await signIn(h, good)).status, 200);
    assert.equal((await signIn(h, good)).status, 401);
    assert.equal((await signIn(h, mint({}, { secret: "x".repeat(40) }))).status, 401);
    assert.equal((await signIn(h, mint({ exp: 1 }))).status, 401);
  });

  test("a workspace named like an existing team does not inherit it; it gets its own", async () => {
    const h = await hub();
    const a = await (await signIn(h, mint({ wid: "W1", workspace: "Same" }))).json();
    const b = await (await signIn(h, mint({ wid: "W2", workspace: "Same", sub: "p9", email: "zed@other.test" }))).json();
    assert.notEqual(a.team, b.team);
    assert.equal(b.teamName, "Same 2");
    assert.equal(b.owner, true);
    assert.notEqual(a.secret, b.secret);
  });

  test("ZEVET_MASORA_TEAMS binds a workspace to a team that already exists", async () => {
    const h = await hub({ ZEVET_MASORA_TEAMS: "W7=default" });
    const a = await (await signIn(h, mint({ wid: "W7", workspace: "Whatever" }))).json();
    assert.equal(a.team, "default");
    assert.equal(a.owner, true);
    const m = await (await signIn(h, mint({ wid: "W7", admin: false, sub: "p3", email: "cy@acme.test" }))).json();
    assert.equal(m.ok, true);
    assert.equal(m.team, "default");
    const bad = await hub({ ZEVET_MASORA_TEAMS: "W7=nope" });
    assert.equal((await signIn(bad, mint({ wid: "W7" }))).status, 409);
  });
});
