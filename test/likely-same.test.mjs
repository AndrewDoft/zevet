// likelySame — pure suggestions for people the board thinks might be one human.
//
// It runs in plain node (no hub, no DOM): board/src/lib/identity.mjs is imported
// straight, like identity-link.test.mjs does. Only the three match rules are
// exercised, plus the ordering that decides which side to combine INTO.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { likelySame } from "../board/src/lib/identity.mjs";

const p = (login, identities = []) => ({ login, identities });
// likelySame returns an array of [from, into] pairs; one match → pairs[0].
const only = (people) => likelySame(people)[0];

describe("name match", () => {
  test("equal names after stripping a leading @", () => {
    assert.equal(likelySame([p("@AndrewDoft"), p("AndrewDoft")]).length, 1);
  });

  test("case-insensitive equality", () => {
    assert.equal(likelySame([p("andrew"), p("ANDREW")]).length, 1);
  });

  test("different names do not match", () => {
    assert.equal(likelySame([p("andrew"), p("kai")]).length, 0);
  });
});

describe("prefix match", () => {
  test("a name that is a prefix of another (len >= 4) matches", () => {
    const pair = only([p("AndrewDoft"), p("andrew")]);
    assert.ok(pair, "expected one pair");
    assert.deepEqual(pair.map((x) => x.login), ["andrew", "AndrewDoft"]);
  });

  test("the match is case-insensitive", () => {
    assert.equal(likelySame([p("AndrewDoft"), p("ANDREW")]).length, 1);
  });

  test("a short prefix (len < 4) does NOT match", () => {
    assert.equal(likelySame([p("alice"), p("al")]).length, 0, "al is too short to be a prefix");
    assert.equal(likelySame([p("bob"), p("bo")]).length, 0, "bo is too short");
  });

  test("a 4-char prefix matches", () => {
    assert.equal(likelySame([p("alex"), p("alexander")]).length, 1);
  });
});

describe("shared email", () => {
  test("two people sharing a Google identity's email match", () => {
    assert.equal(
      likelySame([
        p("AndrewDoft", [{ provider: "google", login: "andrew@example.com" }]),
        p("andrewd", [{ provider: "google", login: "andrew@example.com" }]),
      ]).length,
      1,
    );
  });

  test("no shared email does not match by that rule alone", () => {
    assert.equal(
      likelySame([
        p("AndrewDoft", [{ provider: "google", login: "andrew@example.com" }]),
        p("Kai K", [{ provider: "google", login: "kai@example.com" }]),
      ]).length,
      0,
    );
  });

  test("a GitHub login is not treated as an email", () => {
    assert.equal(
      likelySame([p("AndrewDoft", [{ provider: "github", login: "octo" }]), p("octocat")]).length,
      0,
    );
  });
});

describe("ordering: which side to combine into", () => {
  test("into the one with a linked account", () => {
    const pair = only([
      p("AndrewDoft", [{ provider: "github", login: "andrewdoft" }]),
      p("andrew"),
    ]);
    assert.deepEqual(pair.map((x) => x.login), ["andrew", "AndrewDoft"]);
  });

  test("with no linked account on either side, into the longer name", () => {
    const pair = only([p("alice"), p("alice smith")]);
    assert.deepEqual(pair.map((x) => x.login), ["alice", "alice smith"]);
  });
});

describe("negatives / false-positive guards", () => {
  test("unrelated names do not match", () => {
    assert.equal(likelySame([p("alice"), p("bob"), p("carol")]).length, 0);
  });

  test("a shared substring that is not a prefix does not match by prefix", () => {
    assert.equal(likelySame([p("andrew"), p("handy")]).length, 0);
  });

  test("empty or missing logins are ignored", () => {
    assert.equal(likelySame([p(""), p(undefined), p("andrew"), p("AndrewDoft")]).length, 1);
  });

  test("a single person yields no pairs", () => {
    assert.equal(likelySame([p("andrew")]).length, 0);
  });

  test("undefined input does not throw", () => {
    assert.deepEqual(likelySame(undefined), []);
  });
});

describe("each pair once", () => {
  test("two matching names produce exactly one pair", () => {
    assert.equal(likelySame([p("andrew"), p("AndrewDoft"), p("kai")]).length, 1);
  });

  test("three mutual prefixes do not duplicate a pair", () => {
    const r = likelySame([p("drew"), p("drewf"), p("drewford")]);
    assert.equal(r.length, 3, "three distinct pairs");
    const sigs = r.map((pair) => pair.map((x) => x.login).sort().join("|"));
    assert.deepEqual([...new Set(sigs)].length, sigs.length, "all pairs are unique");
  });
});

describe("the owner sees each suggested pair as one Combine row", () => {
  const src = readFileSync(new URL("../board/src/components/identity.tsx", import.meta.url), "utf8");
  test("suggestions are the owner's only, from likelySame over people and board names", () => {
    assert.match(src, /const suggested = owner\s*\?\s*likelySame\(candidates\)/);
    assert.match(src, /\.\.\.roster\.map\(\(r\) => r\.actor\)/);
  });
  test("a row combines that pair, and dismissing it is remembered", () => {
    assert.match(src, /onClick=\{\(\) => combine\(sg\)\}/);
    assert.match(src, /writeDismissed\(next\)/);
    assert.match(src, /\.filter\(\(s\) => !dismissed\.includes\(`\$\{s\.from\}>\$\{s\.into\}`\)\)/);
  });
});
