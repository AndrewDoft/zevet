// Team-held model credentials (D-0NN): /team/credentials' list/add/delete
// and /team/credentials/:id/secret, plus the per-team isolation every other
// route in this file already gets for free from resolveTeam.
//
// Sessions are SEEDED directly into the accounts file rather than run
// through a real GitHub/Google OAuth round trip — see
// test/github-signin.test.mjs's "signing yourself out" describe, which does
// the same thing for the same reason (no outbound request per assertion).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHub } from "./helpers.mjs";

const OWNER_SESSION = "a".repeat(64);
const MEMBER_SESSION = "b".repeat(64);
const OTHER_MEMBER_SESSION = "d".repeat(64);
const SHARED_TOKEN = "t".repeat(64);

// All THREE sessions are seeded before the hub ever starts — an Accounts
// instance reads its file once, at construction, and never again (only
// #save() touches it after that), so a session written to the file after
// startHub() has returned would simply never be seen by the running process.
function seededHub(dir, extra = {}) {
  const file = path.join(dir, "accounts.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      secret: "c".repeat(48),
      owner: { login: "andrewdoft", display: "AndrewDoft", id: "1001", added: new Date().toISOString() },
      allowed: [
        { provider: "github", login: "trevor", display: "trevor", id: "1002", added: new Date().toISOString() },
        { provider: "github", login: "priya", display: "priya", id: "1003", added: new Date().toISOString() },
      ],
      blocked: [],
      sessions: {
        [OWNER_SESSION]: { login: "andrewdoft", id: "1001", at: Date.now() },
        [MEMBER_SESSION]: { login: "trevor", id: "1002", at: Date.now() },
        [OTHER_MEMBER_SESSION]: { login: "priya", id: "1003", at: Date.now() },
      },
      credentials: [],
      ...extra,
    }),
  );
  return file;
}

describe("team credentials", () => {
  const hubs = [];
  let dir;
  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "zevet-team-creds-"));
    seededHub(dir);
    const h = await startHub({ ZEVET_ACCOUNTS: path.join(dir, "accounts.json"), ZEVET_TOKEN: SHARED_TOKEN });
    hubs.push(h);
  });
  after(async () => {
    for (const h of hubs) if (h.stop) await h.stop();
  });

  function hub() {
    return hubs[0];
  }

  test("owner adds a credential; it appears in the list without the secret", async () => {
    const res = await fetch(`${hub().base}/team/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": OWNER_SESSION },
      body: JSON.stringify({ label: "shared key", provider: "anthropic", kind: "api_key", key: "sk-ant-api03-abcdefghijklmnopqrstuvwx" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.id);

    const list = await fetch(`${hub().base}/team/credentials`, { headers: { "x-zevet-token": SHARED_TOKEN } }).then((r) => r.json());
    const rec = list.credentials.find((c) => c.id === body.id);
    assert.ok(rec);
    assert.equal(rec.label, "shared key");
    assert.equal(rec.provider, "anthropic");
    assert.equal(rec.kind, "api_key");
    assert.equal(rec.last4, "uvwx");
    assert.equal(rec.addedBy, "andrewdoft");
    assert.equal(JSON.stringify(list).includes("sk-ant-api03"), false, "the raw key must never appear in the list response");
  });

  test("a signed-in member (not just the owner) can add a credential, recorded as its addedBy", async () => {
    const res = await fetch(`${hub().base}/team/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": MEMBER_SESSION },
      body: JSON.stringify({ provider: "openai", kind: "api_key", key: "sk-openai-1234567890abcdefghij" }),
    });
    assert.equal(res.status, 200);
    const { id } = await res.json();
    const meta = await fetch(`${hub().base}/team/credentials`, { headers: { "x-zevet-token": SHARED_TOKEN } })
      .then((r) => r.json())
      .then((b) => b.credentials.find((c) => c.id === id));
    assert.equal(meta.addedBy, "trevor");
  });

  test("a shared-token caller (no login) cannot add a credential", async () => {
    const res = await fetch(`${hub().base}/team/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": SHARED_TOKEN },
      body: JSON.stringify({ provider: "anthropic", kind: "api_key", key: "sk-ant-api03-abcdefghijklmnopqrstuvwx" }),
    });
    assert.equal(res.status, 403);
  });

  test("a subscription token is rejected for team scope, by kind and by prefix", async () => {
    const byKind = await fetch(`${hub().base}/team/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": OWNER_SESSION },
      body: JSON.stringify({ provider: "anthropic", kind: "subscription_token", key: "sk-ant-oat01-abcdefghijklmnopqrstuvwx" }),
    });
    assert.equal(byKind.status, 400);
    assert.match((await byKind.json()).error, /single-person/);

    const byPrefix = await fetch(`${hub().base}/team/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": OWNER_SESSION },
      body: JSON.stringify({ provider: "anthropic", kind: "api_key", key: "sk-ant-oat01-mislabelledasapikey" }),
    });
    assert.equal(byPrefix.status, 400);
    assert.match((await byPrefix.json()).error, /single-person/);
  });

  test("an unsupported provider/kind combination is rejected at add time", async () => {
    const res = await fetch(`${hub().base}/team/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": OWNER_SESSION },
      body: JSON.stringify({ provider: "mistral", kind: "api_key", key: "whatever-key-value-here" }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /unsupported credential type/);
  });

  test("a malformed Anthropic key is rejected", async () => {
    const res = await fetch(`${hub().base}/team/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": OWNER_SESSION },
      body: JSON.stringify({ provider: "anthropic", kind: "api_key", key: "not-a-real-key" }),
    });
    assert.equal(res.status, 400);
  });

  test("an authenticated member can read the secret; the owner can too", async () => {
    const add = await fetch(`${hub().base}/team/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": MEMBER_SESSION },
      body: JSON.stringify({ provider: "anthropic", kind: "api_key", key: "sk-ant-api03-readbyeverymember00000" }),
    }).then((r) => r.json());

    const asMember = await fetch(`${hub().base}/team/credentials/${add.id}/secret`, { headers: { "x-zevet-token": MEMBER_SESSION } });
    assert.equal(asMember.status, 200);
    assert.equal((await asMember.json()).key, "sk-ant-api03-readbyeverymember00000");

    const asOwner = await fetch(`${hub().base}/team/credentials/${add.id}/secret`, { headers: { "x-zevet-token": OWNER_SESSION } });
    assert.equal(asOwner.status, 200);

    const asShared = await fetch(`${hub().base}/team/credentials/${add.id}/secret`, { headers: { "x-zevet-token": SHARED_TOKEN } });
    assert.equal(asShared.status, 200, "a shared-token caller is still an authenticated member of the team, and may read");
  });

  test("a member of another team cannot read this team's credential at all", async () => {
    // Deliberately UNSEEDED — a fresh, unclaimed accounts file, so
    // OWNER_SESSION (a seeded token that belongs to the FIRST hub's process)
    // resolves to nothing here: no shared-token match (different ZEVET_TOKEN)
    // and no session (this hub has never heard of that token).
    const otherDir = mkdtempSync(path.join(tmpdir(), "zevet-team-creds-other-"));
    const otherHub = await startHub({ ZEVET_ACCOUNTS: path.join(otherDir, "accounts.json"), ZEVET_TOKEN: "z".repeat(64) });
    hubs.push(otherHub);

    const add = await fetch(`${hub().base}/team/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": OWNER_SESSION },
      body: JSON.stringify({ provider: "anthropic", kind: "api_key", key: "sk-ant-api03-onlyteamamembers0000" }),
    }).then((r) => r.json());

    // The SAME session token string, presented to a DIFFERENT hub process
    // that has never seen it, resolves to nothing there — proving isolation
    // is per-hub-process/team, not a property of the string itself.
    const res = await fetch(`${otherHub.base}/team/credentials/${add.id}/secret`, { headers: { "x-zevet-token": OWNER_SESSION } });
    assert.equal(res.status, 401);
  });

  test("clearing: a non-owner who did not add it cannot delete it; the owner can", async () => {
    const add = await fetch(`${hub().base}/team/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": MEMBER_SESSION },
      body: JSON.stringify({ provider: "openai", kind: "api_key", key: "sk-openai-ownerdeletestest0000000" }),
    }).then((r) => r.json());

    // A second, unrelated member cannot delete trevor's credential.
    const deniedRes = await fetch(`${hub().base}/team/credentials/${add.id}`, {
      method: "DELETE",
      headers: { "x-zevet-token": OTHER_MEMBER_SESSION },
    });
    assert.equal(deniedRes.status, 403);

    const ownerRes = await fetch(`${hub().base}/team/credentials/${add.id}`, {
      method: "DELETE",
      headers: { "x-zevet-token": OWNER_SESSION },
    });
    assert.equal(ownerRes.status, 200);

    const list = await fetch(`${hub().base}/team/credentials`, { headers: { "x-zevet-token": SHARED_TOKEN } }).then((r) => r.json());
    assert.equal(list.credentials.some((c) => c.id === add.id), false);
  });

  test("whoever added a credential can delete their own, without being the owner", async () => {
    const add = await fetch(`${hub().base}/team/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": MEMBER_SESSION },
      body: JSON.stringify({ provider: "openai", kind: "api_key", key: "sk-openai-selfdeletetest00000000" }),
    }).then((r) => r.json());

    const res = await fetch(`${hub().base}/team/credentials/${add.id}`, {
      method: "DELETE",
      headers: { "x-zevet-token": MEMBER_SESSION },
    });
    assert.equal(res.status, 200);
  });

  test("deleting a nonexistent credential is a 404", async () => {
    const res = await fetch(`${hub().base}/team/credentials/nope`, {
      method: "DELETE",
      headers: { "x-zevet-token": OWNER_SESSION },
    });
    assert.equal(res.status, 404);
  });

  test("/auth/whoami never contains a credential secret", async () => {
    await fetch(`${hub().base}/team/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": OWNER_SESSION },
      body: JSON.stringify({ provider: "anthropic", kind: "api_key", key: "sk-ant-api03-neverinwhoami00000000" }),
    });
    const who = await fetch(`${hub().base}/auth/whoami`, { headers: { "x-zevet-token": OWNER_SESSION } }).then((r) => r.text());
    assert.equal(who.includes("sk-ant-api03-neverinwhoami00000000"), false);
  });
});
