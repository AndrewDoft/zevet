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
import { deriveAuthToken } from "../hub/accounts.mjs";

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
    const hub = await teamHub();
    const a = await create(hub.base);
    const b = await create(hub.base);
    const tokenA = tokenFor(hub, a.team);
    const tokenB = tokenFor(hub, b.team);

    const posted = await post(hub.base, { actor: "trevor" }, tokenA);
    assert.equal(posted.status, 200);

    const snapA = await state(hub.base, tokenA);
    const snapB = await state(hub.base, tokenB);
    const snapDefault = await state(hub.base);

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
    // real transition and not a token that never worked.
    const before = await fetch(`${hub.base}/api/state?token=${tokenOrphan}`);
    assert.equal(before.status, 200);
    await before.text();

    await new Promise((r) => setTimeout(r, 200)); // past the 50ms window

    // The sweep runs lazily, before a new team is minted — see
    // sweepUnclaimedTeams() in hub/server.mjs — so creating a second team is
    // what triggers it, not a wait for the hourly interval.
    const second = await create(hub.base);
    assert.equal(second.ok, true);

    const after = await fetch(`${hub.base}/api/state?token=${tokenOrphan}`);
    assert.equal(after.status, 401, "the orphan's token must no longer resolve to a team");
    await after.text();

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

    const res = await fetch(`${hub.base}/api/state?token=${tokenFresh}`);
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
