// The hub's identity routes, driven end to end against the fake GitHub/Google
// upstream (hub/test-fake-idp.mjs — ZEVET_TEST_HOOKS=1): linking a second
// account, automatic linking on a verified email, rename, and combine.
//
// The fake GitHub account is `zevet-e2e-github` (id 900001) and the fake Google
// account is `zevet-e2e-google@example.com` (sub 900002), so a test decides
// whether the hub has EVIDENCE they are one person by choosing what the fake
// GitHub lists as its verified emails (ZEVET_TEST_GH_EMAILS).
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { startHub, tempDir, TOKEN } from "./helpers.mjs";
import { Accounts } from "../hub/accounts.mjs";

const GH = { provider: "github", login: "zevet-e2e-github", id: "900001", display: "zevet-e2e-github" };
const GOOGLE_EMAIL = "zevet-e2e-google@example.com";

const hubs = [];
const dirs = [];
after(async () => {
  for (const h of hubs) await h.stop();
  for (const d of dirs) d.cleanup();
});

/** A hub whose accounts file already has the fake GitHub account as owner (and
 *  optionally more people), with the session tokens it minted. */
async function hubWith({ ghEmails = [], extra = [] } = {}) {
  const d = tempDir();
  dirs.push(d);
  const file = path.join(d.dir, "accounts.json");
  const seed = new Accounts({ file });
  const owner = seed.signIn({ ...GH, emails: ghEmails });
  const others = extra.map((u) => ({ ...u, token: (seed.allow(u.login), seed.signIn(u).token) }));
  const hub = await startHub({
    ZEVET_ACCOUNTS: file,
    ZEVET_TEST_HOOKS: "1",
    ZEVET_TEST_GH_EMAILS: JSON.stringify(ghEmails),
    ZEVET_GITHUB_CLIENT_ID: "test-gh-client",
    ZEVET_GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
    ZEVET_GOOGLE_CLIENT_SECRET: "test-secret",
    ZEVET_GOOGLE_REDIRECT: "https://hub.invalid/auth/google/callback",
  });
  hubs.push(hub);
  return { hub, base: hub.base, owner: owner.token, others };
}

const call = (base, route, { token, body, method = "POST" } = {}) =>
  fetch(`${base}${route}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-zevet-token": token } : {}) },
    body: method === "GET" ? undefined : JSON.stringify(body || {}),
  });

async function githubFlow(base, { link = false, token } = {}) {
  const start = await (await call(base, "/auth/github/start", { body: {} })).json();
  assert.ok(start.deviceCode, JSON.stringify(start));
  for (let i = 0; i < 5; i++) {
    const r = await call(base, "/auth/github/finish", { token, body: { deviceCode: start.deviceCode, ...(link ? { link: true } : {}) } });
    const j = await r.json();
    if (j.pending) continue;
    return { status: r.status, ...j };
  }
  throw new Error("GitHub flow never resolved");
}

async function googleFlow(base, { link = false, token } = {}) {
  const s = await call(base, "/auth/google/start", { token, body: link ? { link: true } : {} });
  const start = await s.json();
  if (!s.ok) return { status: s.status, ...start };
  const cb = await fetch(`${base}/auth/google/callback?state=${start.pairCode}&code=fake`);
  await cb.text();
  const f = await call(base, "/auth/google/finish", { body: { pairCode: start.pairCode } });
  return { status: f.status, ...(await f.json()) };
}

const whoami = async (base, token) => (await call(base, "/auth/whoami", { token, method: "GET" })).json();

describe("linking another account", () => {
  test("Google is refused with no evidence, and a signed-in link proves it and unlocks it", async () => {
    const { base, owner } = await hubWith();

    const cold = await googleFlow(base);
    assert.equal(cold.status, 403, "no invite, no domain, no evidence: not admitted");

    const linked = await googleFlow(base, { link: true, token: owner });
    assert.equal(linked.status, 200, JSON.stringify(linked));
    assert.equal(linked.linked, true);
    assert.equal(linked.token, undefined, "linking hands out no session");
    assert.equal(linked.secret, undefined, "…and never the master secret");

    const me = (await whoami(base, owner)).me;
    assert.deepEqual(me.identities.map((i) => i.login).sort(), ["zevet-e2e-github", GOOGLE_EMAIL]);

    const now = await googleFlow(base);
    assert.equal(now.status, 200, "the linked identity signs in");
    assert.equal(now.owner, true, "as the same person, who is still the owner");
    assert.equal((await whoami(base, owner)).people.length, 1, "one person, not two");
  });

  test("a GitHub link onto a Google-signed-in person works the same way", async () => {
    const d = tempDir();
    dirs.push(d);
    const file = path.join(d.dir, "accounts.json");
    const seed = new Accounts({ file });
    const owner = seed.signIn({ provider: "google", login: GOOGLE_EMAIL, id: "900002", display: GOOGLE_EMAIL, emails: [GOOGLE_EMAIL] });
    const hub = await startHub({
      ZEVET_ACCOUNTS: file,
      ZEVET_TEST_HOOKS: "1",
      ZEVET_TEST_GH_EMAILS: "[]",
      ZEVET_GITHUB_CLIENT_ID: "test-gh-client",
    });
    hubs.push(hub);
    const r = await githubFlow(hub.base, { link: true, token: owner.token });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.linked, true);
    const me = (await whoami(hub.base, owner.token)).me;
    assert.equal(me.identities.length, 2);
  });

  test("linking needs a session — a shared token or nothing is refused, on both providers", async () => {
    const { base } = await hubWith();
    const g = await googleFlow(base, { link: true });
    assert.equal(g.status, 401);
    const shared = await googleFlow(base, { link: true, token: TOKEN });
    assert.equal(shared.status, 401);
    const start = await (await call(base, "/auth/github/start", { body: {} })).json();
    const f = await call(base, "/auth/github/finish", { body: { deviceCode: start.deviceCode, link: true } });
    assert.equal(f.status, 401);
  });

  test("unlink drops the identity, and refuses the last one", async () => {
    const { base, owner } = await hubWith();
    await googleFlow(base, { link: true, token: owner });
    const drop = await call(base, "/auth/unlink", { token: owner, body: { provider: "google", login: GOOGLE_EMAIL } });
    assert.equal(drop.status, 200);
    assert.equal((await drop.json()).me.identities.length, 1);
    const last = await call(base, "/auth/unlink", { token: owner, body: { provider: "github", login: "zevet-e2e-github" } });
    assert.equal(last.status, 400);
  });
});

describe("automatic linking", () => {
  test("Google sign-in with an email GitHub has verified for a member needs no invite and adds no person", async () => {
    // Signing in through the route is what records the verified emails.
    const { base } = await hubWith({ ghEmails: [GOOGLE_EMAIL] });
    const gh = await githubFlow(base);
    assert.equal(gh.status, 200, JSON.stringify(gh));

    const g = await googleFlow(base);
    assert.equal(g.status, 200, JSON.stringify(g));
    assert.equal(g.owner, true);
    assert.equal((await whoami(base, g.token)).people.length, 1);
  });

  test("with no verified email the same Google sign-in is still refused", async () => {
    const { base } = await hubWith({ ghEmails: [] });
    await githubFlow(base);
    assert.equal((await googleFlow(base)).status, 403);
  });
});

describe("names", () => {
  const kai = { provider: "github", login: "kai", display: "kai", id: "7" };

  test("you can rename yourself; teammates see it on events already in the log", async () => {
    const { base, owner, others } = await hubWith({ extra: [kai] });
    const post = await call(base, "/ingest", { token: TOKEN, body: { actor: "andrew", kind: "prompt", repo: "r", detail: "x" } });
    assert.equal(post.status, 200);

    const r = await call(base, "/auth/rename", { token: owner, body: { name: "Andrew D", actor: "andrew" } });
    assert.equal(r.status, 200, await r.text());

    // kai's board: the roster names Andrew D, and the old event follows.
    const state = await (await fetch(`${base}/api/state?token=${others[0].token}`)).json();
    assert.deepEqual(state.roster.map((x) => x.actor), ["Andrew D"]);
    const w = await whoami(base, others[0].token);
    assert.ok(w.people.some((p) => p.login === "Andrew D" && p.key === "zevet-e2e-github"), "the People list shows the new name under a stable key");
  });

  test("you cannot rename somebody else, but the owner can", async () => {
    const { base, owner, others } = await hubWith({ extra: [kai] });
    const denied = await call(base, "/auth/rename", { token: others[0].token, body: { login: "zevet-e2e-github", name: "Boss" } });
    assert.equal(denied.status, 403);
    const ok = await call(base, "/auth/rename", { token: owner, body: { login: "kai", name: "Kai K" } });
    assert.equal(ok.status, 200);
    const w = await whoami(base, owner);
    assert.ok(w.people.some((p) => p.key === "kai" && p.login === "Kai K"));
  });

  test("a shared token cannot rename anybody", async () => {
    const { base } = await hubWith();
    const r = await call(base, "/auth/rename", { token: TOKEN, body: { name: "x" } });
    assert.equal(r.status, 403);
  });
});

describe("combining", () => {
  const kai = { provider: "github", login: "kai", display: "kai", id: "7" };

  test("the owner can combine two people; a member cannot", async () => {
    const { base, owner, others } = await hubWith({ extra: [kai] });
    const denied = await call(base, "/auth/merge", { token: others[0].token, body: { into: "kai", from: "zevet-e2e-github" } });
    assert.equal(denied.status, 403);
    const ok = await call(base, "/auth/merge", { token: owner, body: { into: "zevet-e2e-github", from: "kai" } });
    const merged = await ok.json();
    assert.equal(ok.status, 200, JSON.stringify(merged));
    assert.equal(merged.people.length, 1);
    // kai's session was re-pointed at the survivor, so it still works.
    assert.equal((await fetch(`${base}/api/state?token=${others[0].token}`)).status, 200);
  });

  test("an actor name that is on no account becomes an alias of the person", async () => {
    const { base, owner } = await hubWith();
    await call(base, "/ingest", { token: TOKEN, body: { actor: "andrew", kind: "prompt", repo: "r", detail: "x" } });
    const r = await call(base, "/auth/merge", { token: owner, body: { into: "zevet-e2e-github", from: "andrew" } });
    assert.equal(r.status, 200);
    const state = await (await fetch(`${base}/api/state?token=${owner}`)).json();
    assert.deepEqual(state.roster.map((x) => x.actor), ["zevet-e2e-github"]);
  });
});
