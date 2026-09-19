// Line counts and git diff badges for the file tree.
//
// The git half runs against REAL repositories built in a temp directory, not
// against captured `git diff` output. Parsing is the easy part; what breaks is
// the shape git chooses — renames arrive in two different spellings, untracked
// files are absent from `diff` entirely, and a repo with no commits has no HEAD
// to diff against. None of those are visible in a fixture somebody pasted.
//
// ⚠️ SKIPPED RATHER THAN FAKED when git is not installed. A suite that quietly
// passes because the thing under test never ran is worse than a red one.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { diffStats, LineCounter, countLines, renamedTo } = require(
  path.join(ROOT, "desktop", "repo-stats.js"),
);

let HAVE_GIT = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true });
} catch {
  HAVE_GIT = false;
}

let dir;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "zevet-stats-"));
});
after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows will refuse while git's index lock is briefly held. Temp.
  }
});

/** A repo with an identity of its own, so a machine with no global git config
 *  (every CI runner) can still commit. */
function makeRepo(name) {
  const repo = path.join(dir, name);
  mkdirSync(repo, { recursive: true });
  const g = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore", windowsHide: true });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "test@example.invalid");
  g("config", "user.name", "zevet test");
  g("config", "commit.gpgsign", "false");
  return { repo, g };
}

describe("counting lines", () => {
  test("a file with a trailing newline is not off by one", () => {
    // `split("\n").length` says 3 here. An editor says 2, and the badge sits
    // next to an editor.
    assert.equal(countLines(Buffer.from("a\nb\n")), 2);
    assert.equal(countLines(Buffer.from("a\nb")), 2);
  });

  test("an empty file has no lines, and one character has one", () => {
    assert.equal(countLines(Buffer.from("")), 0);
    assert.equal(countLines(Buffer.from("a")), 1);
    assert.equal(countLines(Buffer.from("\n")), 1);
  });

  test("CRLF counts the same as LF", () => {
    // The badge counts lines, not bytes; a Windows checkout must not read as
    // a different file from the same content on macOS.
    assert.equal(countLines(Buffer.from("a\r\nb\r\n")), 2);
  });
});

describe("the line counter", () => {
  test("counts a real file and caches on size and mtime", () => {
    const f = path.join(dir, "counted.txt");
    writeFileSync(f, "one\ntwo\nthree\n");
    const lc = new LineCounter();
    assert.equal(lc.count(dir, "counted.txt"), 3);
    assert.equal(lc.cache.size, 1);
    // Second call must not re-read. Proven by making the file unreadable in a
    // way a re-read would notice: change the content but keep size and mtime
    // impossible to fake portably -- so instead assert the cached value is
    // returned for an identical stat, which is the contract.
    assert.equal(lc.count(dir, "counted.txt"), 3);
    assert.equal(lc.cache.size, 1);
  });

  test("a changed file is recounted", () => {
    const f = path.join(dir, "changing.txt");
    writeFileSync(f, "one\n");
    const lc = new LineCounter();
    assert.equal(lc.count(dir, "changing.txt"), 1);
    writeFileSync(f, "one\ntwo\nthree\nfour\n");
    assert.equal(lc.count(dir, "changing.txt"), 4);
  });

  test("a binary file is not counted rather than counted wrongly", () => {
    // A PNG has newlines in it. Counting them produces a number and a lie.
    writeFileSync(path.join(dir, "bin.dat"), Buffer.from([0x89, 0x50, 0x00, 0x0a, 0x0a, 0x01]));
    assert.equal(new LineCounter().count(dir, "bin.dat"), null);
  });

  test("a missing file is null, not a throw", () => {
    assert.equal(new LineCounter().count(dir, "nope.txt"), null);
  });

  test("a directory is null", () => {
    mkdirSync(path.join(dir, "adir"), { recursive: true });
    assert.equal(new LineCounter().count(dir, "adir"), null);
  });

  test("countAll returns a plain object keyed by the paths given", () => {
    writeFileSync(path.join(dir, "a.txt"), "x\n");
    writeFileSync(path.join(dir, "b.txt"), "x\ny\n");
    const out = new LineCounter().countAll(dir, ["a.txt", "b.txt", "gone.txt"]);
    assert.deepEqual({ ...out }, { "a.txt": 1, "b.txt": 2, "gone.txt": null });
  });

  test("forget drops one root and keeps the rest", () => {
    const lc = new LineCounter();
    const other = path.join(dir, "other");
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, "c.txt"), "x\n");
    lc.count(dir, "a.txt");
    lc.count(other, "c.txt");
    lc.forget(other);
    assert.ok(lc.cache.size >= 1);
    for (const k of lc.cache.keys()) assert.ok(!k.startsWith(other + path.sep));
  });
});

describe("rename spellings", () => {
  // Both of git's forms, and the one that bites: an empty side in the braces
  // leaves a doubled slash that would match no row in the tree.
  test("the arrow form takes the new name", () => {
    assert.equal(renamedTo("old.ts => new.ts"), "new.ts");
  });
  test("the brace form takes the new name", () => {
    assert.equal(renamedTo("src/{old => new}/file.ts"), "src/new/file.ts");
  });
  test("an empty side does not leave a doubled slash", () => {
    assert.equal(renamedTo("src/{ => nested}/file.ts"), "src/nested/file.ts");
    assert.equal(renamedTo("src/{nested => }/file.ts"), "src/file.ts");
  });
  test("an ordinary path is returned unchanged", () => {
    assert.equal(renamedTo("src/db.ts"), "src/db.ts");
  });
});

describe("diff stats", { skip: HAVE_GIT ? false : "git is not installed" }, () => {
  test("a clean repo reports ok with nothing changed", async () => {
    const { repo, g } = makeRepo("clean");
    writeFileSync(path.join(repo, "a.txt"), "one\n");
    g("add", "-A");
    g("commit", "-qm", "first");
    const { byPath, ok } = await diffStats(repo);
    // ok + empty is a real answer -- "nothing changed" -- and must be
    // distinguishable from "git told us nothing", which is ok false.
    assert.equal(ok, true);
    assert.equal(byPath.size, 0);
  });

  test("a modified file reports added and removed", async () => {
    const { repo, g } = makeRepo("modified");
    writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
    g("add", "-A");
    g("commit", "-qm", "first");
    writeFileSync(path.join(repo, "a.txt"), "one\nTWO\nthree\nfour\n");
    const { byPath } = await diffStats(repo);
    assert.deepEqual(byPath.get("a.txt"), { added: 2, removed: 1, status: "modified" });
  });

  test("an untracked file is reported, not silently absent", async () => {
    // `git diff` does not mention it at all. A new file with no badge beside a
    // modified one reads as "unchanged", which is the opposite of true.
    const { repo, g } = makeRepo("untracked");
    writeFileSync(path.join(repo, "a.txt"), "one\n");
    g("add", "-A");
    g("commit", "-qm", "first");
    writeFileSync(path.join(repo, "new.txt"), "fresh\n");
    const { byPath } = await diffStats(repo);
    assert.equal(byPath.get("new.txt").status, "untracked");
  });

  test("a nested untracked file is listed, not just its directory", async () => {
    // Plain `git status --porcelain` prints `?? sub/` and stops. The tree has a
    // row per file, so the call has to ask for --untracked-files=all.
    const { repo, g } = makeRepo("untracked-dir");
    writeFileSync(path.join(repo, "a.txt"), "one\n");
    g("add", "-A");
    g("commit", "-qm", "first");
    mkdirSync(path.join(repo, "sub"), { recursive: true });
    writeFileSync(path.join(repo, "sub", "deep.txt"), "fresh\n");
    const { byPath } = await diffStats(repo);
    assert.equal(byPath.get("sub/deep.txt").status, "untracked");
  });

  test("paths come back forward-slashed, the way the tree spells them", async () => {
    const { repo, g } = makeRepo("slashes");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "db.ts"), "one\n");
    g("add", "-A");
    g("commit", "-qm", "first");
    writeFileSync(path.join(repo, "src", "db.ts"), "one\ntwo\n");
    const { byPath } = await diffStats(repo);
    assert.ok(byPath.has("src/db.ts"), [...byPath.keys()].join(", "));
  });

  test("a binary change is nulls, not +0 −0", async () => {
    const { repo, g } = makeRepo("binary");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    writeFileSync(path.join(repo, "x.png"), png);
    g("add", "-A");
    g("commit", "-qm", "first");
    writeFileSync(path.join(repo, "x.png"), Buffer.concat([png, Buffer.from([0x00, 0x02])]));
    const { byPath } = await diffStats(repo);
    const s = byPath.get("x.png");
    assert.equal(s.added, null);
    assert.equal(s.removed, null);
  });

  test("a repo with no commits diffs against the empty tree", async () => {
    // `git diff HEAD` errors here. Without the empty-tree fallback the panel
    // shows no badges at all on a brand-new repo, which is when a person is
    // most likely to be looking.
    const { repo, g } = makeRepo("no-commits");
    writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    g("add", "-A");
    const { byPath, ok } = await diffStats(repo);
    assert.equal(ok, true);
    assert.equal(byPath.get("a.txt").added, 2);
  });

  test("a directory that is not a repo fails to empty rather than throwing", async () => {
    const notRepo = path.join(dir, "not-a-repo");
    mkdirSync(notRepo, { recursive: true });
    const { byPath, ok } = await diffStats(notRepo);
    assert.equal(ok, false);
    assert.equal(byPath.size, 0);
  });

  test("a missing directory fails to empty", async () => {
    const { ok } = await diffStats(path.join(dir, "does-not-exist"));
    assert.equal(ok, false);
  });

  test("no root at all fails to empty", async () => {
    assert.equal((await diffStats(null)).ok, false);
    assert.equal((await diffStats("")).ok, false);
  });
});
