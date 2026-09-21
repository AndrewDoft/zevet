// Google Workspace sign-in: the hub half, the desktop half, and the gate.
//
// The id tokens here are UNSIGNED — three base64url segments with a plausible
// payload and a junk signature. That is not a shortcut around a test that ought
// to verify one: `readIdToken` deliberately does not check the signature,
// because the only token it is ever shown is one the hub itself fetched from
// Google's token endpoint over TLS in the same function call (OIDC Core
// §3.1.3.7, written out at length in hub/google-auth.mjs). These tests pin the
// claim checks that ARE its job, and one of them pins the condition that makes
// skipping the signature legitimate.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { authorizeUrl, exchangeCode, readIdToken, AUTH_URL, TOKEN_URL, SCOPES } from "../hub/google-auth.mjs";
import { Accounts } from "../hub/accounts.mjs";

const CLIENT = "123-abc.apps.googleusercontent.com";
const REDIRECT = "https://usemasora.com/auth/google/callback";
const DOMAIN = "usemasora.com";

const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
/** An id token shaped exactly like Google's, with whatever claims a test wants. */
function idToken(claims = {}) {
  const payload = {
    iss: "https://accounts.google.com",
    aud: CLIENT,
    sub: "110001112223334445556",
    email: "andrew@usemasora.com",
    email_verified: true,
    hd: DOMAIN,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  };
  return `${b64({ alg: "RS256", kid: "x" })}.${b64(payload)}.notasignature`;
}

/** A fetch that answers one canned reply and records what it was asked. */
function fakeFetch(reply, seen = {}) {
  return async (url, init) => {
    seen.url = url;
    seen.init = init;
    return {
      status: reply.status || 200,
      async text() {
        return typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body || {});
      },
    };
  };
}

function store(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-google-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new Accounts({ file: path.join(dir, "accounts.json"), secret: "a".repeat(48) });
}

describe("where the browser is sent", () => {
  test("carries the client, the callback, the state and the code response type", () => {
    const u = new URL(authorizeUrl({ clientId: CLIENT, redirectUri: REDIRECT, state: "s".repeat(64), domain: DOMAIN }));
    assert.equal(`${u.origin}${u.pathname}`, AUTH_URL);
    assert.equal(u.searchParams.get("client_id"), CLIENT);
    assert.equal(u.searchParams.get("redirect_uri"), REDIRECT);
    assert.equal(u.searchParams.get("response_type"), "code");
    assert.equal(u.searchParams.get("state"), "s".repeat(64));
    assert.equal(u.searchParams.get("scope"), SCOPES);
  });

  test("asks for openid and email and NOTHING else", () => {
    // A widened scope is a widened consent screen for everybody who only wanted
    // to sign in, and it is the kind of change that is never noticed in review.
    assert.deepEqual(SCOPES.split(" ").sort(), ["email", "openid"]);
  });

  test("forces the account chooser, so a shared machine cannot sign in silently as the last person", () => {
    const u = new URL(authorizeUrl({ clientId: CLIENT, redirectUri: REDIRECT, state: "s" }));
    assert.equal(u.searchParams.get("prompt"), "select_account");
  });

  test("passes hd as a hint, and the hint is not the gate", () => {
    const withDomain = new URL(authorizeUrl({ clientId: CLIENT, redirectUri: REDIRECT, state: "s", domain: DOMAIN }));
    assert.equal(withDomain.searchParams.get("hd"), DOMAIN);
    const without = new URL(authorizeUrl({ clientId: CLIENT, redirectUri: REDIRECT, state: "s" }));
    assert.equal(without.searchParams.get("hd"), null);
    // The gate is readIdToken, and the test below proves it refuses a token
    // from another domain even though this hint was sent.
  });
});

describe("trading the code", () => {
  test("posts form-encoded, because Google's token endpoint refuses JSON", async () => {
    const seen = {};
    const r = await exchangeCode({
      clientId: CLIENT, clientSecret: "shh", code: "4/abc", redirectUri: REDIRECT,
      fetchImpl: fakeFetch({ body: { id_token: idToken() } }, seen),
    });
    assert.equal(r.ok, true);
    assert.equal(seen.url, TOKEN_URL);
    assert.equal(seen.init.headers["Content-Type"], "application/x-www-form-urlencoded");
    const sent = new URLSearchParams(seen.init.body);
    assert.equal(sent.get("grant_type"), "authorization_code");
    assert.equal(sent.get("code"), "4/abc");
    // Sent AGAIN, and Google compares it to step one byte for byte.
    assert.equal(sent.get("redirect_uri"), REDIRECT);
  });

  test("names the redirect mismatch instead of passing Google's bare error code on", async () => {
    const r = await exchangeCode({
      clientId: CLIENT, clientSecret: "shh", code: "4/abc", redirectUri: REDIRECT,
      fetchImpl: fakeFetch({ status: 400, body: { error: "redirect_uri_mismatch" } }),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /ZEVET_GOOGLE_REDIRECT/);
  });

  test("a hub with no client says so rather than calling Google", async () => {
    let called = false;
    const r = await exchangeCode({ code: "x", redirectUri: REDIRECT, fetchImpl: async () => { called = true; } });
    assert.equal(r.ok, false);
    assert.equal(called, false);
  });

  test("never throws when Google is unreachable", async () => {
    const r = await exchangeCode({
      clientId: CLIENT, clientSecret: "shh", code: "x", redirectUri: REDIRECT,
      fetchImpl: async () => { throw new Error("ECONNRESET"); },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /could not reach Google/);
  });
});

describe("reading the id token", () => {
  test("a good Workspace token identifies the person", () => {
    const r = readIdToken(idToken(), { clientId: CLIENT, domain: DOMAIN });
    assert.equal(r.ok, true);
    assert.equal(r.provider, "google");
    assert.equal(r.login, "andrew@usemasora.com");
    assert.equal(r.id, "110001112223334445556");
    assert.equal(r.hd, DOMAIN);
  });

  test("the id is the subject, NOT the email — an address can be reassigned, a sub cannot", () => {
    const r = readIdToken(idToken({ email: "someone.else@usemasora.com" }), { clientId: CLIENT, domain: DOMAIN });
    assert.equal(r.id, "110001112223334445556");
  });

  test("refuses a token minted for a different application", () => {
    const r = readIdToken(idToken({ aud: "999-evil.apps.googleusercontent.com" }), { clientId: CLIENT, domain: DOMAIN });
    assert.equal(r.ok, false);
    assert.match(r.error, /different application/);
  });

  test("refuses a token that did not come from Google", () => {
    const r = readIdToken(idToken({ iss: "https://accounts.evil.example" }), { clientId: CLIENT, domain: DOMAIN });
    assert.equal(r.ok, false);
    assert.match(r.error, /not issued by Google/);
  });

  test("refuses an expired token, and tolerates only a little clock skew", () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    assert.equal(readIdToken(idToken({ exp: past }), { clientId: CLIENT, domain: DOMAIN }).ok, false);
    // Inside the skew allowance, so still good.
    const justGone = Math.floor(Date.now() / 1000) - 30;
    assert.equal(readIdToken(idToken({ exp: justGone }), { clientId: CLIENT, domain: DOMAIN }).ok, true);
  });

  test("refuses an unverified address — otherwise the allowlist is decided by whoever can type one", () => {
    const r = readIdToken(idToken({ email_verified: false }), { clientId: CLIENT, domain: DOMAIN });
    assert.equal(r.ok, false);
    assert.match(r.error, /not verified/);
  });

  test("refuses another Workspace domain", () => {
    const r = readIdToken(idToken({ hd: "someoneelse.com", email: "a@someoneelse.com" }), { clientId: CLIENT, domain: DOMAIN });
    assert.equal(r.ok, false);
    assert.match(r.error, /someoneelse\.com/);
  });

  /* ⚠️ THE ONE THAT MATTERS MOST. A personal Google account can hold an address
   * at the domain — Google will even mark it verified once the person has
   * proved they can read that mailbox. What it CANNOT have is `hd`, which only
   * a domain Google administers produces. Gating on the email suffix instead
   * would admit exactly this account, and would look correct in every manual
   * test done from a Workspace laptop. */
  test("refuses a personal Google account whose address is at the domain", () => {
    const personal = idToken({ email: "andrew@usemasora.com", email_verified: true, hd: undefined });
    const r = readIdToken(personal, { clientId: CLIENT, domain: DOMAIN });
    assert.equal(r.ok, false);
    assert.match(r.error, /Workspace/);
  });

  test("a token that is not three segments is refused, not thrown on", () => {
    assert.equal(readIdToken("garbage", { clientId: CLIENT }).ok, false);
    assert.equal(readIdToken("", { clientId: CLIENT }).ok, false);
    assert.equal(readIdToken("a.b", { clientId: CLIENT }).ok, false);
  });
});

describe("the gate, for a Workspace domain", () => {
  const who = { provider: "google", id: "110001112223334445556", login: "andrew@usemasora.com", hd: DOMAIN };

  test("the first Workspace sign-in claims the hub", () => {
    const a = store(t0());
    const may = a.mayEnter(who, { domain: DOMAIN });
    assert.equal(may.ok, true);
    assert.equal(may.first, true);
  });

  test("a colleague is admitted by the DOMAIN, without being invited", () => {
    const a = store(t0());
    a.signIn(who);
    const colleague = { provider: "google", id: "220002223334445556667", login: "kai@usemasora.com", hd: DOMAIN };
    const may = a.mayEnter(colleague, { domain: DOMAIN });
    assert.equal(may.ok, true);
    assert.equal(may.byDomain, true);
  });

  /* ⚠️ THE ONE THAT WOULD HAVE SHIPPED BROKEN. `session()` re-checks on every
   * request that the session's owner is still on the list. Somebody admitted by
   * a RULE and never written down passes `mayEnter` and then fails that check
   * on their very next call — signed in, and signed out one request later, with
   * nothing anywhere saying why. */
  test("a domain joiner is RECORDED, so their session survives the next request", () => {
    const a = store(t0());
    a.signIn(who);
    const colleague = { provider: "google", id: "220002223334445556667", login: "kai@usemasora.com", hd: DOMAIN };
    const sess = a.signIn(colleague);
    assert.ok(a.session(sess.token), "the session died on the list re-check");
    assert.ok(a.list().some((p) => p.login === "kai@usemasora.com"));
  });

  test("somebody outside the domain is refused even with the domain set", () => {
    const a = store(t0());
    a.signIn(who);
    const outsider = { provider: "google", id: "3", login: "mallory@elsewhere.com", hd: "elsewhere.com" };
    assert.equal(a.mayEnter(outsider, { domain: DOMAIN }).ok, false);
  });

  /* ⚠️ REMOVAL ALONE DOES NOT REVOKE ANYBODY WHEN A RULE IS ADMITTING THEM.
   * Deleting the row just means the rule re-adds it on the next sign-in — a
   * Remove button that reports success and changes nothing. */
  test("revoking a domain member keeps them out, rather than letting the rule re-admit them", () => {
    const a = store(t0());
    a.signIn(who);
    const colleague = { provider: "google", id: "220002223334445556667", login: "kai@usemasora.com", hd: DOMAIN };
    a.signIn(colleague);

    assert.equal(a.revoke("kai@usemasora.com").removed, true);
    const again = a.mayEnter(colleague, { domain: DOMAIN });
    assert.equal(again.ok, false, "the domain rule let a revoked person straight back in");
    assert.match(again.error, /removed/);
  });

  test("inviting somebody back undoes the block", () => {
    const a = store(t0());
    a.signIn(who);
    const colleague = { provider: "google", id: "220002223334445556667", login: "kai@usemasora.com", hd: DOMAIN };
    a.signIn(colleague);
    a.revoke("kai@usemasora.com");

    assert.equal(a.allow("kai@usemasora.com").ok, true);
    assert.equal(a.mayEnter(colleague, { domain: DOMAIN }).ok, true);
  });

  test("with no domain configured, Google admits only the list", () => {
    const a = store(t0());
    a.signIn(who);
    const colleague = { provider: "google", id: "220002223334445556667", login: "kai@usemasora.com", hd: DOMAIN };
    assert.equal(a.mayEnter(colleague, { domain: "" }).ok, false);
  });
});

describe("two providers on one hub", () => {
  test("an invite is an email or a GitHub name, and each lands on the right provider", () => {
    const a = store(t0());
    a.signIn({ provider: "github", id: "1", login: "andrewdoft" });

    assert.equal(a.allow("kai@usemasora.com").ok, true);
    assert.equal(a.allow("octocat").ok, true);
    const list = a.list();
    assert.equal(list.find((p) => p.login === "kai@usemasora.com").provider, "google");
    assert.equal(list.find((p) => p.login === "octocat").provider, "github");
  });

  test("rejects a string that is neither", () => {
    const a = store(t0());
    assert.equal(a.allow("not a name").ok, false);
    assert.equal(a.allow("no-at-sign@").ok, false);
  });

  /* ⚠️ IDS ARE ONLY UNIQUE WITHIN A PROVIDER. A GitHub id and a Google `sub`
   * are digit strings from two unrelated namespaces, so a lookup that compares
   * the id alone can hand one person another person's seat. */
  test("a Google sub does not match a GitHub id that happens to be the same digits", () => {
    const a = store(t0());
    a.signIn({ provider: "github", id: "4242", login: "andrewdoft" });
    const twin = { provider: "google", id: "4242", login: "mallory@elsewhere.com", hd: "elsewhere.com" };
    assert.equal(a.mayEnter(twin, { domain: DOMAIN }).ok, false);
  });

  test("a record written before Google existed is read as GitHub's", () => {
    const a = store(t0());
    a.signIn({ id: "1", login: "andrewdoft" }); // no provider field at all
    assert.equal(a.list()[0].provider, "github");
  });
});

/** node:test gives each `test` its own context; these suites build a store per
 *  test and need one to hang the temp-directory cleanup on. */
function t0() {
  return { after: (fn) => process.on("exit", () => { try { fn(); } catch { /* best effort at exit */ } }) };
}
