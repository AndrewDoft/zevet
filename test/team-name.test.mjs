// A team has a name: given at /team/create, echoed in /auth/whoami, persisted,
// and defaulted for a team made before names existed.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHub } from "./helpers.mjs";
import { deriveAuthToken } from "../hub/accounts.mjs";

const hubs = [];
after(async () => {
  for (const h of hubs) await h.stop();
});

async function teamHub() {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-team-name-"));
  const h = await startHub({ ZEVET_GITHUB_CLIENT_ID: "test-client-id", ZEVET_ACCOUNTS: path.join(dir, "accounts.json") });
  hubs.push(h);
  h.dir = dir;
  return h;
}

const create = (base, body) =>
  fetch(`${base}/team/create`, {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

const whoami = (hub, team) => {
  const secret = JSON.parse(readFileSync(path.join(hub.dir, `accounts-${team}.json`), "utf8")).secret;
  return fetch(`${hub.base}/auth/whoami`, { headers: { "x-zevet-token": deriveAuthToken(secret) } }).then((r) => r.json());
};

describe("team names", () => {
  test("a JSON create must carry a name", async () => {
    const hub = await teamHub();
    for (const body of [{}, { name: "" }, { name: "   " }, { name: "x".repeat(49) }, { name: "a\u0000b" }, { name: 7 }]) {
      const r = await create(hub.base, body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
  });

  test("the name is trimmed, echoed, and shown by whoami", async () => {
    const hub = await teamHub();
    const r = await (await create(hub.base, { name: "  Acme   platform " })).json();
    assert.equal(r.ok, true);
    assert.equal(r.name, "Acme platform");
    assert.equal((await whoami(hub, r.team)).teamName, "Acme platform");
  });

  test("it is persisted in the team's accounts file", async () => {
    const hub = await teamHub();
    const r = await (await create(hub.base, { name: "Kept" })).json();
    const file = JSON.parse(readFileSync(path.join(hub.dir, `accounts-${r.team}.json`), "utf8"));
    assert.equal(file.name, "Kept");
  });

  test("a body-less create (an older client) still works and gets a default name", async () => {
    const hub = await teamHub();
    const r = await (await create(hub.base)).json();
    assert.equal(r.ok, true);
    assert.equal(r.name, `Team ${r.team.slice(0, 4)}`);
    assert.equal((await whoami(hub, r.team)).teamName, r.name);
  });

  test("an accounts file from before names existed loads with a default", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zevet-team-name-"));
    const file = path.join(dir, "accounts.json");
    const secret = "ab".repeat(24);
    writeFileSync(file, JSON.stringify({ version: 1, secret, owner: null, allowed: [], blocked: [], sessions: {}, createdAt: 1, credentials: [] }));
    const h = await startHub({ ZEVET_TOKEN: "", ZEVET_GITHUB_CLIENT_ID: "test-client-id", ZEVET_ACCOUNTS: file });
    hubs.push(h);
    const r = await fetch(`${h.base}/auth/whoami`, { headers: { "x-zevet-token": deriveAuthToken(secret) } }).then((x) => x.json());
    assert.equal(r.teamName, "Main team");
  });
  test("the hub's original team resolves by its ZEVET_TEAM_NAME and that name is taken", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zevet-team-name-"));
    const hub = await startHub({ ZEVET_GITHUB_CLIENT_ID: "test-client-id", ZEVET_ACCOUNTS: path.join(dir, "accounts.json"), ZEVET_TEAM_NAME: "Masoretes" });
    hubs.push(hub);
    const found = await (await fetch(`${hub.base}/team/resolve?name=masoretes`)).json();
    assert.equal(found.exists, true);
    const dup = await create(hub.base, { name: "Masoretes" });
    assert.equal(dup.status, 409);
  });

  // BUG-2026-09-28: /team/resolve correctly answered {"exists":true,"team":"default"}
  // for the default team's own configured name, but every route a desktop client
  // calls NEXT with that resolved slug (team/join, auth/github/start,
  // auth/google/start) rejected it with "no such team" — findTeam("default")
  // returns null by design (its own DEFAULT_TEAM guard), and nothing translated
  // the already-resolved slug back before handing it to findTeam a second time.
  test("resolving the default team's own name and then joining/signing in with the resolved slug does not say 'no such team'", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zevet-team-name-"));
    const hub = await startHub({ ZEVET_GITHUB_CLIENT_ID: "test-client-id", ZEVET_ACCOUNTS: path.join(dir, "accounts.json"), ZEVET_TEAM_NAME: "Masoretes" });
    hubs.push(hub);

    const resolved = await (await fetch(`${hub.base}/team/resolve?name=Masoretes`)).json();
    assert.deepEqual(resolved, { exists: true, team: "default" });

    // Same slug /team/resolve just handed back, fed straight into the very
    // next call a real join or sign-in makes — this is the exact round trip
    // setup.html's teamFor() does. /team/join is used rather than
    // auth/github/start because it never leaves this process (acc.redeem is
    // local), so the assertion is only about resolveTeamSlug, not GitHub.
    const joined = await (
      await fetch(`${hub.base}/team/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ team: resolved.team, key: "ZZZZ-ZZZZ" }),
      })
    ).json();
    // A deliberately wrong key still reaches "bad key" (acc.redeem), not the
    // 404 "no such team" this bug produced before the fix could even ask.
    assert.equal(joined.error, "bad key");
  });
});
