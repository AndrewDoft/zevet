// Signing in with GitHub: the hub's half, the desktop's half, and the gate.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS AND IS NOT COVERED, said plainly.
//
// COVERED: every branch of the device flow, driven by a fake GitHub that can
// answer the way the real one does — including the two answers that are the
// usual reason a device flow is written wrong. `authorization_pending` arrives
// as an HTTP 200 WITH an `error` field, and so does `slow_down`; treating any
// `error` as fatal makes the flow fail instantly for everyone, every time, and
// it is the first thing to break when somebody simplifies this later.
//
// ⚠️ NOT COVERED: the hub's /auth/github routes against a real GitHub. Those
// routes call `fetch` directly against github.com, and the hub under test is a
// SPAWNED PROCESS, so there is nowhere to inject a fake. Adding an env var to
// point the hub's OAuth at another host would make it testable and would also
// be a switch that redirects everybody's sign-in to a server of the setter's
// choosing; that trade was refused. What IS asserted below is everything on
// those routes that does not need GitHub: the 503 when no app is configured,
// the 403 that keeps a non-owner off the allowlist, and the fact that a valid
// shared token does NOT make its holder the owner.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { startHub, TOKEN, ROOT, tempDir } from "./helpers.mjs";
import { deviceStart, devicePoll, githubUser, SCOPES } from "../hub/github-auth.mjs";

const require = createRequire(import.meta.url);
const { GithubSignIn } = require(path.join(ROOT, "desktop", "github-signin.js"));

/** A fake `fetch` that answers from a script of `[status, body]` per URL. */
function fakeFetch(routes) {
  const seen = [];
  const f = async (url, init = {}) => {
    seen.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null, init });
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) throw new Error(`no fake for ${url}`);
    const answer = typeof routes[key] === "function" ? routes[key](seen.length) : routes[key];
    const [status, body] = answer;
    return {
      status,
      ok: status >= 200 && status < 300,
      async text() {
        return typeof body === "string" ? body : JSON.stringify(body);
      },
      async json() {
        return body;
      },
    };
  };
  f.seen = seen;
  return f;
}

describe("asking GitHub for a code", () => {
  test("returns what the window has to show", async () => {
    const f = fakeFetch({
      "login/device/code": [200, {
        device_code: "dc-1", user_code: "WDJB-MJHT",
        verification_uri: "https://github.com/login/device",
        verification_uri_complete: "https://github.com/login/device?user_code=WDJB-MJHT",
        interval: 5, expires_in: 900,
      }],
    });
    const r = await deviceStart({ clientId: "Iv1.abc", fetchImpl: f });
    assert.equal(r.ok, true);
    assert.equal(r.userCode, "WDJB-MJHT");
    // The complete URL is what makes this typing-free. Losing it silently would
    // put the long code back, which is the thing being removed.
    assert.match(r.verificationUriComplete, /user_code=WDJB-MJHT/);
    assert.equal(f.seen[0].body.scope, SCOPES);
  });

  test("asks for read:user and NOTHING that touches code", () => {
    // ⚠️ If this ever fails because somebody widened the scope, that is a
    // product decision about what zevet asks permission for, not a test to fix.
    // `repo` is read-write access to every private repository the person can
    // see, requested from everybody who only wanted to sign in.
    assert.equal(SCOPES, "read:user");
  });

  test("builds the complete URL itself if GitHub stops sending one", async () => {
    const f = fakeFetch({
      "login/device/code": [200, { device_code: "dc", user_code: "AAAA-BBBB", verification_uri: "https://github.com/login/device" }],
    });
    const r = await deviceStart({ clientId: "x", fetchImpl: f });
    assert.match(r.verificationUriComplete, /user_code=AAAA-BBBB/);
  });

  test("names the likeliest cause when device flow is switched off", async () => {
    // GitHub's answer to an app without device flow enabled is an empty-ish
    // body. "Enable Device Flow" is a tickbox nobody finds by guessing.
    const f = fakeFetch({ "login/device/code": [200, {}] });
    const r = await deviceStart({ clientId: "x", fetchImpl: f });
    assert.equal(r.ok, false);
    assert.match(r.error, /Enable Device Flow/);
  });

  test("a hub with no client id says so instead of calling GitHub", async () => {
    const r = await deviceStart({ clientId: "", fetchImpl: () => assert.fail("must not call GitHub") });
    assert.equal(r.ok, false);
    assert.match(r.error, /not configured/);
  });

  test("an HTML outage page is reported as such, not as a parse error", async () => {
    const f = fakeFetch({ "login/device/code": [200, "<html>unicorn</html>"] });
    const r = await deviceStart({ clientId: "x", fetchImpl: f });
    assert.equal(r.ok, false);
    assert.match(r.error, /not JSON/);
  });
});

describe("polling", () => {
  test("authorization_pending is NOT an error", async () => {
    const f = fakeFetch({ "oauth/access_token": [200, { error: "authorization_pending" }] });
    const r = await devicePoll({ clientId: "x", deviceCode: "dc", fetchImpl: f });
    assert.equal(r.ok, true);
    assert.equal(r.pending, true);
  });

  test("slow_down is pending, and says so", async () => {
    const f = fakeFetch({ "oauth/access_token": [200, { error: "slow_down" }] });
    const r = await devicePoll({ clientId: "x", deviceCode: "dc", fetchImpl: f });
    assert.equal(r.pending, true);
    assert.equal(r.slowDown, true);
  });

  test("an expired code stops the flow with a sentence a person can act on", async () => {
    const f = fakeFetch({ "oauth/access_token": [200, { error: "expired_token" }] });
    const r = await devicePoll({ clientId: "x", deviceCode: "dc", fetchImpl: f });
    assert.equal(r.ok, false);
    assert.match(r.error, /expired/);
  });

  test("a declined authorisation is final", async () => {
    const f = fakeFetch({ "oauth/access_token": [200, { error: "access_denied" }] });
    const r = await devicePoll({ clientId: "x", deviceCode: "dc", fetchImpl: f });
    assert.equal(r.ok, false);
    assert.match(r.error, /declined/);
  });

  test("a token comes back when it comes back", async () => {
    const f = fakeFetch({ "oauth/access_token": [200, { access_token: "gho_x", token_type: "bearer" }] });
    const r = await devicePoll({ clientId: "x", deviceCode: "dc", fetchImpl: f });
    assert.equal(r.accessToken, "gho_x");
  });
});

describe("identifying the person", () => {
  test("returns login and id", async () => {
    const f = fakeFetch({ "api.github.com/user": [200, { login: "AndrewDoft", id: 1001 }] });
    const r = await githubUser({ accessToken: "gho_x", fetchImpl: f });
    assert.equal(r.login, "AndrewDoft");
    assert.equal(r.id, "1001");
    // api.github.com answers 403 without a User-Agent. Easy to drop, and the
    // failure looks like a bad token rather than a missing header.
    assert.ok(f.seen[0].init.headers["User-Agent"]);
  });

  test("a revoked token is a refusal, not a crash", async () => {
    const f = fakeFetch({ "api.github.com/user": [401, { message: "Bad credentials" }] });
    const r = await githubUser({ accessToken: "gho_x", fetchImpl: f });
    assert.equal(r.ok, false);
  });
});

describe("the desktop state machine", () => {
  /** A fake hub, answering the two routes the app calls. */
  function hubFetch(script) {
    let n = 0;
    return async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      const answer = script(String(url), body, n++);
      return {
        status: answer.status || 200,
        ok: (answer.status || 200) < 300,
        async json() {
          return answer.body;
        },
      };
    };
  }

  test("waits BEFORE the first poll", async () => {
    // ⚠️ GitHub cannot have an answer in the moment between handing out a code
    // and being asked about it, and polling immediately earns a `slow_down`
    // that raises the interval for the rest of the flow.
    const order = [];
    const f = hubFetch((url) => {
      order.push(url.includes("start") ? "start" : "poll");
      return url.includes("start")
        ? { body: { deviceCode: "dc", userCode: "AAAA", verificationUri: "u", verificationUriComplete: "u?c", interval: 5, expiresIn: 900 } }
        : { body: { ok: true, token: "t".repeat(64), secret: "a".repeat(48), login: "kai" } };
    });
    const sleeps = [];
    const s = new GithubSignIn({ hub: "http://hub", fetchImpl: f, sleep: async (ms) => { sleeps.push(ms); order.push("sleep"); } });
    await s.start();
    await s.wait();
    assert.deepEqual(order, ["start", "sleep", "poll"]);
    assert.equal(sleeps[0], 5000, "must obey GitHub's interval, not one of our own");
  });

  test("keeps polling through pending, and resolves", async () => {
    const f = hubFetch((url, _b, n) =>
      url.includes("start")
        ? { body: { deviceCode: "dc", userCode: "AAAA", verificationUriComplete: "u", interval: 1, expiresIn: 900 } }
        : n < 3
          ? { body: { ok: true, pending: true } }
          : { body: { ok: true, token: "t".repeat(64), secret: "a".repeat(48), login: "kai", owner: false } },
    );
    const s = new GithubSignIn({ hub: "http://hub", fetchImpl: f, sleep: async () => {} });
    await s.start();
    const r = await s.wait();
    assert.equal(r.login, "kai");
    assert.equal(r.secret, "a".repeat(48));
  });

  test("backs off when told to", async () => {
    const sleeps = [];
    const f = hubFetch((url, _b, n) =>
      url.includes("start")
        ? { body: { deviceCode: "dc", userCode: "A", verificationUriComplete: "u", interval: 5, expiresIn: 900 } }
        : n < 3
          ? { body: { ok: true, pending: true, slowDown: true } }
          : { body: { ok: true, token: "t", secret: "s", login: "kai" } },
    );
    const s = new GithubSignIn({ hub: "http://hub", fetchImpl: f, sleep: async (ms) => sleeps.push(ms) });
    await s.start();
    await s.wait();
    assert.deepEqual(sleeps, [5000, 10000, 15000]);
  });

  test("gives up at the deadline rather than polling forever", async () => {
    let now = 0;
    const f = hubFetch((url) =>
      url.includes("start")
        ? { body: { deviceCode: "dc", userCode: "A", verificationUriComplete: "u", interval: 5, expiresIn: 900 } }
        : { body: { ok: true, pending: true } },
    );
    const s = new GithubSignIn({
      hub: "http://hub", fetchImpl: f, now: () => now,
      sleep: async () => { now += 60_000; },
    });
    await s.start();
    await assert.rejects(() => s.wait(), /expired/);
  });

  test("cancel stops it", async () => {
    const f = hubFetch((url) =>
      url.includes("start")
        ? { body: { deviceCode: "dc", userCode: "A", verificationUriComplete: "u", interval: 1, expiresIn: 900 } }
        : { body: { ok: true, pending: true } },
    );
    const s = new GithubSignIn({ hub: "http://hub", fetchImpl: f, sleep: async () => s.cancel() });
    await s.start();
    await assert.rejects(() => s.wait(), /cancelled/);
  });

  test("a hub with no OAuth app is named as a deployment problem", async () => {
    const f = hubFetch(() => ({ status: 503, body: { error: "this hub has no GitHub sign-in configured" } }));
    const s = new GithubSignIn({ hub: "http://hub", fetchImpl: f });
    await assert.rejects(() => s.start(), /GitHub sign-in is off/);
  });

  test("a chosen team rides along on both start and finish, so the hub can bind the device code to it", async () => {
    const bodies = [];
    const f = hubFetch((url, body) => {
      bodies.push(body);
      return url.includes("start")
        ? { body: { deviceCode: "dc", userCode: "A", verificationUriComplete: "u", interval: 1, expiresIn: 900, team: "abc123" } }
        : { body: { ok: true, token: "t".repeat(64), secret: "a".repeat(48), login: "kai", team: "abc123" } };
    });
    const s = new GithubSignIn({ hub: "http://hub", team: "abc123", fetchImpl: f, sleep: async () => {} });
    await s.start();
    await s.wait();
    assert.equal(bodies[0].team, "abc123", "start carries the team");
    assert.equal(bodies[1].team, "abc123", "finish carries it again — the hub cannot recover it from a device code alone");
  });

  test("no team chosen sends none — the hub then resolves the default team, unaffected by this feature", async () => {
    const bodies = [];
    const f = hubFetch((url, body) => {
      bodies.push(body);
      return url.includes("start")
        ? { body: { deviceCode: "dc", userCode: "A", verificationUriComplete: "u", interval: 1, expiresIn: 900 } }
        : { body: { ok: true, pending: true } };
    });
    const s = new GithubSignIn({ hub: "http://hub", fetchImpl: f, sleep: async () => s.cancel() });
    await s.start();
    await assert.rejects(() => s.wait(), /cancelled/);
    assert.equal(bodies[0].team, "", "an unset team is sent as empty, not omitted or undefined");
  });
});

describe("the hub's gate, without GitHub", () => {
  let hub;
  before(async () => {
    hub = await startHub();
  });
  after(async () => {
    await hub?.stop();
  });

  test("sign-in is 503, not 404, when no app is configured", async () => {
    // A 404 would read as "this hub is too old for sign-in". 503 plus the
    // sentence is what sends somebody to the hub's env rather than to GitHub.
    const res = await fetch(`${hub.base}/auth/github/start`, { method: "POST" });
    assert.equal(res.status, 503);
  });

  test("whoami needs a credential", async () => {
    assert.equal((await fetch(`${hub.base}/auth/whoami`)).status, 401);
  });

  test("a shared-token caller is authenticated but anonymous, and is NOT the owner", async () => {
    // ⚠️ THE IMPORTANT ONE. The shared token is the credential being replaced;
    // if holding it granted owner rights, anybody with it could add themselves
    // to the allowlist permanently and survive the secret being rotated.
    const res = await fetch(`${hub.base}/auth/whoami`, { headers: { "x-zevet-token": TOKEN } });
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.equal(b.login, null);
    assert.equal(b.shared, true);
    assert.equal(b.owner, false);
    assert.equal(b.githubSignIn, false);
  });

  test("a shared token cannot change the allowlist", async () => {
    for (const route of ["/auth/allow", "/auth/revoke"]) {
      const res = await fetch(`${hub.base}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-zevet-token": TOKEN },
        body: JSON.stringify({ login: "mallory" }),
      });
      assert.equal(res.status, 403, `${route} let a shared token through`);
    }
  });

  test("no credential at all cannot change the allowlist either", async () => {
    const res = await fetch(`${hub.base}/auth/allow`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "mallory" }),
    });
    assert.equal(res.status, 401);
  });
});

describe("signing yourself out", () => {
  // A seeded account store: one owner with one live session. Seeding the file
  // directly is the only way to get a session without GitHub, and the route
  // under test is exactly what ends it.
  const SESSION = "a".repeat(64);
  let hub;
  let dir;
  before(async () => {
    dir = tempDir("zevet-logout-");
    const file = path.join(dir.dir, "accounts.json");
    writeFileSync(file, JSON.stringify({
      version: 1,
      secret: "b".repeat(48),
      owner: { login: "andrewdoft", display: "AndrewDoft", id: "1001", added: new Date().toISOString() },
      allowed: [],
      sessions: { [SESSION]: { login: "andrewdoft", id: "1001", at: Date.now() } },
    }));
    hub = await startHub({
      ZEVET_ACCOUNTS: file,
      // 64 hex chars, like a real derived token: tokenOk gates on the shared
      // token's width before falling through to the session lookup, so the
      // suite's short test token would reject every session at the gate.
      ZEVET_TOKEN: "t".repeat(64),
    });
  });
  after(async () => {
    await hub?.stop();
    dir?.cleanup();
  });

  test("logout ends the caller's session and nothing else", async () => {
    const out = await fetch(`${hub.base}/auth/logout`, {
      method: "POST",
      headers: { "x-zevet-token": SESSION },
    });
    assert.equal(out.status, 200);
    assert.deepEqual(await out.json(), { ok: true, loggedOut: true });
    // The session is dead now; the owner record is not.
    assert.equal((await fetch(`${hub.base}/auth/whoami`, { headers: { "x-zevet-token": SESSION } })).status, 401);
    // And ending it again is a 401, not a second logout: the credential is
    // gone, so there is nothing to authenticate — idempotency lives one layer
    // down, in accounts.logout(), where a dead token is { loggedOut: false }.
    const again = await fetch(`${hub.base}/auth/logout`, {
      method: "POST",
      headers: { "x-zevet-token": SESSION },
    });
    assert.equal(again.status, 401);
  });

  test("a shared token logs out nothing", async () => {
    // The hub's own shared token (64 chars, like production): a valid
    // credential that is not a session, so there is nothing to end — 200 with
    // loggedOut:false, not an error.
    const res = await fetch(`${hub.base}/auth/logout`, {
      method: "POST",
      headers: { "x-zevet-token": "t".repeat(64) },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, loggedOut: false });
  });

  test("no credential cannot log out", async () => {
    assert.equal((await fetch(`${hub.base}/auth/logout`, { method: "POST" })).status, 401);
  });
});

describe("a hub that would start with a credential nobody knows", () => {
  test("refuses to start with nothing configured at all", async () => {
    // Before sign-in existed this was guaranteed by ZEVET_TOKEN being required.
    // `Accounts` now mints a secret when it has none, so without this guard the
    // hub would come up healthy, on a public port, holding a perfectly good
    // credential that no human being has ever seen.
    await assert.rejects(
      () => startHub({ ZEVET_TOKEN: "", ZEVET_SECRET: "", ZEVET_GITHUB_CLIENT_ID: "" }),
      /exited 1|refusing to start/i,
    );
  });

  test("refuses to start when ZEVET_TOKEN and ZEVET_SECRET disagree", async () => {
    // The cutover bug in docs/RELEASING.md, made loud. Two values, one stale,
    // and a plain 401 that said nothing about which.
    await assert.rejects(
      () => startHub({ ZEVET_SECRET: "a".repeat(48), ZEVET_TOKEN: "b".repeat(64) }),
      /exited 1|not the token/i,
    );
  });
});
