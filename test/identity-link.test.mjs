// The board's link flow (board/src/lib/identity.mjs), run against a scripted
// fetch: what it sends, that it always says `link: true` with the session
// cookie, and how it ends.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { linkAccount, unlinkAccount, combinePeople, renamePerson, identityLabel } from "../board/src/lib/identity.mjs";

/** Answers each call from a queue of [status, body], recording what was sent. */
function script(answers) {
  const seen = [];
  const f = async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    const [status, body] = answers.shift();
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  f.seen = seen;
  return f;
}
const noSleep = async () => {};

describe("linking GitHub", () => {
  test("starts, shows the code, polls with link:true until linked", async () => {
    const f = script([
      [200, { deviceCode: "dc", userCode: "AB-CD", verificationUriComplete: "https://github.com/login/device?user_code=AB-CD", interval: 5, expiresIn: 900 }],
      [200, { ok: true, pending: true }],
      [200, { ok: true, linked: true, login: "octo", merged: true }],
    ]);
    const shown = [];
    const opened = [];
    const r = await linkAccount("github", { fetchImpl: f, sleep: noSleep, open: (u) => opened.push(u), onWaiting: (w) => shown.push(w) });
    assert.deepEqual(r, { ok: true, login: "octo", merged: true });
    assert.equal(shown[0].code, "AB-CD");
    assert.equal(opened.length, 1);
    assert.equal(f.seen[0].init.credentials, "same-origin", "the session cookie goes with it");
    assert.deepEqual(f.seen[1].body, { deviceCode: "dc", link: true });
    assert.equal(f.seen[1].url, "/auth/github/finish");
  });

  test("a refusal from the hub is said, not swallowed", async () => {
    const f = script([
      [200, { deviceCode: "dc", userCode: "x", interval: 1, expiresIn: 900 }],
      [403, { error: "@kai was removed from this team" }],
    ]);
    const r = await linkAccount("github", { fetchImpl: f, sleep: noSleep });
    assert.deepEqual(r, { ok: false, error: "@kai was removed from this team" });
  });

  test("cancel stops before polling", async () => {
    const f = script([[200, { deviceCode: "dc", userCode: "x", interval: 1, expiresIn: 900 }]]);
    const r = await linkAccount("github", { fetchImpl: f, sleep: noSleep, cancelled: () => true });
    assert.equal(r.cancelled, true);
    assert.equal(f.seen.length, 1);
  });

  test("gives up when the code expires", async () => {
    let t = 0;
    const f = script([[200, { deviceCode: "dc", userCode: "x", interval: 1, expiresIn: 10 }]]);
    const r = await linkAccount("github", { fetchImpl: f, sleep: async () => void (t += 20000), now: () => t });
    assert.match(r.error, /expired/);
  });
});

describe("linking Google", () => {
  test("asks the hub to start in link mode and polls its pair code", async () => {
    const f = script([
      [200, { pairCode: "pc", authUrl: "https://accounts.google.com/x", interval: 2, expiresIn: 600 }],
      [200, { ok: true, pending: true }],
      [200, { ok: true, linked: true, login: "a@b.example" }],
    ]);
    const r = await linkAccount("google", { fetchImpl: f, sleep: noSleep });
    assert.deepEqual(r, { ok: true, login: "a@b.example", merged: false });
    assert.deepEqual(f.seen[0].body, { link: true });
    assert.deepEqual(f.seen[2].body, { pairCode: "pc" });
  });

  test("not signed in is the hub's 401, passed through", async () => {
    const f = script([[401, { error: "sign in before linking another account" }]]);
    const r = await linkAccount("google", { fetchImpl: f, sleep: noSleep });
    assert.equal(r.ok, false);
    assert.match(r.error, /sign in before linking/);
  });

  test("a network failure resolves, never rejects", async () => {
    const r = await linkAccount("google", { fetchImpl: async () => { throw new Error("offline"); }, sleep: noSleep });
    assert.deepEqual(r, { ok: false, error: "Could not connect." });
  });
});

describe("unlink and combine", () => {
  test("unlink posts the provider and login", async () => {
    const f = script([[200, { ok: true }]]);
    assert.deepEqual(await unlinkAccount(f, { provider: "google", login: "a@b.example" }), { ok: true });
    assert.deepEqual(f.seen[0].body, { provider: "google", login: "a@b.example" });
  });

  test("combine passes the owner's refusal through", async () => {
    const f = script([[403, { error: "only @andrewdoft can combine people" }]]);
    const r = await combinePeople(f, { into: "kai", from: "andrew" });
    assert.match(r.error, /only @andrewdoft/);
  });

  test("labels name the provider", () => {
    assert.equal(identityLabel({ provider: "github", login: "octo" }), "GitHub · @octo");
    assert.equal(identityLabel({ provider: "google", login: "a@b.example" }), "Google · a@b.example");
  });
});

describe("admin rename", () => {
  test("the owner names the person by stable key; renaming yourself sends no key", async () => {
    const f = script([[200, { ok: true }], [200, { ok: true }]]);
    assert.deepEqual(await renamePerson(f, { login: "kai", name: "Kai K" }), { ok: true });
    assert.deepEqual(f.seen[0].body, { login: "kai", name: "Kai K" });
    await renamePerson(f, { name: "me" });
    assert.deepEqual(f.seen[1].body, { name: "me" });
  });

  test("the hub's refusal is passed through", async () => {
    const f = script([[400, { error: "Bob is already on the board" }]]);
    assert.match((await renamePerson(f, { login: "kai", name: "Bob" })).error, /already on the board/);
  });

  test("Settings offers the owner a rename control for ANY person, and the board claims its own actor", async () => {
    const { readFileSync } = await import("node:fs");
    const ui = readFileSync(new URL("../board/src/components/identity.tsx", import.meta.url), "utf8");
    assert.match(ui, /owner && people\.length > 0[\s\S]{0,900}aria-label="Person to rename"/, "no way for the admin to rename another person");
    assert.match(ui, /renamePerson\(/);
    const board = readFileSync(new URL("../board/src/lib/board.ts", import.meta.url), "utf8");
    assert.match(board, /claimedActors\.add\([^;]*;\s*void renameSelf\(me\.name\)/, "a signed-in machine's actor is never told to the hub, so its events stay a separate person");
  });
});
