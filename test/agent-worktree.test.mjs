// A second agent in one repo gets a worktree of its own (desktop/agent-worktree.js),
// against a real git repo: nothing here is worth trusting to a fake git.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { tempDir, ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { createAgentWorktrees } = require(path.join(ROOT, "desktop", "agent-worktree.js"));
const { integrateAgent } = require(path.join(ROOT, "desktop", "agent-integration.js"));

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
const ID = ["-c", "user.email=t@t", "-c", "user.name=t"];

describe("agent worktrees", () => {
  let repo, home, wts;
  beforeEach(() => {
    repo = tempDir("zevet-wt-repo-");
    home = tempDir("zevet-wt-home-");
    git(repo.dir, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo.dir, ".gitignore"), "node_modules\n.venv\n");
    writeFileSync(path.join(repo.dir, "app.js"), "export const a = 1;\n");
    mkdirSync(path.join(repo.dir, "web", "node_modules", "dep"), { recursive: true });
    writeFileSync(path.join(repo.dir, "web", "index.js"), "\n");
    mkdirSync(path.join(repo.dir, "node_modules", "dep"), { recursive: true });
    writeFileSync(path.join(repo.dir, "node_modules", "dep", "index.js"), "keep me\n");
    git(repo.dir, "add", "-A");
    git(repo.dir, ...ID, "commit", "-qm", "init");
    wts = createAgentWorktrees({ home: home.dir });
  });
  afterEach(() => {
    repo.cleanup();
    home.cleanup();
  });

  test("makes a worktree on its own branch, outside the repo, with dependencies linked", async () => {
    const wt = await wts.create(repo.dir);
    assert.ok(wt);
    assert.match(wt.branch, /^zevet\/[a-f0-9]{6}$/);
    assert.equal(path.dirname(wt.dir), path.join(home.dir, "worktrees"));
    assert.equal(wt.cwd, wt.dir);
    assert.equal(git(wt.dir, "rev-parse", "--abbrev-ref", "HEAD"), wt.branch);
    assert.equal(git(wt.dir, "rev-parse", "HEAD"), git(repo.dir, "rev-parse", "HEAD"));
    for (const rel of ["node_modules", path.join("web", "node_modules")]) {
      assert.ok(lstatSync(path.join(wt.dir, rel)).isSymbolicLink(), `${rel} is linked`);
    }
    assert.ok(existsSync(path.join(wt.dir, "node_modules", "dep", "index.js")));
    assert.equal(git(wt.dir, "status", "--porcelain"), "", "the links are ignored");
    // The user's checkout is exactly where it was.
    assert.equal(git(repo.dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.equal(await wts.release(wt, "x"), true);
  });

  test("starts in the same subfolder the workspace is", async () => {
    const wt = await wts.create(path.join(repo.dir, "web"));
    assert.equal(wt.cwd, path.join(wt.dir, "web"));
    await wts.release(wt);
  });

  test("an untouched worktree goes entirely, and never through its links", async () => {
    const wt = await wts.create(repo.dir);
    assert.equal(await wts.release(wt, "Tidy up"), true);
    assert.ok(!existsSync(wt.dir));
    assert.equal(git(repo.dir, "branch", "--list", "zevet/*"), "");
    assert.ok(existsSync(path.join(repo.dir, "node_modules", "dep", "index.js")), "the repo's dependencies survive");
    assert.ok(existsSync(path.join(repo.dir, "web", "node_modules", "dep")));
    assert.deepEqual(readdirSync(path.join(home.dir, "worktrees")), []);
  });

  test("uncommitted work is committed to its branch, which is kept", async () => {
    const wt = await wts.create(repo.dir);
    writeFileSync(path.join(wt.dir, "app.js"), "export const a = 2;\n");
    writeFileSync(path.join(wt.dir, "new.js"), "new\n");
    assert.equal(await wts.release(wt, "Fix the counter"), true);
    assert.ok(!existsSync(wt.dir));
    assert.equal(git(repo.dir, "log", "-1", "--format=%s", wt.branch), "Fix the counter");
    assert.equal(git(repo.dir, "show", `${wt.branch}:new.js`), "new");
    assert.equal(git(repo.dir, "show", `${wt.branch}:app.js`), "export const a = 2;");
    assert.ok(existsSync(path.join(repo.dir, "node_modules", "dep", "index.js")));
    // Untouched: the user's own checkout and branch.
    assert.equal(git(repo.dir, "status", "--porcelain"), "");
    assert.equal(git(repo.dir, "show", "main:app.js"), "export const a = 1;");
  });

  test("commits the agent made itself keep the branch too", async () => {
    const wt = await wts.create(repo.dir);
    writeFileSync(path.join(wt.dir, "app.js"), "export const a = 3;\n");
    git(wt.dir, ...ID, "commit", "-qam", "agent commit");
    await wts.release(wt);
    assert.equal(git(repo.dir, "log", "-1", "--format=%s", wt.branch), "agent commit");
  });

  test("prune releases whatever is left from a previous run", async () => {
    const clean = await wts.create(repo.dir);
    const dirty = await wts.create(repo.dir);
    writeFileSync(path.join(dirty.dir, "wip.txt"), "wip\n");
    await createAgentWorktrees({ home: home.dir }).prune();
    assert.ok(!existsSync(clean.dir) && !existsSync(dirty.dir));
    assert.equal(git(repo.dir, "branch", "--list", "zevet/*", "--format=%(refname:short)"), dirty.branch);
  });

  test("prune keeps the worktrees of consoles a payload swap restored", async () => {
    const kept = await wts.create(repo.dir);
    const gone = await wts.create(repo.dir);
    await createAgentWorktrees({ home: home.dir }).prune(new Set([path.resolve(kept.dir)]));
    assert.ok(existsSync(kept.dir), "a restored console's worktree was pruned from under it");
    assert.ok(!existsSync(gone.dir));
    await wts.release(kept);
  });

  test("anything it did not make is refused", async () => {
    assert.equal(await wts.release({ dir: repo.dir, branch: "main", base: "HEAD", repo: repo.dir }), false);
    assert.equal(await wts.release({ dir: path.join(home.dir, "worktrees", "x"), branch: "main", repo: repo.dir }), false);
    assert.ok(existsSync(path.join(repo.dir, "app.js")));
  });

  test("falls back to null: no repo, no commit, or git failing", async () => {
    const plain = tempDir("zevet-wt-plain-");
    const empty = tempDir("zevet-wt-empty-");
    try {
      git(empty.dir, "init", "-q");
      assert.equal(await wts.create(plain.dir), null);
      assert.equal(await wts.create(empty.dir), null);
      const broken = createAgentWorktrees({ home: home.dir, git: async () => { throw new Error("no git"); } });
      assert.equal(await broken.create(repo.dir), null);
    } finally {
      plain.cleanup();
      empty.cleanup();
    }
  });
});

describe("agent integration", () => {
  test("integrates once only, and refuses a red run", async () => {
    const calls = [];
    const wt = { dir: path.join(tempDir("zevet-int-").dir, "child"), repo: "repo", branch: "zevet/x" };
    const git = async (args) => { calls.push(args); return "main\n"; };
    const red = await integrateAgent({ worktree: wt, runId: "r1", git, checks: async () => ({ green: false, why: "2 failed" }) });
    assert.deepEqual(red, { status: "failed", why: "2 failed" });
    assert.equal(calls.length, 0);
  });

  test("a green run merges exactly once and a retry is a no-op", async () => {
    const dir = tempDir("zevet-int-");
    const wt = { dir: path.join(dir.dir, "child"), repo: "repo", branch: "zevet/x" };
    const calls = [];
    const git = async (args) => { calls.push(args); return "main\n"; };
    const checks = async () => ({ green: true });
    const one = await integrateAgent({ worktree: wt, runId: "r2", git, checks });
    const two = await integrateAgent({ worktree: wt, runId: "r2", git, checks: async () => { throw new Error("must not rerun"); } });
    assert.equal(one.status, "integrated");
    assert.deepEqual(two, one);
    assert.equal(calls.filter((a) => a[2] === "merge").length, 1);
    dir.cleanup();
  });
});
