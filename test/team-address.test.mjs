// A team's name is its address: the slug is derived from it, unique per hub,
// resolvable by name, and survives a restart.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHub } from "./helpers.mjs";

const hubs = [];
after(async () => {
  for (const h of hubs) await h.stop();
});

const create = (base, name) =>
  fetch(`${base}/team/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
const resolve = (base, name) => fetch(`${base}/team/resolve?name=${encodeURIComponent(name)}`).then((r) => r.json());

describe("team name = team address", () => {
  test("slug is the lowercased name; a clash says Taken and suggests name-2", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zevet-addr-"));
    const env = { ZEVET_GITHUB_CLIENT_ID: "x", ZEVET_ACCOUNTS: path.join(dir, "accounts.json") };
    const h = await startHub(env);
    hubs.push(h);
    const a = await (await create(h.base, "Metrodora")).json();
    assert.equal(a.team, "metrodora");
    assert.equal(a.name, "Metrodora");
    const b = await create(h.base, "  METRODORA ");
    assert.equal(b.status, 409);
    const bj = await b.json();
    assert.equal(bj.error, "Taken");
    assert.equal(bj.suggest, "metrodora-2");
    assert.equal((await (await create(h.base, "metrodora-2")).json()).team, "metrodora-2");
    assert.equal((await create(h.base, "Metrodora 2")).status, 409); // same slug
    assert.equal((await create(h.base, "default")).status, 409); // reserved
    assert.equal((await create(h.base, "!!!")).status, 400);

    // resolves by any spelling, and says nothing else
    assert.deepEqual(await resolve(h.base, "Metrodora"), { exists: true, team: "metrodora" });
    assert.deepEqual(await resolve(h.base, "nope"), { exists: false });
    assert.deepEqual(await resolve(h.base, "default"), { exists: false });

    // survives a restart: the name is still taken
    await h.stop();
    hubs.splice(hubs.indexOf(h), 1);
    const h2 = await startHub(env);
    hubs.push(h2);
    assert.deepEqual(await resolve(h2.base, "metrodora"), { exists: true, team: "metrodora" });
    assert.equal((await create(h2.base, "metrodora")).status, 409);
  });

  test("a legacy random-slug team resolves by its stored name", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zevet-addr-"));
    writeFileSync(
      path.join(dir, "accounts-0123456789.json"),
      JSON.stringify({ version: 1, secret: "ab".repeat(24), owner: null, allowed: [], blocked: [], sessions: {}, createdAt: Date.now(), credentials: [], name: "Old Team" }),
    );
    const h = await startHub({ ZEVET_GITHUB_CLIENT_ID: "x", ZEVET_ACCOUNTS: path.join(dir, "accounts.json") });
    hubs.push(h);
    assert.deepEqual(await resolve(h.base, "old team"), { exists: true, team: "0123456789" });
    assert.equal((await create(h.base, "Old Team")).status, 409);
  });
});
