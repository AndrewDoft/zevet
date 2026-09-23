// Who the hub lets in, and what it does with the one secret it now holds.
//
// The stakes here are higher than the line count suggests. This module decides
// membership of a hub that hands out the key to every document the team has
// ever edited — see the header of hub/accounts.mjs for why it holds that key at
// all, and what was given up to get there. The cases below are the ones where
// being wrong is silent: a second owner, a session that outlives a revocation,
// a corrupt file quietly replaced by a fresh secret nobody's documents match.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { tempDir, ROOT } from "./helpers.mjs";
import { Accounts, deriveAuthToken } from "../hub/accounts.mjs";
import { deriveAuthToken as clientDerive } from "../client/secret.mjs";

const SECRET = "b657f739acac8df9ab4ed156d091d1983bd10f1254689071";
const alice = { login: "AndrewDoft", id: "1001" };
const bob = { login: "kai", id: "1002" };
const mallory = { login: "mallory", id: "9999" };

/** A temp directory that cleans itself up when the test ends. */
function tmp(t) {
  const d = tempDir();
  t.after(() => d.cleanup());
  return d.dir;
}

function store(t, opts = {}) {
  return new Accounts({ file: path.join(tmp(t), "accounts.json"), ...opts });
}

describe("the shared secret", () => {
  test("adopts ZEVET_SECRET rather than inventing one", (t) => {
    // ⚠️ THE MIGRATION CASE, and the expensive one to get wrong. There is a
    // secret in the field that existing installs hold and existing documents
    // are encrypted under. A hub that generated a fresh one here would hand
    // every teammate a key that decrypts nothing they already have.
    const a = store(t, { secret: SECRET });
    assert.equal(a.secret, SECRET);
  });

  test("invents one only when there is none, and persists it", (t) => {
    const dir = tmp(t);
    const file = path.join(dir, "accounts.json");
    const first = new Accounts({ file }).secret;
    assert.match(first, /^[0-9a-f]{48}$/);
    // A second hub on the same file must NOT re-roll it. Re-rolling on restart
    // is the same orphaning failure as above, just on a timer.
    assert.equal(new Accounts({ file }).secret, first);
  });

  test("refuses a malformed ZEVET_SECRET instead of silently replacing it", (t) => {
    const dir = tmp(t);
    assert.throws(
      () => new Accounts({ file: path.join(dir, "a.json"), secret: "not-hex-at-all" }),
      /not at least 24 bytes of hex/,
    );
  });

  test("derives the SAME token the client derives", () => {
    // hub/accounts.mjs duplicates this eleven-line function on purpose (the hub
    // must not import out of client/, a directory it serves to other machines).
    // Duplicated code that drifts is worse than the import it avoided, so the
    // agreement is asserted rather than assumed.
    assert.equal(deriveAuthToken(SECRET), clientDerive(SECRET));
  });
});

describe("createdAt — what server.mjs's unclaimed-team sweep relies on", () => {
  test("is stamped once, on first write, and survives a reload unchanged", (t) => {
    let now = 1_000_000;
    const file = path.join(tmp(t), "accounts.json");
    const a = new Accounts({ file, now: () => now });
    assert.equal(a.createdAt, 1_000_000);

    now = 9_999_999; // time passes, and a later boot must not re-stamp it
    const reloaded = new Accounts({ file, now: () => now });
    assert.equal(reloaded.createdAt, 1_000_000, "createdAt must not move on reload");
  });

  test("an accounts.json from before createdAt existed is treated as new, not ancient", (t) => {
    // The safe direction to be wrong in: a sweep that deletes unclaimed teams
    // by age must never treat "we don't know" as "old enough to delete".
    const file = path.join(tmp(t), "accounts.json");
    writeFileSync(file, JSON.stringify({ version: 1, secret: SECRET, owner: null, allowed: [], blocked: [], sessions: {} }));
    let now = 42;
    const a = new Accounts({ file, now: () => now });
    assert.equal(a.createdAt, 42);
  });

  test("signing in sets owner — the fact the sweep uses to never touch a claimed team", (t) => {
    const a = store(t);
    assert.equal(a.owner, null);
    a.signIn(alice);
    assert.ok(a.owner, "a claimed team's Accounts must report an owner regardless of its age");
  });
});

describe("trust on first use", () => {
  test("the first sign-in becomes the owner", (t) => {
    const a = store(t);
    assert.equal(a.owner, null);
    assert.equal(a.mayEnter(alice).ok, true);
    const s = a.signIn(alice);
    assert.equal(s.owner, true);
    assert.equal(a.owner, "andrewdoft");
  });

  test("the second sign-in is refused once there is an owner", (t) => {
    const a = store(t);
    a.signIn(alice);
    const may = a.mayEnter(mallory);
    assert.equal(may.ok, false);
    // The error has to name who can fix it, or the person is stuck.
    assert.match(may.error, /@andrewdoft/);
  });

  test("ZEVET_GITHUB_OWNER closes the first-use window", (t) => {
    const a = store(t);
    assert.equal(a.mayEnter(mallory, { requiredOwner: "andrewdoft" }).ok, false);
    assert.equal(a.mayEnter(alice, { requiredOwner: "AndrewDoft" }).ok, true);
  });

  test("the owner cannot be displaced by a second successful sign-in", (t) => {
    const a = store(t);
    a.signIn(alice);
    a.allow("kai");
    const s = a.signIn(bob);
    assert.equal(s.owner, false);
    assert.equal(a.owner, "andrewdoft");
  });
});

describe("the list", () => {
  test("an invited login may enter before it has ever signed in", (t) => {
    const a = store(t);
    a.signIn(alice);
    assert.equal(a.mayEnter(bob).ok, false);
    assert.equal(a.allow("@kai").ok, true);          // a pasted @handle is normal
    assert.equal(a.mayEnter(bob).ok, true);
  });

  test("a renamed login cannot be inherited by a stranger", (t) => {
    // ⚠️ THE REASON ids ARE STORED. GitHub lets you change your username, and
    // lets somebody else claim the one you dropped. An allowlist keyed on the
    // string alone is an allowlist that can be inherited by whoever registers
    // the name next.
    const a = store(t);
    a.signIn(alice);
    a.signIn(bob);                                    // kai, id 1002, now known
    const impostor = { login: "kai", id: "4242" };    // same name, new account
    assert.equal(a.mayEnter(impostor).ok, false);
  });

  test("rejects things that are not GitHub usernames", (t) => {
    const a = store(t);
    a.signIn(alice);
    for (const bad of ["", "  ", "-leading", "trailing-", "has space", "a".repeat(40), "why/not"]) {
      assert.equal(a.allow(bad).ok, false, `accepted ${JSON.stringify(bad)}`);
    }
  });

  test("the owner cannot be removed", (t) => {
    const a = store(t);
    a.signIn(alice);
    const r = a.revoke("andrewdoft");
    assert.equal(r.ok, false);
    assert.equal(a.owner, "andrewdoft");
  });
});

describe("sessions", () => {
  test("a minted session validates and a random one does not", (t) => {
    const a = store(t);
    const { token } = a.signIn(alice);
    assert.ok(a.session(token));
    assert.equal(a.session("f".repeat(64)), null);
    assert.equal(a.session("short"), null);
    assert.equal(a.session(null), null);
  });

  test("revoking a login kills its live session immediately", (t) => {
    // The whole point of preferring a session over the derived token in
    // resolveAuth. If this does not hold, removing somebody from the list is
    // decoration.
    const a = store(t);
    a.signIn(alice);
    const { token } = a.signIn(bob);
    assert.ok(a.session(token));
    a.revoke("kai");
    assert.equal(a.session(token), null);
  });

  test("a session expires after ninety idle days", (t) => {
    let now = 1_000_000_000_000;
    const dir = tmp(t);
    const a = new Accounts({ file: path.join(dir, "a.json"), now: () => now });
    // ⚠️ TWO SEPARATE SESSIONS, because CHECKING one refreshes it. An
    // earlier version of this test asked at 89 days and then at 91, and passed
    // for the wrong reason: the 89-day check reset the clock, so the second
    // question was "is a two-day-old session alive". Idle means untouched.
    const live = a.signIn(alice).token;
    now += 89 * 24 * 60 * 60 * 1000;
    assert.ok(a.session(live), "89 idle days should still be live");

    now = 1_000_000_000_000;
    const dead = a.signIn(alice).token;
    now += 91 * 24 * 60 * 60 * 1000;
    assert.equal(a.session(dead), null, "91 idle days should be gone");
  });

  test("use keeps a session alive — the ninety days are idle, not absolute", (t) => {
    let now = 1_000_000_000_000;
    const dir = tmp(t);
    const a = new Accounts({ file: path.join(dir, "a.json"), now: () => now });
    const { token } = a.signIn(alice);
    for (let i = 0; i < 10; i++) {
      now += 80 * 24 * 60 * 60 * 1000;
      assert.ok(a.session(token), `dead after ${i} periods of use`);
    }
  });

  test("sessions survive a restart", (t) => {
    const dir = tmp(t);
    const file = path.join(dir, "a.json");
    const { token } = new Accounts({ file }).signIn(alice);
    // A hub restart that signed everybody out would make every deploy a
    // support incident.
    assert.ok(new Accounts({ file }).session(token));
  });

  test("logging out ends one session and nothing else", (t) => {
    const a = store(t);
    const mine = a.signIn(alice).token;
    const theirs = a.signIn(bob).token;
    assert.deepEqual(a.logout(mine), { ok: true, loggedOut: true });
    assert.equal(a.session(mine), null, "my session survived my logout");
    assert.ok(a.session(theirs), "somebody else's session died with mine");
    assert.equal(a.owner, "andrewdoft", "ownership moved");
    // Unknown and malformed tokens are a no-op, not an error: logout is
    // idempotent, and a double-click must not be able to fail.
    assert.deepEqual(a.logout(mine), { ok: true, loggedOut: false });
    assert.deepEqual(a.logout("f".repeat(64)), { ok: true, loggedOut: false });
    assert.deepEqual(a.logout("short"), { ok: true, loggedOut: false });
  });
});

describe("the file", () => {
  // The 0600 mode is requested in #save and is honoured on the deployed
  // Linux box; Windows largely ignores it, so it is not asserted here rather
  // than asserted in a way that would only be true on one platform.
  test("holds the secret and the owner", (t) => {
    const dir = tmp(t);
    const file = path.join(dir, "a.json");
    const a = new Accounts({ file, secret: SECRET });
    a.signIn(alice);
    assert.ok(existsSync(file));
    const raw = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(raw.secret, SECRET);
    assert.equal(raw.owner.login, "andrewdoft");
  });

  test("NEVER stores the GitHub access token", (t) => {
    // Keeping it would turn this file from a list of names into a set of live
    // credentials to other people's GitHub accounts.
    const dir = tmp(t);
    const file = path.join(dir, "a.json");
    const a = new Accounts({ file });
    a.signIn({ ...alice, accessToken: "gho_thisMustNeverBeWritten" });
    assert.equal(readFileSync(file, "utf8").includes("gho_"), false);
  });

  test("a corrupt file refuses to start rather than issuing a new secret", (t) => {
    // ⚠️ The loud failure is the correct one. Starting empty would mint a fresh
    // master secret and orphan every encrypted document the team has, and the
    // symptom would be an editor full of blank files with no error anywhere.
    const dir = tmp(t);
    const file = path.join(dir, "a.json");
    writeFileSync(file, "{ this is not json");
    assert.throws(() => new Accounts({ file }), /Refusing to start/);
  });

  test("a missing file is not corruption — it is a first run", (t) => {
    const dir = tmp(t);
    assert.doesNotThrow(() => new Accounts({ file: path.join(dir, "nope", "a.json") }));
  });

  test("with no file at all it still works, in memory", () => {
    // How the hub runs when no GitHub app is configured: nothing to persist,
    // so nothing is written into the tree.
    const a = new Accounts({ file: null, secret: SECRET });
    assert.equal(a.secret, SECRET);
    assert.equal(a.signIn(alice).owner, true);
  });
});

describe("resolveAuth, once a session exists", () => {
  test("a session outranks the derived token", async () => {
    const { resolveAuth } = await import("../client/secret.mjs");
    const a = resolveAuth({ env: {}, file: { session: "s".repeat(64), secret: SECRET } });
    assert.equal(a.token, "s".repeat(64));
    assert.equal(a.session, true);
    // The secret is still carried: the EDITOR needs it, because the document
    // key is HKDF(S) and no session can stand in for that.
    assert.equal(a.secret, SECRET);
  });

  test("a session alone works, and simply has no document key", async () => {
    const { resolveAuth } = await import("../client/secret.mjs");
    const a = resolveAuth({ env: {}, file: { session: "s".repeat(64) } });
    assert.equal(a.token, "s".repeat(64));
    assert.equal(a.secret, "");
    assert.equal(a.error, null);
  });

  test("a malformed secret beside a session costs the editor, not the board", async () => {
    const { resolveAuth } = await import("../client/secret.mjs");
    const a = resolveAuth({ env: {}, file: { session: "s".repeat(64), secret: "nonsense" } });
    assert.equal(a.token, "s".repeat(64), "the board must still connect");
    assert.equal(a.secret, "");
  });

  test("no session behaves exactly as it always did", async () => {
    const { resolveAuth, deriveAuthToken: d } = await import("../client/secret.mjs");
    assert.equal(resolveAuth({ env: {}, file: { secret: SECRET } }).token, d(SECRET));
    assert.equal(resolveAuth({ env: {}, file: { token: "legacy" } }).legacy, true);
  });

  test("the desktop actually passes the session through to resolveAuth", async () => {
    // ⚠️ `authFor` in main.js hands resolveAuth a HAND-WRITTEN OBJECT of three
    // fields rather than the config. A credential missing from that list is not
    // an error -- the app quietly keeps authenticating with the old one while
    // Settings reports the new one. Asserted because nothing else would notice.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8");
    // Non-greedy across `env: {}` -- which contains a brace, so the obvious
    // [^}]* never reaches `file:` at all.
    const call = /resolveAuth\(\{[\s\S]{0,120}?file:\s*\{([^}]*)\}/.exec(src);
    assert.ok(call, "main.js no longer calls resolveAuth the way this test expects");
    for (const field of ["secret", "token", "session"]) {
      assert.ok(call[1].includes(`${field}:`), `authFor drops ${field}`);
    }
  });
});
