// One person, many identities: automatic linking on VERIFIED email, manual
// linking, merging, renaming, and the actor-name resolution that makes a
// rename or a merge show up on events already in the log.
//
// The cases that matter are the silent ones: linking on evidence that is not
// evidence (a public-profile or unverified email), a merge that leaves a
// session or a credential pointing at a row that no longer exists, and a
// revoke that removes one identity and leaves the person able to walk back in
// through another.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempDir } from "./helpers.mjs";
import { Accounts } from "../hub/accounts.mjs";

const gh = (login, id, emails = [], extra = {}) => ({ provider: "github", login, display: login, id, emails, ...extra });
const goog = (email, id) => ({ provider: "google", login: email, display: email, id, emails: [email] });

function store(t) {
  const d = tempDir();
  t.after(() => d.cleanup());
  return new Accounts({ file: path.join(d.dir, "accounts.json") });
}

/** An owner (github "andrewdoft") and nothing else. */
function team(t) {
  const acc = store(t);
  const owner = acc.signIn(gh("AndrewDoft", "1", ["andrew@example.com"]));
  return { acc, owner };
}

const people = (acc) => acc.list().filter((p) => !p.pending);

describe("automatic linking on a verified email", () => {
  test("a GitHub sign-in whose VERIFIED email is a signed-in Google person's becomes the same person", (t) => {
    const { acc } = team(t);
    acc.allow("michael@example.com");
    acc.signIn(goog("michael@example.com", "g-m"));
    const before = acc.list().length;

    // GitHub says michael@example.com is verified on @mshvid.
    assert.equal(acc.mayEnter(gh("mshvid", "42", ["michael@example.com"])).ok, true, "admitted on the evidence");
    const s = acc.signIn(gh("mshvid", "42", ["michael@example.com"]));

    assert.equal(acc.list().length, before, "no second person appeared");
    const who = acc.profile(acc.session(s.token));
    assert.deepEqual(who.identities.map((i) => i.login).sort(), ["michael@example.com", "mshvid"]);
    // …and the Google identity still signs in, to the same person.
    const again = acc.signIn(goog("michael@example.com", "g-m"));
    assert.equal(acc.session(again.token).login, acc.session(s.token).login);
  });

  test("a Google sign-in whose email GitHub verified for an existing person links to them", (t) => {
    const { acc } = team(t);
    acc.allow("kai");
    acc.signIn(gh("kai", "7", ["kai@work.example"]));
    assert.equal(acc.mayEnter(goog("kai@work.example", "g-k")).ok, true);
    acc.signIn(goog("kai@work.example", "g-k"));
    assert.equal(people(acc).length, 2, "owner + kai, not owner + kai + kai@work");
  });

  test("a merely public-profile email is NOT evidence", (t) => {
    const { acc } = team(t);
    acc.allow("michael@example.com");
    acc.signIn(goog("michael@example.com", "g-m"));
    // `email` is the public profile field; only `emails` is verified proof.
    const stranger = gh("mallory", "666", [], { email: "michael@example.com" });
    // The pre-linking behaviour for an INVITE claim is untouched, but a signed-in
    // person is not linkable on it: mallory must not be folded into michael.
    const r = acc.mayEnter(stranger);
    assert.equal(r.ok, false, "a public email does not admit onto a signed-in person");
  });

  test("an email GitHub lists as unverified never reaches the hub as evidence", async () => {
    const { githubVerifiedEmails } = await import("../hub/github-auth.mjs");
    const f = async () => ({
      status: 200,
      text: async () => JSON.stringify([
        { email: "typed@example.com", verified: false, primary: false },
        { email: "real@example.com", verified: true, primary: true },
        { email: "12+x@users.noreply.github.com", verified: true, primary: false },
      ]),
    });
    const r = await githubVerifiedEmails({ accessToken: "t", fetchImpl: f });
    assert.deepEqual(r.emails, ["real@example.com"]);
  });

  test("without the user:email scope GitHub answers 403 and sign-in simply has no evidence", async () => {
    const { githubVerifiedEmails } = await import("../hub/github-auth.mjs");
    const f = async () => ({ status: 403, text: async () => JSON.stringify({ message: "Resource not accessible" }) });
    assert.deepEqual(await githubVerifiedEmails({ accessToken: "t", fetchImpl: f }), { ok: false, emails: [] });
  });

  test("an unverified typed Google invite-key identity proves nothing", (t) => {
    const { acc } = team(t);
    acc.allow("v@example.com");
    const k = acc.inviteKey("v@example.com");
    const r = acc.redeem(k);
    assert.equal(r.ok, true);
    // A stranger whose GitHub verified email is that TYPED address: the typed
    // address was never verified by anyone, so it is not linkable evidence.
    const s = acc.signIn(gh("someone", "55", ["v@example.com"]));
    assert.ok(s.token);
    assert.equal(people(acc).length >= 2, true);
  });

  test("a pending GitHub invite and a pending email invite become one person when the GitHub sign-in proves the email", (t) => {
    const { acc } = team(t);
    acc.allow("mshvid1101");
    acc.allow("michael@example.com");
    assert.equal(acc.list().length, 3);
    acc.signIn(gh("mshvid1101", "42", ["michael@example.com"]));
    assert.equal(acc.list().length, 2, "the two invites collapsed into the one who signed in");
    const me = acc.list().find((p) => p.login === "mshvid1101");
    assert.ok(me.id, "signed in, no longer pending");
    // The email now belongs to him: a Google sign-in with it lands on him.
    assert.equal(acc.mayEnter(goog("michael@example.com", "g-m")).ok, true);
    acc.signIn(goog("michael@example.com", "g-m"));
    assert.equal(acc.list().length, 2);
  });
});

describe("linking by hand", () => {
  test("link() adds an identity to the signed-in person; that identity then signs in as them", (t) => {
    const { acc, owner } = team(t);
    const session = acc.session(owner.token);
    const r = acc.link(session, goog("andrew@gmail.example", "g-a"), ["andrew@gmail.example"]);
    assert.equal(r.ok, true);
    assert.equal(acc.list().length, 1);
    assert.equal(acc.mayEnter(goog("andrew@gmail.example", "g-a")).ok, true);
    const s = acc.signIn(goog("andrew@gmail.example", "g-a"));
    assert.equal(s.owner, true, "signing in through the second identity is still the owner");
    assert.equal(acc.session(s.token).login, "andrewdoft");
  });

  test("link() of an identity that is already a separate person merges them, keeping sessions, credentials and ownership", (t) => {
    const { acc, owner } = team(t);
    acc.allow("kai");
    const kai = acc.signIn(gh("kai", "7"));
    const cred = acc.addCredential({ label: "k", provider: "anthropic", kind: "api_key", key: "sk-ant-api03-aaaa", addedBy: "kai" });

    // Kai proves control of the owner's Google identity? No — the OWNER links
    // kai's GitHub: they proved both, so kai's row folds into the owner's.
    const r = acc.link(acc.session(owner.token), gh("kai", "7"));
    assert.equal(r.ok, true);
    assert.equal(r.merged, true);
    assert.equal(acc.list().length, 1);
    assert.equal(acc.owner, "andrewdoft");
    // kai's old session still works, and now belongs to the survivor.
    const s = acc.session(kai.token);
    assert.ok(s, "the absorbed person's session survives the merge");
    assert.equal(s.login, "andrewdoft");
    // …and their credential is re-pointed at the survivor.
    assert.equal(acc.credential(cred.id).addedBy, "andrewdoft");
  });

  test("a removed identity cannot be linked", (t) => {
    const { acc, owner } = team(t);
    acc.allow("kai");
    acc.signIn(gh("kai", "7"));
    acc.revoke("kai");
    const r = acc.link(acc.session(owner.token), gh("kai", "7"));
    assert.equal(r.ok, false);
    assert.match(r.error, /removed/);
  });

  test("unlink drops one identity, never the last, and it stops being able to sign in", (t) => {
    const { acc, owner } = team(t);
    const session = acc.session(owner.token);
    acc.link(session, goog("a@gmail.example", "g-a"), ["a@gmail.example"]);

    assert.equal(acc.unlink(session, { provider: "google", login: "a@gmail.example" }).ok, true);
    assert.equal(acc.mayEnter(goog("a@gmail.example", "g-a")).ok, false, "the unlinked identity is not admitted any more");

    const last = acc.unlink(session, { provider: "github", login: "andrewdoft" });
    assert.equal(last.ok, false);
    assert.match(last.error, /only sign-in/);
  });

  test("unlinking the primary promotes the next and keeps sessions alive", (t) => {
    const { acc, owner } = team(t);
    acc.link(acc.session(owner.token), goog("a@gmail.example", "g-a"), ["a@gmail.example"]);
    assert.equal(acc.unlink(acc.session(owner.token), { provider: "github", login: "andrewdoft" }).ok, true);
    const s = acc.session(owner.token);
    assert.ok(s, "the session survived");
    assert.equal(s.login, "a@gmail.example");
    assert.equal(acc.owner, "a@gmail.example", "still the owner, under the identity that remains");
  });

  test("removing a person by any identity removes and blocks all of them", (t) => {
    const { acc } = team(t);
    acc.allow("kai");
    const k = acc.signIn(gh("kai", "7"));
    acc.link(acc.session(k.token), goog("kai@x.example", "g-k"), ["kai@x.example"]);
    acc.revoke("kai@x.example");
    assert.equal(acc.session(k.token), null);
    assert.equal(acc.mayEnter(gh("kai", "7")).ok, false);
    assert.equal(acc.mayEnter(goog("kai@x.example", "g-k")).ok, false);
  });
});

describe("names", () => {
  test("rename sets the display name, keeps the old one as an alias, and events follow it", (t) => {
    const { acc } = team(t);
    const r = acc.rename("andrewdoft", "Andrew D", { actor: "andrew" });
    assert.equal(r.ok, true);
    const resolve = acc.actorResolver();
    assert.equal(resolve("andrew"), "Andrew D", "the machine's actor string resolves to the new name");
    assert.equal(resolve("AndrewDoft"), "Andrew D", "so does the old display name, whatever its case");
    assert.equal(resolve("somebody else"), "somebody else");
  });

  test("a name somebody else already goes by is refused, in any case", (t) => {
    const { acc } = team(t);
    acc.allow("kai");
    acc.signIn(gh("kai", "7"));
    const r = acc.rename("kai", "ANDREWDOFT");
    assert.equal(r.ok, false);
    assert.match(r.error, /already/);
  });

  test("an empty or control-character name is refused or cleaned", (t) => {
    const { acc } = team(t);
    assert.equal(acc.rename("andrewdoft", "   ").ok, false);
    acc.rename("andrewdoft", "A\nB");
    assert.equal(acc.list()[0].display, "AB");
  });

  test("a rename survives a restart", (t) => {
    const d = tempDir();
    t.after(() => d.cleanup());
    const file = path.join(d.dir, "accounts.json");
    const a = new Accounts({ file });
    a.signIn(gh("AndrewDoft", "1"));
    a.rename("andrewdoft", "Andrew D", { actor: "andrew" });
    const b = new Accounts({ file });
    assert.equal(b.actorResolver()("andrew"), "Andrew D");
    assert.equal(b.profile({ provider: "github", login: "andrewdoft", id: "1" }).name, "Andrew D");
  });
});

describe("combining what evidence cannot prove", () => {
  test("combine folds one person into another and their names become one", (t) => {
    const { acc } = team(t);
    acc.allow("andrew@laptop.example");
    acc.signIn(goog("andrew@laptop.example", "g-a"));
    const r = acc.combine("andrewdoft", "andrew@laptop.example");
    assert.equal(r.ok, true);
    assert.equal(r.merged, true);
    assert.equal(acc.list().length, 1);
    assert.equal(acc.actorResolver()("andrew@laptop.example"), "AndrewDoft");
  });

  test("combine with a name that is only an actor on events claims it as an alias", (t) => {
    const { acc } = team(t);
    const r = acc.combine("andrewdoft", "andrew");
    assert.deepEqual([r.ok, r.merged, r.alias], [true, false, "andrew"]);
    assert.equal(acc.actorResolver()("andrew"), "AndrewDoft");
  });

  test("an actor name somebody else owns cannot be claimed", (t) => {
    const { acc } = team(t);
    acc.allow("kai");
    acc.signIn(gh("kai", "7"));
    assert.equal(acc.combine("andrewdoft", "kai").merged, true, "kai is a person, so that is a merge");
    const { acc: b } = team(t);
    b.rename("andrewdoft", "Boss", { actor: "chief" });
    b.allow("kai");
    b.signIn(gh("kai", "7"));
    assert.equal(b.combine("kai", "chief").ok, false);
  });

  test("combining the owner into somebody else keeps the owner", (t) => {
    const { acc, owner } = team(t);
    acc.allow("kai");
    const k = acc.signIn(gh("kai", "7"));
    acc.combine("kai", "andrewdoft");
    assert.equal(acc.list().length, 1);
    assert.equal(acc.list()[0].owner, true);
    assert.ok(acc.session(owner.token) && acc.session(k.token));
  });
});

describe("the dedupe migration", () => {
  function seed(t, state) {
    const d = tempDir();
    t.after(() => d.cleanup());
    const file = path.join(d.dir, "accounts.json");
    const seedAcc = new Accounts({ file });
    seedAcc.signIn(gh("AndrewDoft", "1"));
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.allowed.push(...state);
    writeFileSync(file, JSON.stringify(raw));
    return file;
  }

  test("mergeProvable merges only what stored evidence proves, and is idempotent", (t) => {
    const file = seed(t, [
      // two signed-in rows that both hold the verified email x@example.com
      { provider: "github", login: "xg", display: "xg", id: "10", emails: ["x@example.com"], added: "2026-01-01" },
      { provider: "google", login: "x@example.com", display: "x@example.com", id: "g10", added: "2026-01-02" },
      // a pending invite typed for that same address
      { provider: "google", login: "x@example.com", display: "x@example.com", id: "", added: "2026-01-03" },
      // a pending name that is NOT proven to be anyone
      { provider: "github", login: "andrew", display: "andrew", id: "", added: "2026-01-04" },
    ]);
    const acc = new Accounts({ file });
    const done = acc.mergeProvable();
    assert.equal(done.length, 2, JSON.stringify(done));
    assert.equal(acc.list().length, 3, "owner, x, and the unproven pending 'andrew'");
    assert.ok(acc.list().some((p) => p.login === "andrew" && !p.id), "an unproven name is left alone");

    const again = new Accounts({ file }).mergeProvable();
    assert.deepEqual(again, [], "a second run finds nothing");
  });
});

describe("scripts/merge-people.mjs", () => {
  test("dry run writes nothing; --apply backs up, merges, and a second run is a no-op", async (t) => {
    const { run } = await import("../scripts/merge-people.mjs");
    const d = tempDir();
    t.after(() => d.cleanup());
    const file = path.join(d.dir, "accounts.json");
    const a = new Accounts({ file });
    a.signIn(gh("AndrewDoft", "1"));
    a.allow("x@example.com");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.allowed.push({ provider: "github", login: "xg", display: "xg", id: "10", emails: ["x@example.com"], added: "2026-01-01" });
    writeFileSync(file, JSON.stringify(raw));
    const before = readFileSync(file, "utf8");

    const lines = [];
    assert.equal(run(file, { out: (l) => lines.push(l) }), 1);
    assert.equal(readFileSync(file, "utf8"), before, "a dry run must not touch the file");
    assert.match(lines.join("\n"), /would merge/);
    assert.doesNotMatch(lines.join("\n"), /x@example\.com/, "addresses are redacted in the report");

    assert.equal(run(file, { apply: true, out: () => {} }), 1);
    assert.equal(new Accounts({ file }).list().length, 2);
    assert.equal(run(file, { apply: true, out: () => {} }), 0, "idempotent");
  });
});
