// Hub -> Masora sign-in: POST /auth/masora/assertion mints a 60 s, single-use, Ed25519 assertion carrying ONLY the
// emails the provider verified at the sign-in behind the session. Each control below has a test that fails without it.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify, createPublicKey } from "node:crypto";
import path from "node:path";
import { startHub, tempDir, TOKEN } from "./helpers.mjs";
import { Accounts } from "../hub/accounts.mjs";
import { masoraAssertKey, mintMasoraAssertion, MASORA_ASSERT_TTL_S } from "../hub/masora-auth.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const SEED = privateKey.export({ format: "der", type: "pkcs8" }).subarray(16).toString("base64");

const GOOGLE = { provider: "google", login: "ann@acme.test", id: "g-1", display: "Ann", emails: ["ann@acme.test"] };
const GH = { provider: "github", login: "ann-gh", id: "77", display: "ann-gh" };
const MS = { provider: "microsoft", login: "bo@acme.test", id: "ms-1", display: "Bo", emails: ["bo@acme.test"] };

const hubs = [];
const dirs = [];
after(async () => {
  for (const h of hubs) await h.stop();
  for (const d of dirs) d.cleanup();
});

const parts = (jwt) => jwt.split(".").map((p, i) => (i < 2 ? JSON.parse(Buffer.from(p, "base64url").toString()) : p));
function sigOk(jwt, key = publicKey) {
  const [h, b, s] = jwt.split(".");
  return verify(null, Buffer.from(`${h}.${b}`), key, Buffer.from(s, "base64url"));
}

function accounts(now = () => Date.now()) {
  const d = tempDir();
  dirs.push(d);
  return new Accounts({ file: path.join(d.dir, "accounts.json"), now });
}
const sessionOf = (acc, token) => acc.session(token);

describe("what a sign-in may tell Masora", () => {
  test("Google: the verified email", () => {
    const acc = accounts();
    const { token } = acc.signIn(GOOGLE);
    assert.deepEqual(acc.masoraClaims(sessionOf(acc, token)), { sub: "google:g-1", provider: "google", emails: ["ann@acme.test"] });
  });

  test("GitHub: the verified PRIMARY only; none when no primary is verified", () => {
    const acc = accounts();
    acc.signIn({ ...GOOGLE, id: "owner", login: "owner@x.test", emails: ["owner@x.test"] });
    const both = acc.signIn({ ...GH, emails: ["p@acme.test", "second@acme.test"], primaryEmail: "p@acme.test" });
    assert.deepEqual(acc.masoraClaims(sessionOf(acc, both.token)).emails, ["p@acme.test"]);
    const noPrimary = acc.signIn({ ...GH, emails: ["second@acme.test"], primaryEmail: "" });
    assert.equal(acc.masoraClaims(sessionOf(acc, noPrimary.token)), null);
    // a primary GitHub did not mark verified is not in `emails`, so it is not proof
    const unverified = acc.signIn({ ...GH, emails: ["second@acme.test"], primaryEmail: "p@acme.test" });
    assert.equal(acc.masoraClaims(sessionOf(acc, unverified.token)), null);
  });

  test("Microsoft: only what microsoft-auth verified (xms_edov); none without it", () => {
    const acc = accounts();
    const ok = acc.signIn(MS);
    assert.deepEqual(acc.masoraClaims(sessionOf(acc, ok.token)).emails, ["bo@acme.test"]);
    const personal = acc.signIn({ ...MS, id: "ms-2", login: "ms:bo@outlook.test", emails: [] });
    assert.equal(acc.masoraClaims(sessionOf(acc, personal.token)), null);
  });

  test("an invite key and a sign-in FROM Masora carry nothing", () => {
    const acc = accounts();
    acc.signIn({ ...GOOGLE, id: "owner", login: "owner@x.test", emails: ["owner@x.test"] });
    const key = acc.signIn({ provider: "google", login: "kai@acme.test", id: "key-abc", display: "Kai", emails: ["kai@acme.test"] });
    assert.equal(acc.masoraClaims(sessionOf(acc, key.token)), null);
    const m = acc.signInMasora({ sub: "p9", email: "mo@acme.test", name: "Mo", admin: false });
    assert.equal(m.ok, true);
    assert.equal(acc.masoraClaims(sessionOf(acc, m.token)), null);
  });

  test("the public-profile email and the merged set are never used", () => {
    const acc = accounts();
    // owner proved a@ with Google; the same person later links GitHub (no primary) — its session asserts nothing
    acc.signIn({ ...GOOGLE, emails: ["ann@acme.test"] });
    const gh = acc.signIn({ ...GH, email: "ann@acme.test", emails: ["ann@acme.test"], primaryEmail: "" });
    assert.equal(acc.masoraClaims(sessionOf(acc, gh.token)), null);
  });

  test("a proof older than a day, a session from before this existed, and an unlinked identity carry nothing", () => {
    let t = 1_000_000;
    const acc = accounts(() => t);
    const { token } = acc.signIn(GOOGLE);
    t += 24 * 60 * 60 * 1000 + 1;
    assert.equal(acc.masoraClaims(sessionOf(acc, token)), null);

    assert.equal(acc.masoraClaims({ provider: "google", login: "ann@acme.test", id: "g-1", at: t }), null);

    const acc2 = accounts();
    const g = acc2.signIn(GOOGLE);
    acc2.link(sessionOf(acc2, g.token), { provider: "github", login: "ann-gh", id: "77" }, []);
    const gh = acc2.signIn({ ...GH, emails: ["ann@acme.test"], primaryEmail: "ann@acme.test" });
    assert.ok(acc2.masoraClaims(sessionOf(acc2, gh.token)));
    assert.equal(acc2.unlink(sessionOf(acc2, gh.token), { provider: "github", login: "ann-gh" }).ok, true);
    assert.equal(acc2.masoraClaims(sessionOf(acc2, gh.token)), null);
  });

  test("the proof survives a reload of the accounts file", () => {
    const d = tempDir();
    dirs.push(d);
    const file = path.join(d.dir, "accounts.json");
    const { token } = new Accounts({ file }).signIn(GOOGLE);
    const again = new Accounts({ file });
    assert.equal(again.masoraClaims(again.session(token)).emails[0], "ann@acme.test");
  });
});

describe("the assertion", () => {
  test("EdDSA, iss/aud/typ pinned, 60 s, a fresh jti each time, verifiable with the public key only", () => {
    const key = masoraAssertKey(SEED);
    const a = mintMasoraAssertion(key, { sub: "google:g-1", provider: "google", emails: ["ann@acme.test"] }, 1_700_000_000_000);
    const [h, c] = parts(a);
    assert.deepEqual(h, { alg: "EdDSA", typ: "JWT" });
    assert.equal(c.iss, "zevet-hub");
    assert.equal(c.aud, "masora");
    assert.equal(c.typ, "masora_hub_assertion");
    assert.equal(c.exp - c.iat, 60);
    assert.equal(MASORA_ASSERT_TTL_S, 60);
    assert.deepEqual(c.emails, ["ann@acme.test"]);
    assert.match(c.jti, /^[0-9a-f]{32}$/);
    assert.ok(sigOk(a));
    const b = mintMasoraAssertion(key, { sub: "x", provider: "google", emails: [] });
    assert.notEqual(parts(b)[1].jti, c.jti);
    assert.equal(sigOk(a, createPublicKey(generateKeyPairSync("ed25519").privateKey)), false);
  });

  test("a malformed key turns signing off", () => {
    assert.equal(masoraAssertKey(""), null);
    assert.equal(masoraAssertKey("abc"), null);
    assert.equal(masoraAssertKey(Buffer.alloc(31).toString("base64")), null);
    assert.equal(masoraAssertKey("not base64 !!"), null);
    assert.ok(masoraAssertKey(Buffer.alloc(32, 1).toString("base64url")));
  });
});

describe("POST /auth/masora/assertion", () => {
  async function hubWith(env = {}) {
    const d = tempDir();
    dirs.push(d);
    const file = path.join(d.dir, "accounts.json");
    const seed = new Accounts({ file });
    const google = seed.signIn(GOOGLE).token;
    seed.allow("kai@acme.test");
    const plain = seed.signIn({ provider: "google", login: "kai@acme.test", id: "key-1", display: "Kai" }).token;
    const h = await startHub({ ZEVET_ACCOUNTS: file, ZEVET_MASORA_ASSERT_KEY: SEED, ...env });
    hubs.push(h);
    return { base: h.base, google, plain };
  }
  const ask = (base, headers = {}) => fetch(`${base}/auth/masora/assertion`, { method: "POST", headers });

  test("503 without the key", async () => {
    const { base, google } = await hubWith({ ZEVET_MASORA_ASSERT_KEY: "" });
    assert.equal((await ask(base, { "x-zevet-token": google })).status, 503);
  });

  test("a personal session with a verified email gets a signed assertion of that email", async () => {
    const { base, google } = await hubWith();
    const r = await ask(base, { "x-zevet-token": google });
    assert.equal(r.status, 200);
    const { assertion } = await r.json();
    assert.ok(sigOk(assertion));
    assert.deepEqual(parts(assertion)[1].emails, ["ann@acme.test"]);
    assert.equal(parts(assertion)[1].sub, "google:g-1");
  });

  test("a real GitHub sign-in (fake upstream) asserts its verified primary, not its other verified address", async () => {
    const d = tempDir();
    dirs.push(d);
    const h = await startHub({
      ZEVET_ACCOUNTS: path.join(d.dir, "accounts.json"), ZEVET_MASORA_ASSERT_KEY: SEED, ZEVET_TEST_HOOKS: "1",
      ZEVET_GITHUB_CLIENT_ID: "test-gh-client", ZEVET_TEST_GH_EMAILS: JSON.stringify(["prime@acme.test", "other@acme.test"]),
    });
    hubs.push(h);
    const post = (route, body) => fetch(`${h.base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const { deviceCode } = await (await post("/auth/github/start", {})).json();
    let fin;
    for (let i = 0; i < 5 && !(fin && fin.token); i++) fin = await (await post("/auth/github/finish", { deviceCode })).json();
    assert.ok(fin.token, JSON.stringify(fin));
    const { assertion } = await (await ask(h.base, { "x-zevet-token": fin.token })).json();
    assert.deepEqual(parts(assertion)[1].emails, ["prime@acme.test"]);
    assert.equal(parts(assertion)[1].sub, "github:900001");
  });

  test("no token, the shared team token, the board cookie, and an invite-key session are refused", async () => {
    const { base, google, plain } = await hubWith();
    assert.equal((await ask(base)).status, 401);
    assert.equal((await ask(base, { "x-zevet-token": TOKEN })).status, 401);
    assert.equal((await ask(base, { cookie: `zevet_session=${google}` })).status, 401);
    assert.equal((await ask(base, { "x-zevet-token": plain })).status, 403);
  });
});
