// Microsoft (Entra / personal accounts) sign-in: the claim checks in hub/microsoft-auth.mjs, the account rules
// they feed (provider-scoped ids, email evidence only when verified), and the routes driven through a real hub
// with the fake IdP (ZEVET_TEST_HOOKS=1). Unsigned tokens are correct here for Google's reason — see
// hub/microsoft-auth.mjs: the only token it reads is one this process fetched from the token endpoint.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { authorizeUrl, exchangeCode, readIdToken, AUTH_URL, TOKEN_URL } from "../hub/microsoft-auth.mjs";
import { Accounts } from "../hub/accounts.mjs";
import { startHub } from "./helpers.mjs";

const CLIENT = "11111111-2222-3333-4444-555555555555";
const TID = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
function idToken(claims = {}) {
  const payload = {
    iss: `https://login.microsoftonline.com/${TID}/v2.0`,
    aud: CLIENT,
    sub: "AAAAAAAAAAAAAAAAAAAAAL",
    tid: TID,
    email: "kai@contoso.example",
    xms_edov: true,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  };
  return `${b64({ alg: "RS256", kid: "x" })}.${b64(payload)}.notasignature`;
}
const read = (claims, opts = {}) => readIdToken(idToken(claims), { clientId: CLIENT, ...opts });

describe("microsoft readIdToken", () => {
  test("a good token with a domain-verified email is evidence for that email", () => {
    const r = read({});
    assert.equal(r.ok, true);
    assert.equal(r.provider, "microsoft");
    assert.equal(r.id, "AAAAAAAAAAAAAAAAAAAAAL");
    assert.equal(r.login, "kai@contoso.example");
    assert.deepEqual(r.emails, ["kai@contoso.example"]);
  });

  test("an email without xms_edov is not evidence, and its login cannot equal a verified one", () => {
    for (const xms_edov of [undefined, false, "0", "false"]) {
      const r = read({ xms_edov });
      assert.equal(r.ok, true);
      assert.deepEqual(r.emails, [], String(xms_edov));
      assert.equal(r.login, "ms:kai@contoso.example");
    }
  });

  test("the adversarial claims are refused", () => {
    const bad = [
      ["wrong audience", { aud: "someone-elses-app" }, /different application/],
      ["wrong issuer host", { iss: `https://evil.example/${TID}/v2.0` }, /not issued by Microsoft/],
      ["issuer tenant differs from tid", { tid: "00000000-0000-0000-0000-000000000001" }, /not issued by Microsoft/],
      ["Google's issuer", { iss: "https://accounts.google.com" }, /not issued by Microsoft/],
      ["v1 issuer", { iss: `https://sts.windows.net/${TID}/` }, /not issued by Microsoft/],
      ["tid that is not a guid", { tid: "common", iss: "https://login.microsoftonline.com/common/v2.0" }, /not issued by Microsoft/],
      ["expired", { exp: Math.floor(Date.now() / 1000) - 3600 }, /expired/],
      ["no exp", { exp: undefined }, /expired/],
      ["no subject", { sub: "" }, /who you are/],
    ];
    for (const [why, c, re] of bad) {
      const r = read(c);
      assert.equal(r.ok, false, why);
      assert.match(r.error, re, why);
    }
    assert.equal(readIdToken("a.b", { clientId: CLIENT }).ok, false, "not a jwt");
    assert.equal(readIdToken("a.!!!.c", { clientId: CLIENT }).ok, false, "forged payload");
    assert.equal(readIdToken("", { clientId: CLIENT }).ok, false);
  });

  test("the nonce this attempt minted must come back; missing and wrong are both refused", () => {
    assert.equal(read({ nonce: "n1" }, { nonce: "n1" }).ok, true);
    assert.match(read({ nonce: "other" }, { nonce: "n1" }).error, /attempt/);
    assert.match(read({}, { nonce: "n1" }).error, /attempt/);
  });

  test("authorizeUrl and exchangeCode say what they are calling", async () => {
    const u = new URL(authorizeUrl({ clientId: CLIENT, redirectUri: "https://h/auth/microsoft/callback", state: "st", nonce: "no" }));
    assert.equal(`${u.origin}${u.pathname}`, AUTH_URL);
    assert.equal(u.searchParams.get("state"), "st");
    assert.equal(u.searchParams.get("nonce"), "no");
    assert.equal(u.searchParams.get("scope"), "openid email");
    const seen = {};
    const r = await exchangeCode({
      clientId: CLIENT,
      clientSecret: "s",
      code: "c",
      redirectUri: "https://h/auth/microsoft/callback",
      fetchImpl: async (url, init) => ((seen.url = url), (seen.init = init), { status: 200, text: async () => JSON.stringify({ id_token: "x.y.z" }) }),
    });
    assert.deepEqual(r, { ok: true, idToken: "x.y.z" });
    assert.equal(seen.url, TOKEN_URL);
    assert.equal(seen.init.headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.equal((await exchangeCode({ clientId: CLIENT, clientSecret: "", code: "c" })).ok, false);
  });
});

function store(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-ms-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new Accounts({ file: path.join(dir, "accounts.json"), secret: "a".repeat(48) });
}
const gid = (id, login) => ({ provider: "google", id, login, display: login, emails: [login] });
const gh = (id, login) => ({ provider: "github", id, login, display: login });

describe("microsoft in accounts", () => {
  test("an id is unique only within its provider: the same digits on GitHub, Google and Microsoft are three people", (t) => {
    const a = store(t);
    assert.equal(a.mayEnter(gh("42", "octo")).first, true);
    a.signIn(gh("42", "octo"));
    const msUser = { provider: "microsoft", id: "42", login: "ms:42@x.example", display: "42@x.example", emails: [] };
    assert.equal(a.mayEnter(msUser).ok, false, "a Microsoft sub equal to the owner's GitHub id must not inherit the seat");
    assert.equal(a.mayEnter(gid("42", "someone@x.example")).ok, false);
    a.allow("someone@x.example");
    a.signIn(gid("42", "someone@x.example"));
    assert.equal(a.list().length, 2, "google 42 is a second person, not the github owner");
  });

  test("a VERIFIED microsoft email auto-links to the person who proved the same email", (t) => {
    const a = store(t);
    a.signIn(gid("g1", "kai@contoso.example"));
    const ms = { provider: "microsoft", id: "m1", login: "kai@contoso.example", display: "kai@contoso.example", emails: ["kai@contoso.example"] };
    assert.equal(a.mayEnter(ms).ok, true);
    a.signIn(ms);
    assert.equal(a.list().length, 1, "same human, one row");
    assert.equal(a.list()[0].identities.length, 1);
  });

  test("an UNVERIFIED microsoft email neither admits nor links, even when it matches a member's address", (t) => {
    const a = store(t);
    a.signIn(gid("g1", "boss@contoso.example"));
    a.allow("newbie@contoso.example"); // a pending email invite
    for (const email of ["boss@contoso.example", "newbie@contoso.example"]) {
      const spoof = { provider: "microsoft", id: "m-evil", login: `ms:${email}`, display: email, emails: [] };
      const may = a.mayEnter(spoof);
      assert.equal(may.ok, false, email);
      assert.match(may.error, /not on this team's list/);
    }
    assert.equal(a.list().length, 2, "nothing was added or merged");
    assert.equal(a.list().find((p) => p.login === "newbie@contoso.example").id, "", "the invite is still unclaimed");
  });

  test("a verified microsoft email claims a pending email invite", (t) => {
    const a = store(t);
    a.signIn(gid("g1", "boss@contoso.example"));
    a.allow("newbie@contoso.example");
    const ms = { provider: "microsoft", id: "m2", login: "newbie@contoso.example", display: "newbie@contoso.example", emails: ["newbie@contoso.example"] };
    assert.equal(a.mayEnter(ms).ok, true);
    a.signIn(ms);
    assert.equal(a.list().length, 2);
    assert.equal(a.list().find((p) => p.login !== "boss@contoso.example").id, "m2");
  });

  test("a microsoft person is named without a GitHub-style @", (t) => {
    const a = store(t);
    a.signIn(gh("1", "octo"));
    const ms = { provider: "microsoft", id: "m3", login: "ms:z@x.example", display: "z@x.example", emails: [] };
    assert.match(a.mayEnter(ms).error, /^ms:z@x\.example is not on/);
  });
});

/* ── routes, through a real hub and the fake IdP ───────────────────────────── */
const hubs = [];
after(async () => {
  for (const h of hubs) await h.stop();
});
const post = (hub, route, body) => fetch(`${hub.base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });

async function msHub(extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-ms-hub-"));
  const h = await startHub({
    ZEVET_ACCOUNTS: path.join(dir, "accounts.json"),
    ZEVET_MICROSOFT_CLIENT_ID: CLIENT,
    ZEVET_MICROSOFT_CLIENT_SECRET: "fake-ms-secret",
    ZEVET_MICROSOFT_REDIRECT: "https://hub.invalid/auth/microsoft/callback",
    ZEVET_TEST_HOOKS: "1",
    ...extra,
  });
  hubs.push(h);
  return h;
}

/** Start, then call back with a code carrying `claims` (the attempt's real nonce unless overridden). */
async function signIn(hub, claims = {}) {
  const start = await (await post(hub, "/auth/microsoft/start")).json();
  const nonce = new URL(start.authUrl).searchParams.get("nonce");
  const code = `claims:${Buffer.from(JSON.stringify({ nonce, ...claims })).toString("base64url")}`;
  const cb = await fetch(`${hub.base}/auth/microsoft/callback?state=${start.pairCode}&code=${code}`);
  const fin = await post(hub, "/auth/microsoft/finish", { pairCode: start.pairCode });
  return { start, cb, status: fin.status, body: await fin.json(), code };
}

describe("microsoft routes", () => {
  test("start hands back a Microsoft URL carrying state and a nonce; the first sign-in owns the hub", async () => {
    const hub = await msHub();
    const r = await signIn(hub, { email: "owner@contoso.example", sub: "own1" });
    const u = new URL(r.start.authUrl);
    assert.equal(u.hostname, "login.microsoftonline.com");
    assert.equal(u.searchParams.get("state"), r.start.pairCode);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.owner, true);
    assert.ok(r.body.token);
    const who = await (await fetch(`${hub.base}/auth/whoami`, { headers: { "x-zevet-token": r.body.token } })).json();
    assert.equal(who.microsoftSignIn, true);
    assert.equal(who.googleSignIn, false);
  });

  test("forged, wrong-aud, wrong-iss and expired tokens never mint a session", async () => {
    const hub = await msHub();
    await signIn(hub, { email: "owner@contoso.example", sub: "own1" });
    const attacks = [
      ["wrong aud", { aud: "other-app" }],
      ["wrong iss", { iss: "https://evil.example/x/v2.0" }],
      ["expired", { exp: 1 }],
      ["wrong nonce", { nonce: "not-mine" }],
    ];
    for (const [why, c] of attacks) {
      const r = await signIn(hub, { email: "kai@contoso.example", sub: "evil", ...c });
      assert.equal(r.status, 403, why);
      assert.equal(r.body.token, undefined, why);
    }
  });

  test("state replay: a second callback with the same state is refused and never exchanges", async () => {
    const hub = await msHub();
    const r = await signIn(hub, { email: "owner@contoso.example", sub: "own1" });
    const again = await fetch(`${hub.base}/auth/microsoft/callback?state=${r.start.pairCode}&code=${r.code}`);
    assert.equal(again.status, 400);
    assert.match(await again.text(), /expired or was already used/);
    const fin = await post(hub, "/auth/microsoft/finish", { pairCode: r.start.pairCode });
    assert.equal(fin.status, 400, "finish is single use too");
  });

  test("a state minted for another provider is dead on this callback", async () => {
    const hub = await msHub({
      ZEVET_GOOGLE_CLIENT_ID: "fake-google",
      ZEVET_GOOGLE_CLIENT_SECRET: "s",
      ZEVET_GOOGLE_REDIRECT: "https://hub.invalid/auth/google/callback",
    });
    const g = await (await post(hub, "/auth/google/start")).json();
    const cb = await fetch(`${hub.base}/auth/microsoft/callback?state=${g.pairCode}&code=x`);
    assert.equal(cb.status, 400);
    const fin = await post(hub, "/auth/microsoft/finish", { pairCode: g.pairCode });
    assert.equal(fin.status, 400);
    const still = await post(hub, "/auth/google/finish", { pairCode: g.pairCode });
    assert.equal((await still.json()).pending, true, "the Google attempt is untouched");
  });

  test("an unverified email is not admitted by an email invite, a verified one is", async () => {
    const hub = await msHub();
    const owner = await signIn(hub, { email: "owner@contoso.example", sub: "own1" });
    await fetch(`${hub.base}/auth/allow`, { method: "POST", headers: { "content-type": "application/json", "x-zevet-token": owner.body.token }, body: JSON.stringify({ login: "kai@contoso.example" }) });
    const spoof = await signIn(hub, { email: "kai@contoso.example", sub: "m-evil", xms_edov: false });
    assert.equal(spoof.status, 403);
    const real = await signIn(hub, { email: "kai@contoso.example", sub: "m-kai" });
    assert.equal(real.status, 200, JSON.stringify(real.body));
    assert.equal(real.body.owner, false);
  });

  test("an unclaimed hub reserved for a GitHub owner cannot be claimed through Microsoft", async () => {
    const hub = await msHub({ ZEVET_GITHUB_OWNER: "andrew", ZEVET_GITHUB_CLIENT_ID: "x" });
    const r = await signIn(hub, { email: "stranger@contoso.example", sub: "s1" });
    assert.equal(r.status, 403);
  });

  test("half-configured Microsoft refuses to start", async () => {
    await assert.rejects(startHub({ ZEVET_MICROSOFT_CLIENT_ID: CLIENT, ZEVET_TEST_HOOKS: "1" }), /ZEVET_MICROSOFT_CLIENT_SECRET and ZEVET_MICROSOFT_REDIRECT/);
  });

  test("an unconfigured hub answers 503", async () => {
    const hub = await startHub({ ZEVET_GOOGLE_CLIENT_ID: "g", ZEVET_GOOGLE_CLIENT_SECRET: "s", ZEVET_GOOGLE_REDIRECT: "https://h/x" });
    hubs.push(hub);
    assert.equal((await post(hub, "/auth/microsoft/start")).status, 503);
  });
});
