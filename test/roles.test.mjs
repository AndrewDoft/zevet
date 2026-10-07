// Roles (Viewer / Commenter / Editor / Owner): stored per person, read live on
// every request, enforced at the hub. The cases below are the ones that fail
// silently: a pre-roles member locked out, a demoted person still acting, a
// role change nobody can see in the audit trail.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Accounts } from "../hub/accounts.mjs";
import { startHub } from "./helpers.mjs";

const owner = { login: "AndrewDoft", id: "1001" };
const kai = { login: "kai", id: "1002" };

function seed() {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-roles-"));
  const file = path.join(dir, "accounts.json");
  const a = new Accounts({ file });
  const ownerTok = a.signIn(owner).token;
  a.allow("kai");
  const kaiTok = a.signIn(kai).token;
  return { file, a, ownerTok, kaiTok };
}

describe("roles in accounts", () => {
  test("a file written before roles migrates: members are Editors, the owner is Owner", () => {
    const { file } = seed();
    const raw = JSON.parse(readFileSync(file, "utf8"));
    for (const m of raw.allowed) delete m.role; // what a pre-roles file looks like
    writeFileSync(file, JSON.stringify(raw));
    const a = new Accounts({ file });
    assert.equal(a.roleOf(owner), "owner");
    assert.equal(a.roleOf(kai), "editor");
    assert.equal(a.can(kai, "steer"), true);
    assert.equal(a.can(kai, "spawn"), true);
  });

  test("setRole changes what a person can do, immediately, and is audited", () => {
    const { a } = seed();
    assert.equal(a.setRole("kai", "commenter", "AndrewDoft").ok, true);
    assert.equal(a.roleOf(kai), "commenter");
    assert.equal(a.can(kai, "claim"), true);
    assert.equal(a.can(kai, "steer"), false);
    a.setRole("kai", "viewer", "AndrewDoft");
    assert.equal(a.can(kai, "claim"), false);
    const roles = a.audit.filter((e) => e.what === "role.kai");
    assert.deepEqual(roles.map((e) => [e.from, e.to, e.by]), [["editor", "commenter", "AndrewDoft"], ["commenter", "viewer", "AndrewDoft"]]);
  });

  test("the owner cannot be re-roled, nobody is made owner, junk is refused", () => {
    const { a } = seed();
    assert.equal(a.setRole("AndrewDoft", "viewer", "x").ok, false);
    assert.equal(a.setRole("kai", "owner", "x").ok, false);
    assert.equal(a.setRole("kai", "root", "x").ok, false);
    assert.equal(a.setRole("nobody", "viewer", "x").ok, false);
    assert.equal(a.roleOf(owner), "owner");
  });

  test("a role survives a restart", () => {
    const { a, file } = seed();
    a.setRole("kai", "viewer", "AndrewDoft");
    assert.equal(new Accounts({ file }).roleOf(kai), "viewer");
  });

  test("a stranger has no role and can do nothing", () => {
    const { a } = seed();
    assert.equal(a.roleOf({ login: "eve", id: "9" }), null);
    assert.equal(a.can({ login: "eve", id: "9" }, "steer"), false);
  });
});

describe("roles through a real hub", () => {
  const hubs = [];
  after(() => Promise.all(hubs.map((h) => h.stop())));

  const call = (hub, token, method, route, body) =>
    fetch(`${hub.base}${route}`, { method, headers: { "content-type": "application/json", "x-zevet-token": token }, body: body === undefined ? undefined : JSON.stringify(body) });

  test("steer and spawn need Editor, and a demotion bites on the very next request", async () => {
    const { file, ownerTok, kaiTok } = seed();
    const hub = await startHub({ ZEVET_ACCOUNTS: file });
    hubs.push(hub);
    // An empty body: an Editor is refused for the BODY (400), never the role.
    for (const route of ["/api/steer", "/api/spawn"]) {
      assert.equal((await call(hub, kaiTok, "POST", route, {})).status, 400, `${route} as editor`);
    }
    const r = await call(hub, ownerTok, "POST", "/auth/role", { login: "kai", role: "commenter" });
    assert.equal(r.status, 200);
    for (const route of ["/api/steer", "/api/spawn"]) {
      const res = await call(hub, kaiTok, "POST", route, {});
      assert.equal(res.status, 403, `${route} as commenter`);
      assert.match((await res.json()).error, /editor role required/);
    }
    // Team credentials hand a key to a machine: Editor and above only.
    assert.equal((await call(hub, kaiTok, "POST", "/team/credentials", {})).status, 403);
    await call(hub, ownerTok, "POST", "/auth/role", { login: "kai", role: "editor" });
    assert.equal((await call(hub, kaiTok, "POST", "/api/steer", {})).status, 400);
  });

  test("only the owner changes roles; the change is in the audit trail; whoami reports it", async () => {
    const { file, ownerTok, kaiTok } = seed();
    const hub = await startHub({ ZEVET_ACCOUNTS: file });
    hubs.push(hub);
    assert.equal((await call(hub, kaiTok, "POST", "/auth/role", { login: "kai", role: "owner" })).status, 403);
    assert.equal((await call(hub, kaiTok, "POST", "/auth/role", { login: "AndrewDoft", role: "viewer" })).status, 403);
    assert.equal((await call(hub, ownerTok, "POST", "/auth/role", { login: "kai", role: "owner" })).status, 400);
    assert.equal((await call(hub, ownerTok, "POST", "/auth/role", { login: "kai", role: "viewer" })).status, 200);
    const who = await (await call(hub, kaiTok, "GET", "/auth/whoami")).json();
    assert.equal(who.role, "viewer");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(stored.audit.at(-1).what, "role.kai");
    assert.equal(stored.audit.at(-1).to, "viewer");
  });

  test("a Viewer's desktop cannot report events or claim work; a Commenter can claim, not report", async () => {
    const { file, ownerTok, kaiTok } = seed();
    const hub = await startHub({ ZEVET_ACCOUNTS: file });
    hubs.push(hub);
    const evt = { actor: "kai", kind: "prompt", detail: "x", agent: "claude-code", repo: "z", session: "s1" };
    assert.equal((await call(hub, kaiTok, "POST", "/ingest", evt)).status, 200);
    await call(hub, ownerTok, "POST", "/auth/role", { login: "kai", role: "viewer" });
    assert.equal((await call(hub, kaiTok, "POST", "/ingest", evt)).status, 403);
    assert.equal((await call(hub, kaiTok, "POST", "/ingest", { actor: "kai", kind: "claim" })).status, 403);
    await call(hub, ownerTok, "POST", "/auth/role", { login: "kai", role: "commenter" });
    assert.equal((await call(hub, kaiTok, "POST", "/ingest", evt)).status, 403);
    assert.notEqual((await call(hub, kaiTok, "POST", "/ingest", { actor: "kai", kind: "claim" })).status, 403);
  });
});
