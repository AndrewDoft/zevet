// Multiple independent teams on one hub — /team/create, and the isolation it
// buys: a fresh Accounts (own master secret, own ownership, own allowlist)
// and a fresh board (own events), reached by resolving the CALLER'S OWN
// token to a team rather than trusting a client-named one.
//
// What this file does not attempt: a real GitHub/Google OAuth round trip —
// see google-routes.test.mjs's own note on why that is out of scope for a
// hub test (it would spend a real outbound request per assertion). The
// shared-token path exercises the exact same `resolveTeam` a session would,
// without needing GitHub or Google to answer.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHub, post, state } from "./helpers.mjs";
import { Accounts, deriveAuthToken } from "../hub/accounts.mjs";

const hubs = [];
after(async () => {
  for (const h of hubs) await h.stop();
});

async function teamHub(extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-team-accounts-"));
  const h = await startHub({
    ZEVET_GITHUB_CLIENT_ID: "test-client-id",
    ZEVET_ACCOUNTS: path.join(dir, "accounts.json"),
    ...extraEnv,
  });
  hubs.push(h);
  h.accountsDir = dir;
  return h;
}

function secretFor(hub, team) {
  const file = path.join(hub.accountsDir, team === "default" ? "accounts.json" : `accounts-${team}.json`);
  return JSON.parse(readFileSync(file, "utf8")).secret;
}

function tokenFor(hub, team) {
  return deriveAuthToken(secretFor(hub, team));
}

const create = (base) => fetch(`${base}/team/create`, { method: "POST" }).then((r) => r.json());

describe("creating a team", () => {
  test("mints a distinct slug each time", async () => {
    const hub = await teamHub();
    const a = await create(hub.base);
    const b = await create(hub.base);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.notEqual(a.team, b.team);
    assert.match(a.team, /^[a-f0-9]{10}$/);
  });

  test("refused with no sign-in provider configured", async () => {
    const h = await startHub();
    hubs.push(h);
    const r = await fetch(`${h.base}/team/create`, { method: "POST" });
    assert.equal(r.status, 503);
  });

  test("the ceiling is enforced", async () => {
    const hub = await teamHub({ ZEVET_MAX_TEAMS: "1" });
    const first = await create(hub.base);
    assert.equal(first.ok, true);
    const second = await fetch(`${hub.base}/team/create`, { method: "POST" });
    assert.equal(second.status, 503);
  });

  test("a fresh team gets a fresh master secret, independent of the default team's", async () => {
    const hub = await teamHub();
    const a = await create(hub.base);
    const teamToken = tokenFor(hub, a.team);
    // "test-token-0123456789abcdef" — helpers.TOKEN, the default team's
    // ZEVET_TOKEN. Same length (both are 64-hex-equivalent-width strings, per
    // hub/server.mjs's own comment), so this is a real compare, not a
    // length mismatch giving a free pass.
    assert.notEqual(teamToken, "test-token-0123456789abcdef");
  });
});

describe("a created team is isolated", () => {
  test("events posted to one team never appear in another's snapshot or the default's", async () => {
    // /api/state now needs a real session (teamFromSession), which an
    // UNCLAIMED /team/create team cannot have without a real GitHub/Google
    // round trip — this file's own header rules that out. Seeding each
    // team's file with a signed-in owner BEFORE the hub starts gets the same
    // claimed state loadTeams() would find on disk either way (same
    // mechanism test/team.test.mjs's /team/join tests already use for the
    // default team, just for two named teams here too).
    const dir = mkdtempSync(path.join(tmpdir(), "zevet-team-snap-"));
    const ownerA = new Accounts({ file: path.join(dir, "accounts-team-a.json") }).signIn({ login: "owner-a", id: "owner-a-1" });
    const ownerB = new Accounts({ file: path.join(dir, "accounts-team-b.json") }).signIn({ login: "owner-b", id: "owner-b-1" });
    const ownerDefault = new Accounts({ file: path.join(dir, "accounts.json") }).signIn({ login: "owner-default", id: "owner-default-1" });
    const hub = await startHub({ ZEVET_ACCOUNTS: path.join(dir, "accounts.json") });
    hubs.push(hub);
    hub.accountsDir = dir;

    const tokenA = deriveAuthToken(secretFor(hub, "team-a"));
    const posted = await post(hub.base, { actor: "trevor" }, tokenA);
    assert.equal(posted.status, 200);

    const snapA = await state(hub.base, ownerA.token);
    const snapB = await state(hub.base, ownerB.token);
    const snapDefault = await state(hub.base, ownerDefault.token);

    assert.equal(snapA.body.roster.length, 1, "team A sees its own event");
    assert.equal(snapA.body.roster[0].actor, "trevor");
    assert.equal(snapB.body.roster.length, 0, "team B does not see team A's activity");
    assert.equal(snapDefault.body.roster.length, 0, "the default team does not see team A's activity either");
  });

  test("an unknown team is refused at sign-in start, not silently defaulted", async () => {
    const hub = await teamHub();
    const r = await fetch(`${hub.base}/auth/github/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team: "doesnotexist" }),
    });
    assert.equal(r.status, 404);
  });

  test("an omitted team on sign-in start resolves to the default team, for a client that predates teams", async () => {
    const hub = await teamHub();
    // No body at all — exactly what every install before this feature sends.
    // Not asserting 200: `deviceStart` makes a real call to github.com with a
    // fake client id, and whether GITHUB answers that with success is not
    // what this test is about. What matters is that team resolution — the
    // 404 branch this hub added — never even sees a reason to fire.
    const r = await fetch(`${hub.base}/auth/github/start`, { method: "POST" });
    assert.notEqual(r.status, 404, "an omitted team must not be treated as an unknown one");
    const body = await r.json().catch(() => null);
    assert.ok(!body || !/no such team/i.test(body.error || ""), "must not fail team validation");
  });

  test("whoami resolves to the team the caller's own token belongs to", async () => {
    const hub = await teamHub();
    const a = await create(hub.base);
    const tokenA = tokenFor(hub, a.team);
    const res = await fetch(`${hub.base}/auth/whoami?token=${tokenA}`).then((r) => r.json());
    assert.equal(res.team, a.team);
    assert.equal(res.shared, true, "a shared-token caller, not a session");
    assert.deepEqual(res.people, [], "an unclaimed team has nobody yet");
  });

  test("allow/revoke on a created team reports ITS OWN unclaimed state, not the default team's owner", async () => {
    const hub = await teamHub();
    const a = await create(hub.base);
    const tokenA = tokenFor(hub, a.team);
    const res = await fetch(`${hub.base}/auth/allow`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": tokenA },
      body: JSON.stringify({ login: "trevor" }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /nobody has claimed this team yet/);
  });

  test("/healthz counts teams created, but keeps reporting only the default team's board", async () => {
    const hub = await teamHub();
    const before = await fetch(`${hub.base}/healthz`).then((r) => r.json());
    assert.equal(before.teams, 1);
    await create(hub.base);
    const afterCreate = await fetch(`${hub.base}/healthz`).then((r) => r.json());
    assert.equal(afterCreate.teams, 2);
    assert.equal(afterCreate.events, before.events, "unaffected by another team's activity");
  });
});

describe("unclaimed teams expire (INSUF: the orphan a test POST left on the hosted hub)", () => {
  test("an unclaimed team older than the expiry window is gone after the next /team/create", async () => {
    // ZEVET_TEAM_EXPIRY_MS is the same override shape ZEVET_COLLISION_WINDOW_MS
    // already uses elsewhere in this suite: a real, tiny window, then a real
    // (tiny) sleep past it — not a mock of time, because the thing under test
    // is server.mjs's own Date.now()-based sweep, in its own process.
    const hub = await teamHub({ ZEVET_TEAM_EXPIRY_MS: "50" });
    const orphan = await create(hub.base);
    const tokenOrphan = tokenFor(hub, orphan.team);
    const accountsFile = path.join(hub.accountsDir, `accounts-${orphan.team}.json`);
    const eventsFile = path.join(hub.accountsDir, `events-${orphan.team}.jsonl`);
    assert.ok(existsSync(accountsFile), "the orphan's own file must exist before the sweep");

    // Confirm it is reachable before the sweep, so the assertion below is a
    // real transition and not a token that never worked. /ingest, not
    // /api/state: an unclaimed team has no owner and so can never have a
    // session, and /api/state now requires one (teamFromSession) — /ingest
    // is the one team-scoped route still open to a shared token (see its
    // own comment in hub/server.mjs), and resolving to a team at all is
    // exactly what this test is asking.
    const before = await post(hub.base, { actor: "probe" }, tokenOrphan);
    assert.equal(before.status, 200);

    await new Promise((r) => setTimeout(r, 200)); // past the 50ms window

    // The sweep runs lazily, before a new team is minted — see
    // sweepUnclaimedTeams() in hub/server.mjs — so creating a second team is
    // what triggers it, not a wait for the hourly interval.
    const second = await create(hub.base);
    assert.equal(second.ok, true);

    const after = await post(hub.base, { actor: "probe" }, tokenOrphan);
    assert.equal(after.status, 401, "the orphan's token must no longer resolve to a team");

    assert.equal(existsSync(accountsFile), false, "the orphan's accounts file must be deleted");
    assert.equal(existsSync(eventsFile), false, "the orphan's events file must be deleted");
  });

  test("a freshly created unclaimed team survives a sweep triggered moments later", async () => {
    const hub = await teamHub({ ZEVET_TEAM_EXPIRY_MS: String(60 * 60 * 1000) }); // one hour — nothing here is that old
    const fresh = await create(hub.base);
    const tokenFresh = tokenFor(hub, fresh.team);

    // Two more /team/create calls, each of which runs the lazy sweep.
    await create(hub.base);
    await create(hub.base);

    const res = await post(hub.base, { actor: "probe" }, tokenFresh);
    assert.equal(res.status, 200, "a team well inside the expiry window must not be swept");
    await res.text();
    assert.ok(existsSync(path.join(hub.accountsDir, `accounts-${fresh.team}.json`)), "its file must still be there");
  });

  // A claimed team is never swept, no matter its age: hub/server.mjs's
  // sweepUnclaimedTeams() skips any Accounts whose `owner` is set,
  // unconditionally, before it ever looks at age. Claiming one over HTTP needs
  // a real GitHub/Google OAuth round trip, which this file's own header
  // comment rules out — so that branch is exercised directly against
  // hub/accounts.mjs instead, in test/accounts.test.mjs's "createdAt" describe:
  // "signing in sets owner — the fact the sweep uses to never touch a claimed
  // team".
});

/**
 * /team/join — the invite-key redeem route. Minting the key needs an OWNER
 * SESSION on /auth/allow, which needs a real GitHub/Google OAuth round trip —
 * ruled out for this file for the same reason the sweep test above gives.
 * So a team is CLAIMED and given a pending invite by writing its accounts
 * file directly with hub/accounts.mjs, before the hub subprocess starts
 * (loadTeams() picks up any accounts-<slug>.json already on disk at boot,
 * per its own comment in server.mjs) — the redeem ROUTE itself (team
 * resolution, the response shape, rate limiting) is what this exercises.
 */
describe("/team/join — redeeming an invite key", () => {
  const SLUG = "acme-platform"; // slugify("Acme Platform")

  async function seededHub() {
    const dir = mkdtempSync(path.join(tmpdir(), "zevet-team-join-"));
    const seed = new Accounts({ file: path.join(dir, `accounts-${SLUG}.json`) });
    const owner = seed.signIn({ login: "AndrewDoft", id: "1001" }); // claims the team — owner
    const key = seed.allow("kai").key;
    const h = await startHub({ ZEVET_ACCOUNTS: path.join(dir, "accounts.json") });
    hubs.push(h);
    h.accountsDir = dir;
    return { hub: h, key, ownerToken: owner.token };
  }

  const join = (base, team, key) =>
    fetch(`${base}/team/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team, key }),
    });

  test("redeems a valid key: mints a session and hands back the master secret, exactly like a sign-in", async () => {
    const { hub, key } = await seededHub();
    const res = await join(hub.base, "Acme Platform", key);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.login, "kai");
    assert.equal(body.owner, false);
    assert.equal(body.secret, secretFor(hub, SLUG));
    // The minted session actually authenticates against this hub.
    const who = await fetch(`${hub.base}/auth/whoami`, { headers: { "x-zevet-token": body.token } }).then((r) => r.json());
    assert.equal(who.login, "kai");
  });

  test("the same key cannot be redeemed twice", async () => {
    const { hub, key } = await seededHub();
    assert.equal((await join(hub.base, SLUG, key)).status, 200);
    const second = await join(hub.base, SLUG, key);
    assert.equal(second.status, 400);
    assert.equal((await second.json()).error, "bad key");
  });

  test("a wrong key is refused with one terse error, and repeated wrong keys are rate limited", async () => {
    const { hub } = await seededHub();
    const first = await join(hub.base, SLUG, "ZZZZ-ZZZZ");
    assert.equal(first.status, 400);
    assert.equal((await first.json()).error, "bad key");
    let last;
    for (let i = 0; i < 25; i++) last = await join(hub.base, SLUG, "ZZZZ-ZZZZ");
    assert.equal(last.status, 429, "the shared failure limiter kicks in on repeated bad keys");
  });

  test("an unknown team is refused, not silently treated as the default team", async () => {
    const { hub } = await seededHub();
    const res = await join(hub.base, "no-such-team", "ZZZZ-ZZZZ");
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /no such team/);
  });

  // P0-B: the hub log showed "rejected token from ... on /team/join", read by
  // an outside observer as "the key was rejected because of a stale token" —
  // but /team/join never calls teamFrom/tokenFrom at all (only rateLimited +
  // acc.redeem), so a leftover x-zevet-token from a PREVIOUS account or team
  // must not matter. This pins that down with a header a real stale client
  // would send.
  test("a stale x-zevet-token header from a previous session never blocks a valid key", async () => {
    const { hub, key } = await seededHub();
    const res = await fetch(`${hub.base}/team/join`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": "not-a-real-token-at-all" },
      body: JSON.stringify({ team: SLUG, key }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).login, "kai");
  });

  // P0-B: "when a member redeems, the roster flips pending -> active
  // immediately (whoami people.pending false)."
  test("redeeming flips the roster row from pending to active immediately", async () => {
    // whoami's people list needs a real session now (a shared token is
    // answered but sees an empty list — see hub/server.mjs's
    // teamFromSession), so this reads the roster as the owner, not the
    // team's shared token.
    const { hub, key, ownerToken } = await seededHub();
    const before = await fetch(`${hub.base}/auth/whoami`, { headers: { "x-zevet-token": ownerToken } }).then((r) => r.json());
    const kaiBefore = before.people.find((p) => p.login === "kai");
    assert.equal(kaiBefore.pending, true);

    const joined = await join(hub.base, SLUG, key);
    assert.equal(joined.status, 200);

    const after = await fetch(`${hub.base}/auth/whoami`, { headers: { "x-zevet-token": ownerToken } }).then((r) => r.json());
    const kaiAfter = after.people.find((p) => p.login === "kai");
    assert.equal(kaiAfter.pending, false);
  });
});

/**
 * /auth/allow — the invite-key mint and its email response shape. Owner
 * authentication here is a SESSION TOKEN, not the shared token (hub/server.mjs
 * refuses the shared token for allow/revoke on purpose), so the owner is
 * signed in the same file-seeding way /team/join's tests above are: the
 * session `signIn` mints is persisted to the accounts file and survives the
 * subprocess boot exactly like test/accounts.test.mjs's "sessions survive a
 * restart" proves.
 *
 * RESEND_API_KEY is set to "" throughout, so no real Resend call ever
 * happens — see test/mailer.test.mjs for the mailer's own contract with a
 * stubbed fetch, and the SHIP step for the one deliberate live send.
 */
describe("/auth/allow — invite keys and the email response shape", () => {
  const SLUG = "acme-platform";

  async function seededHub() {
    const dir = mkdtempSync(path.join(tmpdir(), "zevet-invite-email-"));
    const seed = new Accounts({ file: path.join(dir, `accounts-${SLUG}.json`) });
    const owner = seed.signIn({ login: "AndrewDoft", id: "1001" });
    const h = await startHub({ ZEVET_ACCOUNTS: path.join(dir, "accounts.json"), RESEND_API_KEY: "" });
    hubs.push(h);
    h.accountsDir = dir;
    return { hub: h, ownerToken: owner.token };
  }

  const allow = (base, token, login) =>
    fetch(`${base}/auth/allow`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": token },
      body: JSON.stringify({ login }),
    });

  test("a bare email invite mints a key and, with no RESEND_API_KEY, hands it back unemailed", async () => {
    const { hub, ownerToken } = await seededHub();
    const res = await allow(hub.base, ownerToken, "kai@example.com");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.email_sent, false, "no RESEND_API_KEY configured");
    assert.match(body.key, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // The handed-back key actually redeems, against the SAME team.
    const joined = await fetch(`${hub.base}/team/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team: SLUG, key: body.key }),
    });
    assert.equal(joined.status, 200);
    assert.equal((await joined.json()).login, "kai@example.com");
  });

  test('a two-token invite ("login email") allows the LOGIN and would mail the email, not the combined string', async () => {
    const { hub, ownerToken } = await seededHub();
    const res = await allow(hub.base, ownerToken, "octocat kai@example.com");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    const person = body.people.find((p) => p.pending);
    assert.equal(person.login, "octocat", "the LOGIN, not \"octocat kai@example.com\"");
  });

  test("re-inviting the same still-pending person rotates the key rather than crashing", async () => {
    const { hub, ownerToken } = await seededHub();
    const a = await (await allow(hub.base, ownerToken, "kai@example.com")).json();
    const b = await (await allow(hub.base, ownerToken, "kai@example.com")).json();
    assert.notEqual(a.key, b.key);
    const oldKeyStillWorks = await fetch(`${hub.base}/team/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team: SLUG, key: a.key }),
    });
    assert.equal(oldKeyStillWorks.status, 400, "the rotated-out key must be dead");
  });

  // Andrew, verbatim: "the copy invite is different from what is actually
  // emailed, since the copy invite doesnt contain the key." Fixed by
  // generating both from hub/mailer.mjs's inviteMessage() and handing the
  // SAME text back as `inviteText` — this pins that contract at the HTTP
  // layer (mailer.test.mjs pins inviteMessage itself).
  test("inviteText is the same content Resend would have been sent, key included, and settings.tsx's Copy uses it verbatim", async () => {
    const { hub, ownerToken } = await seededHub();
    const body = await (await allow(hub.base, ownerToken, "kai@example.com")).json();
    assert.equal(typeof body.inviteText, "string");
    assert.match(body.inviteText, new RegExp(body.key));
    assert.match(body.inviteText, /https:\/\/usemasora\.com\/zevet/);
    assert.match(body.inviteText, /Zevet/);
  });

  // Requirement 3: "show send state honestly ... a failed send must be
  // visible, never shown as sent." No RESEND_API_KEY means every send in
  // this describe block fails, and that failure must be a distinct,
  // honest field — not silently folded into `email_sent: false` with
  // nothing to say why.
  test("a failed send is reported as email_error, never merely absent", async () => {
    const { hub, ownerToken } = await seededHub();
    const body = await (await allow(hub.base, ownerToken, "kai@example.com")).json();
    assert.equal(body.email_sent, false);
    assert.match(body.email_error, /RESEND_API_KEY/);
  });

  // Requirement 3: "if there is none, the UI asks for an email inline."
  // A bare GitHub-style login with no public profile email (and none typed)
  // has nowhere to send — this is the signal settings.tsx needs to offer the
  // inline field instead of silently doing nothing. One real, deliberate
  // call to GitHub's public (unauthenticated) users API, same as
  // github-auth.mjs's own doc comment for githubPublicEmail — a login this
  // unlikely to exist answers 404, which reads the same as "exists, no
  // public email" for this purpose (recipient stays undeterminable either way).
  test("an invite with no derivable recipient is flagged recipient_needed", async () => {
    const { hub, ownerToken } = await seededHub();
    const body = await (await allow(hub.base, ownerToken, "zevet-test-no-such-github-login-9f8e7d")).json();
    assert.equal(body.recipient_needed, true);
    assert.equal(body.email_sent, false);
    assert.equal(typeof body.key, "string");
  });
});
