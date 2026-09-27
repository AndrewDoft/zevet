// Anyone with a GitHub account can sign in and make or join a team, on a hub
// whose ZEVET_GITHUB_OWNER reserves only the DEFAULT team. Real hub, real HTTP,
// GitHub stubbed by test/github-stub-preload.mjs.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startHub } from "./helpers.mjs";

const hubs = [];
after(async () => {
  for (const h of hubs) await h.stop();
});

const PRELOAD = pathToFileURL(path.resolve(import.meta.dirname, "github-stub-preload.mjs")).href;

function hubEnv(dir, users) {
  return {
    ZEVET_GITHUB_CLIENT_ID: "test-client-id",
    ZEVET_GITHUB_OWNER: "andrew",
    ZEVET_ACCOUNTS: path.join(dir, "accounts.json"),
    GH_STUB_USERS: users,
    NODE_OPTIONS: `--import ${PRELOAD}`,
  };
}

const postJson = (base, route, body) =>
  fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** start + finish, as the desktop app does. */
async function signIn(base, team) {
  const s = await (await postJson(base, "/auth/github/start", { team })).json();
  if (!s.ok) return { status: 0, body: s };
  const f = await postJson(base, "/auth/github/finish", { deviceCode: s.deviceCode, team });
  return { status: f.status, body: await f.json() };
}

describe("GitHub sign-in for anyone", () => {
  test("a stranger cannot take the reserved default team, and is told whose it is", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zevet-gh-anyone-"));
    const h = await startHub(hubEnv(dir, "mallory"));
    hubs.push(h);
    const r = await signIn(h.base);
    assert.equal(r.status, 403);
    assert.match(r.body.error, /reserved for @andrew/);
  });

  test("a stranger creates a team and owns it; a second stranger joins it BY NAME and is refused until invited", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zevet-gh-anyone-"));
    // start order: alice (creator), bob (tries to join)
    const h = await startHub(hubEnv(dir, "alice,bob,alice"));
    hubs.push(h);

    const c = await (await postJson(h.base, "/team/create", { name: "Acme Platform" })).json();
    assert.equal(c.ok, true);

    const a = await signIn(h.base, c.team);
    assert.equal(a.status, 200);
    assert.equal(a.body.owner, true);
    assert.equal(a.body.team, c.team);

    const b = await signIn(h.base, "acme platform"); // name, any case
    assert.equal(b.status, 403);
    assert.match(b.body.error, /not on this team's list — ask @alice/);

    const again = await signIn(h.base, "ACME PLATFORM"); // the owner rejoins by name
    assert.equal(again.status, 200);
    assert.equal(again.body.owner, true);
    assert.equal(again.body.team, c.team, "the answer names the slug");
  });

  test("a team name is unique on a hub, case-insensitively", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zevet-gh-anyone-"));
    const h = await startHub(hubEnv(dir, "alice"));
    hubs.push(h);
    assert.equal((await postJson(h.base, "/team/create", { name: "Acme" })).status, 200);
    const dup = await postJson(h.base, "/team/create", { name: "  aCME " });
    assert.equal(dup.status, 409);
    assert.match((await dup.json()).error, /taken/i);
  });

  test("an unknown team is a 404 with a sentence, on start and on finish", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zevet-gh-anyone-"));
    const h = await startHub(hubEnv(dir, "alice"));
    hubs.push(h);
    for (const route of ["/auth/github/start", "/auth/github/finish"]) {
      const r = await postJson(h.base, route, { team: "nope", deviceCode: "dc-alice" });
      assert.equal(r.status, 404, route);
      assert.match((await r.json()).error, /no such team/);
    }
  });

  test("the owner allows a login by name, and that login signs in and joins by team name", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zevet-gh-anyone-"));
    const h = await startHub(hubEnv(dir, "alice,bob"));
    hubs.push(h);

    const c = await (await postJson(h.base, "/team/create", { name: "Invite Flow" })).json();
    const a = await signIn(h.base, c.team); // alice: first sign-in, becomes owner
    assert.equal(a.body.owner, true);

    const allowed = await fetch(`${h.base}/auth/allow`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": a.body.token },
      body: JSON.stringify({ login: "bob" }),
    });
    assert.equal(allowed.status, 200);

    // bob joins by TEAM NAME (any case) — never a hub address, never a slug
    // he was told out of band.
    const b = await signIn(h.base, "invite flow");
    assert.equal(b.status, 200);
    assert.equal(b.body.owner, false);
    assert.equal(b.body.team, c.team);

    const who = await fetch(`${h.base}/auth/whoami?token=${b.body.token}`).then((r) => r.json());
    const bobRow = who.people.find((p) => p.login === "bob");
    assert.ok(bobRow, "bob must appear in the roster");
    assert.equal(bobRow.pending, false, "having signed in, bob is no longer merely invited");
  });

  test("/auth/domain: owner-gated, and refuses anything a GitHub owner cannot back with an hd", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zevet-gh-anyone-"));
    const h = await startHub(hubEnv(dir, "alice,bob"));
    hubs.push(h);

    const c = await (await postJson(h.base, "/team/create", { name: "Domain Test" })).json();
    const a = await signIn(h.base, c.team); // alice: owner
    assert.equal(a.body.owner, true);

    // No token presented at all.
    const anon = await fetch(`${h.base}/auth/domain`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "acme.com" }),
    });
    assert.equal(anon.status, 401);

    // Signed in as the OWNER, but GitHub carries no `hd` to offer.
    const ownerReq = await fetch(`${h.base}/auth/domain`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": a.body.token },
      body: JSON.stringify({ domain: "acme.com" }),
    });
    assert.equal(ownerReq.status, 400);
    assert.match((await ownerReq.json()).error, /did not sign in with a Google Workspace account/);

    // Clearing an already-off domain is not an error — there is nothing to
    // refuse about turning something off that was never on.
    const clear = await fetch(`${h.base}/auth/domain`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": a.body.token },
      body: JSON.stringify({ domain: "" }),
    });
    assert.equal(clear.status, 200);

    // A second GitHub member — never invited — cannot even get a token.
    const b = await signIn(h.base, c.team);
    assert.equal(b.status, 403);

    const who = await fetch(`${h.base}/auth/whoami?token=${a.body.token}`).then((r) => r.json());
    assert.equal(who.availableDomain, "", "a GitHub owner has no hd to offer the toggle");
    assert.equal(who.googleDomain, "");
  });

  test("a created team, its owner and its name survive a hub restart", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zevet-gh-anyone-"));
    const env = hubEnv(dir, "alice");
    const h1 = await startHub(env);
    const c = await (await postJson(h1.base, "/team/create", { name: "Kept Over Restart" })).json();
    assert.equal((await signIn(h1.base, c.team)).body.owner, true);
    await h1.stop();

    const h2 = await startHub(env);
    hubs.push(h2);
    const r = await signIn(h2.base, "kept over restart");
    assert.equal(r.status, 200);
    assert.equal(r.body.owner, true);
    assert.equal(r.body.team, c.team);
  });
});
