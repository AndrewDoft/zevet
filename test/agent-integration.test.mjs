// Integrating a subagent's worktree branch (desktop/agent-integration.js), against
// real git repos: the user's checkout is only ever merged into when it is safe,
// and is never left half-merged. Nothing here is worth trusting to a fake git.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { tempDir, ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { createAgentWorktrees } = require(path.join(ROOT, "desktop", "agent-worktree.js"));
const { integrateAgent, runAgentChecks, declaredChecks, killChecks } = require(path.join(ROOT, "desktop", "agent-integration.js"));

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
const ID = ["-c", "user.email=t@t", "-c", "user.name=t"];
const gitRun = (args) => new Promise((res, rej) => execFile("git", args, { windowsHide: true }, (e, o) => (e ? rej(e) : res(String(o)))));
const green = async () => ({ green: true });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (f, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

describe("agent integration", () => {
  let repo, home, wts, wt, n;
  const run = (over = {}) => integrateAgent({ worktree: wt, runId: `r${++n}`, git: gitRun, checks: green, markerDir: path.join(home.dir, "integrations"), ...over });
  const merges = () => Number(git(repo.dir, "rev-list", "--count", "--merges", "HEAD"));
  const commitInWt = (file, text) => { writeFileSync(path.join(wt.dir, file), text); git(wt.dir, "add", "-A"); git(wt.dir, ...ID, "commit", "-qm", "agent"); };
  const state = () => ({ head: git(repo.dir, "rev-parse", "HEAD"), status: git(repo.dir, "status", "--porcelain") });

  beforeEach(async () => {
    n = 0;
    repo = tempDir("zevet-int-repo-");
    home = tempDir("zevet-int-home-");
    git(repo.dir, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo.dir, "a.txt"), "one\n");
    git(repo.dir, "add", "-A");
    git(repo.dir, ...ID, "commit", "-qm", "init");
    wts = createAgentWorktrees({ home: home.dir });
    wt = await wts.create(repo.dir);
    commitInWt("agent.txt", "agent work\n");
  });
  afterEach(() => { repo.cleanup(); home.cleanup(); });

  test("a green run merges into the branch it was cut from, exactly once", async () => {
    assert.equal(wt.parentBranch, "main");
    let ran = 0;
    const checks = async () => { ran++; return { green: true }; };
    const [one, two] = await Promise.all([run({ runId: "same", checks }), run({ runId: "same", checks })]);
    const three = await run({ runId: "same", checks });
    assert.equal(one.status, "integrated");
    assert.deepEqual(two, one);
    assert.deepEqual(three, one);
    assert.equal(ran, 1, "checks ran once");
    assert.equal(merges(), 1);
    assert.ok(existsSync(path.join(repo.dir, "agent.txt")));
    // Even a manual click after it integrated is a no-op.
    assert.equal((await run({ runId: "same", manual: true })).status, "integrated");
    assert.equal(merges(), 1);
  });

  test("a dirty parent is left byte-identical and nothing merges", async () => {
    writeFileSync(path.join(repo.dir, "a.txt"), "one\nmine, unsaved\n");
    writeFileSync(path.join(repo.dir, "new.txt"), "untracked\n");
    const before = { ...state(), a: readFileSync(path.join(repo.dir, "a.txt"), "utf8"), n: readFileSync(path.join(repo.dir, "new.txt"), "utf8") };
    const r = await run();
    assert.equal(r.status, "waiting");
    assert.match(r.why, /uncommitted/);
    assert.deepEqual({ ...state(), a: readFileSync(path.join(repo.dir, "a.txt"), "utf8"), n: readFileSync(path.join(repo.dir, "new.txt"), "utf8") }, before);
    assert.equal(merges(), 0);
    // Retried on click once the user has committed; the automatic trigger does not retry.
    git(repo.dir, "add", "-A");
    git(repo.dir, ...ID, "commit", "-qm", "mine");
    assert.equal((await run({ runId: "r1" })).status, "waiting");
    assert.equal((await run({ runId: "r1", manual: true })).status, "integrated");
  });

  test("a merge or rebase in progress is not merged into", async () => {
    const gitDir = path.join(repo.dir, ".git");
    mkdirSync(path.join(gitDir, "rebase-merge"));
    const r = await run();
    assert.equal(r.status, "waiting");
    assert.match(r.why, /mid-merge or rebase/);
    assert.equal(merges(), 0);
  });

  test("a conflict is aborted to a clean tree, with the files named", async () => {
    commitInWt("a.txt", "agent edit\n");
    writeFileSync(path.join(repo.dir, "a.txt"), "parent edit\n");
    git(repo.dir, "add", "-A");
    git(repo.dir, ...ID, "commit", "-qm", "parent moves on");
    const before = state();
    const r = await run();
    assert.equal(r.status, "failed");
    assert.equal(r.why, "conflicts in 1 file");
    assert.deepEqual(r.files, ["a.txt"]);
    assert.deepEqual(state(), before);
    assert.equal(before.status, "");
    assert.equal(existsSync(path.join(repo.dir, ".git", "MERGE_HEAD")), false);
    assert.equal(readFileSync(path.join(repo.dir, "a.txt"), "utf8").replace(/\r/g, ""), "parent edit\n");
  });

  test("a parent that moved to another branch is not merged into", async () => {
    git(repo.dir, "checkout", "-q", "-b", "other");
    const r = await run();
    assert.equal(r.status, "waiting");
    assert.equal(r.why, "parent moved to other");
    assert.equal(merges(), 0);
    assert.equal(existsSync(path.join(repo.dir, "agent.txt")), false);
  });

  test("a parent that moves while the checks run is still caught", async () => {
    const r = await run({ checks: async () => { git(repo.dir, "checkout", "-q", "-b", "other"); return { green: true }; } });
    assert.equal(r.status, "waiting");
    assert.equal(existsSync(path.join(repo.dir, "agent.txt")), false);
  });

  test("red checks never merge", async () => {
    const r = await run({ checks: async () => ({ green: false, why: "npm test failed" }) });
    assert.deepEqual(r, { status: "failed", why: "npm test failed" });
    assert.equal(merges(), 0);
  });

  test("a repo that declares no checks never merges by itself; the button does", async () => {
    let called = 0;
    const checks = async () => { called++; return null; };
    const auto = await run({ runId: "nc", checks });
    assert.deepEqual(auto, { status: "no checks" });
    assert.equal(merges(), 0);
    const clicked = await run({ runId: "nc", checks, manual: true });
    assert.equal(clicked.status, "integrated");
    assert.equal(merges(), 1);
    assert.equal(called, 2);
  });

  test("work the agent left uncommitted rides along", async () => {
    writeFileSync(path.join(wt.dir, "late.txt"), "late\n");
    assert.equal((await run()).status, "integrated");
    assert.ok(existsSync(path.join(repo.dir, "late.txt")));
  });

  test("a worktree made without a recorded parent branch is not merged", async () => {
    const r = await run({ worktree: { ...wt, parentBranch: "" } });
    assert.equal(r.status, "waiting");
    assert.equal(merges(), 0);
  });

  test("discard removes the worktree and its branch", async () => {
    assert.equal(await wts.discard(wt), true);
    assert.equal(existsSync(wt.dir), false);
    assert.equal(git(repo.dir, "branch", "--list", wt.branch), "");
  });
});

describe("declared checks", () => {
  let d;
  beforeEach(() => { d = tempDir("zevet-checks-"); });
  afterEach(() => d.cleanup());
  const pkg = (o) => writeFileSync(path.join(d.dir, "package.json"), JSON.stringify(o));

  test("nothing declared, nothing assumed", () => {
    assert.equal(declaredChecks(d.dir), null);
    pkg({ scripts: { build: "x" } });
    assert.equal(declaredChecks(d.dir), null);
    pkg({ scripts: { test: 'echo "Error: no test specified" && exit 1' } });
    assert.equal(declaredChecks(d.dir), null);
  });

  test("test, plus typecheck only when the script exists", () => {
    pkg({ scripts: { test: "node t.js" } });
    assert.deepEqual(declaredChecks(d.dir), ["npm test"]);
    pkg({ scripts: { test: "node t.js", typecheck: "tsc" } });
    assert.deepEqual(declaredChecks(d.dir), ["npm test", "npm run typecheck"]);
  });

  test("zevet.checks wins, from .zevet/config first", () => {
    pkg({ scripts: { test: "node t.js" }, zevet: { checks: "make ci" } });
    assert.deepEqual(declaredChecks(d.dir), ["make ci"]);
    mkdirSync(path.join(d.dir, ".zevet"));
    writeFileSync(path.join(d.dir, ".zevet", "config"), JSON.stringify({ checks: ["a", "b"] }));
    assert.deepEqual(declaredChecks(d.dir), ["a", "b"]);
  });
});

describe("running checks", () => {
  let d;
  beforeEach(() => { d = tempDir("zevet-run-"); });
  afterEach(() => d.cleanup());
  // A check that starts a grandchild, records its pid, and then sits there.
  const hang = () => {
    writeFileSync(path.join(d.dir, "grandchild.js"), "setInterval(() => {}, 1000);\n");
    writeFileSync(path.join(d.dir, "hang.js"), `const c = require("node:child_process").spawn(process.execPath, ["grandchild.js"], { stdio: "ignore" });\nrequire("node:fs").writeFileSync("pid", String(c.pid));\nsetInterval(() => {}, 1000);\n`);
    writeFileSync(path.join(d.dir, "package.json"), JSON.stringify({ zevet: { checks: "node hang.js" } }));
  };
  const pidOf = () => Number(readFileSync(path.join(d.dir, "pid"), "utf8"));

  test("a check that passes is green, one that fails is not", async () => {
    writeFileSync(path.join(d.dir, "package.json"), JSON.stringify({ zevet: { checks: "node -e \"process.exit(0)\"" } }));
    assert.deepEqual(await runAgentChecks({ repo: d.dir, dir: d.dir }), { green: true });
    writeFileSync(path.join(d.dir, "package.json"), JSON.stringify({ zevet: { checks: "node -e \"process.exit(3)\"" } }));
    assert.equal((await runAgentChecks({ repo: d.dir, dir: d.dir })).green, false);
  });

  test("a timeout kills the whole process tree", async () => {
    hang();
    const r = await runAgentChecks({ repo: d.dir, dir: d.dir }, { timeoutMs: 1500 });
    assert.equal(r.green, false);
    assert.match(r.why, /timed out/);
    assert.ok(await until(() => existsSync(path.join(d.dir, "pid"))));
    assert.ok(await until(() => !alive(pidOf())), "grandchild is gone");
  });

  test("quitting the app kills what is running", async () => {
    hang();
    const p = runAgentChecks({ repo: d.dir, dir: d.dir }, { timeoutMs: 60000 });
    assert.ok(await until(() => existsSync(path.join(d.dir, "pid"))));
    const pid = pidOf();
    assert.ok(alive(pid));
    killChecks();
    assert.equal((await p).green, false);
    assert.ok(await until(() => !alive(pid)), "grandchild is gone");
  });
});
