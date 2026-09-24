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
});
