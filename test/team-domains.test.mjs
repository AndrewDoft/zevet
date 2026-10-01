// ZEVET_TEAM_DOMAINS: a Google sign-in from a mapped Workspace domain joins the default team with no invite, no team
// name and no key. The gate is Google's `hd` claim AND a verified email on a mapped domain — never either alone.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHub } from "./helpers.mjs";

const hubs = [];
after(async () => {
  for (const h of hubs) await h.stop();
});

async function domainHub(extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-team-domains-"));
  const h = await startHub({
    ZEVET_ACCOUNTS: path.join(dir, "accounts.json"),
    ZEVET_GOOGLE_CLIENT_ID: "fake-google-client-id",
    ZEVET_GOOGLE_CLIENT_SECRET: "fake-google-client-secret",
    ZEVET_GOOGLE_REDIRECT: "https://hub.invalid/auth/google/callback",
    ZEVET_TEST_HOOKS: "1",
    ZEVET_TEAM_DOMAINS: "usemasora.com, @Metrodora.ai",
    ...extra,
  });
  hubs.push(h);
  return h;
}

/** A full browser-less Google sign-in as `claims`, naming `team` (none by default). Resolves the finish body + status. */
async function signIn(hub, claims, team) {
  const post = (route, body) => fetch(`${hub.base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const start = await (await post("/auth/google/start", team ? { team } : {})).json();
  const code = `claims:${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  await fetch(`${hub.base}/auth/google/callback?state=${start.pairCode}&code=${code}`);
  const r = await post("/auth/google/finish", { pairCode: start.pairCode });
  return { status: r.status, body: await r.json() };
}

const claim = (email, extra = {}) => ({ email, email_verified: true, sub: `s-${email}`, ...extra });

describe("mapped Workspace domains join the default team", () => {
  test("the domain is the door; every other shape is refused", async () => {
    const hub = await domainHub();
    // Somebody has to own the team first (the first sign-in of any kind does).
    const owner = await signIn(hub, claim("owner@elsewhere.example", { hd: "elsewhere.example" }));
    assert.equal(owner.body.owner, true);

    for (const [who, c] of [
      ["usemasora.com", claim("kai@usemasora.com", { hd: "usemasora.com" })],
      ["metrodora.ai", claim("mo@metrodora.ai", { hd: "metrodora.ai" })],
    ]) {
      const r = await signIn(hub, c);
      assert.equal(r.status, 200, who + JSON.stringify(r.body));
      assert.equal(r.body.ok, true, who);
      assert.equal(r.body.owner, false, who);
      assert.ok(r.body.token, who);
    }

    const refused = [
      ["a personal gmail that merely verified a mapped address has no hd", claim("fake@usemasora.com")],
      ["hd on a mapped domain but an unverified email", claim("x@usemasora.com", { hd: "usemasora.com", email_verified: false })],
      ["a mapped hd with a verified email on another domain", claim("x@gmail.com", { hd: "usemasora.com" })],
      ["a mapped email with the hd of another Workspace", claim("x@usemasora.com", { hd: "elsewhere.example" })],
      ["a Workspace that is not mapped", claim("x@other.example", { hd: "other.example" })],
    ];
    for (const [why, c] of refused) {
      const r = await signIn(hub, c);
      assert.equal(r.status, 403, why);
      assert.equal(r.body.token, undefined, why);
    }
  });

  test("with no mapping, a domain account is not admitted", async () => {
    const hub = await domainHub({ ZEVET_TEAM_DOMAINS: "" });
    await signIn(hub, claim("owner@elsewhere.example", { hd: "elsewhere.example" }));
    const r = await signIn(hub, claim("kai@usemasora.com", { hd: "usemasora.com" }));
    assert.equal(r.status, 403);
  });

  test("a hub with both ZEVET_GOOGLE_DOMAIN and ZEVET_TEAM_DOMAINS refuses to start", async () => {
    await assert.rejects(domainHub({ ZEVET_GOOGLE_DOMAIN: "usemasora.com" }), /ZEVET_TEAM_DOMAINS alone/);
  });
});

const whoami = async (hub, token) => (await fetch(`${hub.base}/auth/whoami`, { headers: { "x-zevet-token": token } })).json();
const create = async (hub, name) => (await (await fetch(`${hub.base}/team/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) })).json()).team;
const exists = async (hub, name) => (await (await fetch(`${hub.base}/team/resolve?name=${name}`)).json()).exists;

describe("one team per Google Workspace", () => {
  test("the first Workspace owner claims the domain; everyone else on it lands there, whatever they asked for", async () => {
    const hub = await domainHub();
    await signIn(hub, claim("owner@elsewhere.example", { hd: "elsewhere.example" })); // Masoretes' owner

    const acme = await create(hub, "acme");
    const boss = await signIn(hub, claim("boss@acme.example", { hd: "acme.example" }), acme);
    assert.equal(boss.body.owner, true, "the first sign-in claims the team");

    // Joins with no team named at all (the default), and with another team named.
    const kai = await signIn(hub, claim("kai@acme.example", { hd: "acme.example" }));
    assert.equal(kai.status, 200);
    assert.equal((await whoami(hub, kai.body.token)).teamName, "acme");

    const second = await create(hub, "acme-two");
    const lee = await signIn(hub, claim("lee@acme.example", { hd: "acme.example" }), second);
    assert.equal((await whoami(hub, lee.body.token)).teamName, "acme");
    assert.equal(await exists(hub, "acme-two"), false, "the unclaimed second team is dropped, not left to expire");

    // A mapped Workspace is routed to the default team even when it named someone else's.
    const mo = await signIn(hub, claim("mo@usemasora.com", { hd: "usemasora.com" }), acme);
    assert.equal((await whoami(hub, mo.body.token)).teamName, "Main team");
  });

  test("a personal Google account cannot claim or enter a Workspace's team", async () => {
    const hub = await domainHub();
    await signIn(hub, claim("owner@elsewhere.example", { hd: "elsewhere.example" }));
    const acme = await create(hub, "acme");
    await signIn(hub, claim("boss@acme.example", { hd: "acme.example" }), acme);

    const impostor = await signIn(hub, claim("fake@acme.example"), acme); // verified address, no hd
    assert.equal(impostor.status, 403);
    // And it did not claim a domain by creating a team of its own.
    const mine = await create(hub, "mine");
    const gm = await signIn(hub, claim("fake@acme.example"), mine);
    assert.equal(gm.body.owner, true);
    const boss2 = await signIn(hub, claim("late@acme.example", { hd: "acme.example" }), mine);
    assert.equal((await whoami(hub, boss2.body.token)).teamName, "acme", "the Workspace's team still wins");
  });
});
