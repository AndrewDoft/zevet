"use strict";

/**
 * Bringing a subagent's worktree branch back into the checkout it was cut
 * from, without ever putting that checkout at risk.
 *
 * The parent checkout is the user's own working tree. So: it is never touched
 * while it has uncommitted changes or a merge/rebase/cherry-pick in progress,
 * never when the user moved it to another branch, and a merge that fails is
 * aborted and verified clean before anything is reported. Checks are the
 * repo's own declared ones; a repo that declares none is never merged
 * automatically. Each run integrates at most once.
 *
 * Outcomes: integrated | waiting (why) | failed (why) | no checks.
 * No Electron in here; `git` and `checks` are injected.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");

const CHECK_TIMEOUT_MS = 15 * 60 * 1000;
const NO_TEST = /no test specified/i; // `npm init`'s placeholder

/** The commands a repo declares as its own gate, or null. Read from the
 *  parent checkout, never the agent's branch: an agent must not be able to
 *  rewrite the gate its work is held to. */
function declaredChecks(repo) {
  const json = (...p) => {
    try { return JSON.parse(fs.readFileSync(path.join(repo, ...p), "utf8")); } catch { return null; }
  };
  const list = (v) => (Array.isArray(v) ? v : [v]).filter((c) => typeof c === "string" && c.trim());
  const cfg = json(".zevet", "config");
  const pkg = json("package.json");
  for (const declared of [cfg && (cfg.checks ?? cfg.zevet?.checks), pkg && pkg.zevet?.checks]) {
    const cmds = list(declared);
    if (cmds.length) return cmds;
  }
  const scripts = (pkg && pkg.scripts) || {};
  if (typeof scripts.test !== "string" || NO_TEST.test(scripts.test)) return null;
  return ["npm test", ...(typeof scripts.typecheck === "string" ? ["npm run typecheck"] : [])];
}

const live = new Set();

/** The process and everything it started. */
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
}

/** App quit: nothing a check started outlives it. */
function killChecks() {
  for (const child of live) killTree(child);
}

function runOne(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let tail = "";
    let timedOut = false;
    const child = spawn(cmd, { cwd, shell: true, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    live.add(child);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const keep = (b) => { tail = (tail + b).slice(-16384); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const done = (code) => { clearTimeout(timer); live.delete(child); resolve({ code, tail, timedOut }); };
    child.on("error", () => done(1));
    child.on("close", (code) => done(code));
  });
}

/** Run the repo's declared checks in `wt.dir`. Null when it declares none. */
async function runAgentChecks(wt, { timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const cmds = declaredChecks(wt.repo);
  if (!cmds) return null;
  for (const cmd of cmds) {
    const r = await runOne(cmd, wt.dir, timeoutMs);
    if (r.timedOut) return { green: false, why: `${cmd} timed out` };
    if (r.code !== 0) return { green: false, why: `${cmd} failed` };
    if (/cancelled\s+[1-9]/i.test(r.tail)) return { green: false, why: `${cmd} was cancelled` };
  }
  return { green: true };
}

const inflight = new Map();
const safe = (s) => String(s).replace(/[^\w.-]/g, "_");

/**
 * One integration attempt for a run. `manual` is the Integrate button: it
 * retries a recorded non-final outcome and merges a repo that declares no
 * checks (the person asked); the automatic trigger does neither. Calls for a
 * run already in flight share its result.
 */
function integrateAgent(args) {
  const { worktree, runId, git, checks, markerDir } = args || {};
  if (!worktree || !runId || !markerDir || typeof git !== "function" || typeof checks !== "function") {
    return Promise.resolve({ status: "failed", why: "integration data was incomplete" });
  }
  const key = String(runId);
  if (inflight.has(key)) return inflight.get(key);
  const p = attempt(args).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function attempt({ worktree: wt, runId, git, checks, markerDir, manual = false }) {
  const marker = path.join(markerDir, `${safe(runId)}.json`);
  let record = null;
  try { record = JSON.parse(fs.readFileSync(marker, "utf8")); } catch {}
  if (record && record.runId === String(runId) && (record.result.status === "integrated" || !manual)) return record.result;
  const finish = (result) => {
    try {
      fs.mkdirSync(markerDir, { recursive: true });
      fs.writeFileSync(marker, JSON.stringify({ runId: String(runId), result }));
    } catch {}
    return result;
  };
  const R = (a) => git(["-C", wt.repo, ...a]);
  const W = (a) => git(["-C", wt.dir, ...a]);
  try {
    // Work the agent left uncommitted goes onto its own branch first, so the
    // checks see it and the merge carries it. zevet's commit, not the user's.
    if (fs.existsSync(wt.dir) && (await W(["status", "--porcelain"])).trim()) {
      await W(["add", "-A"]);
      await W(["-c", "user.name=zevet", "-c", "user.email=zevet@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "Agent work"]);
    }
    const blocked = () => parentBlocker(wt, R);
    let why = await blocked();
    if (why) return finish({ status: "waiting", why });
    const declared = await checks(wt);
    if (!declared && !manual) return finish({ status: "no checks" });
    if (declared && declared.green !== true) return finish({ status: "failed", why: declared.why || "checks are not green" });
    // The checks can take minutes; the user may have moved on meanwhile.
    why = await blocked();
    if (why) return finish({ status: "waiting", why });
    return finish(await merge(wt, R));
  } catch (err) {
    return finish({ status: "failed", why: String(err && err.message || err) });
  }
}

/** Why the parent checkout must not be merged into right now, or "". */
async function parentBlocker(wt, R) {
  const gitDir = path.resolve(wt.repo, (await R(["rev-parse", "--absolute-git-dir"])).trim());
  for (const n of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    if (fs.existsSync(path.join(gitDir, n))) return "parent checkout is mid-merge or rebase";
  }
  if ((await R(["status", "--porcelain"])).trim()) return "parent checkout has uncommitted changes";
  const parent = (await R(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (!wt.parentBranch) return "parent branch unknown";
  if (parent !== wt.parentBranch) return `parent moved to ${parent}`;
  return "";
}

async function merge(wt, R) {
  const ident = [];
  try { await R(["config", "user.email"]); } catch { ident.push("-c", "user.name=zevet", "-c", "user.email=zevet@localhost"); }
  try {
    await R([...ident, "merge", "--no-ff", "--no-edit", wt.branch]);
    return { status: "integrated", branch: wt.branch, parent: wt.parentBranch };
  } catch (err) {
    let files = [];
    try { files = (await R(["diff", "--name-only", "--diff-filter=U"])).split("\n").map((s) => s.trim()).filter(Boolean); } catch {}
    try { await R(["merge", "--abort"]); } catch {}
    let clean = false;
    try { clean = !(await parentBlocker({ ...wt, parentBranch: wt.parentBranch }, R)); } catch {}
    if (!clean) return { status: "failed", why: "merge failed and the checkout could not be restored: resolve it by hand", files };
    if (files.length) return { status: "failed", why: `conflicts in ${files.length} file${files.length === 1 ? "" : "s"}`, files };
    return { status: "failed", why: `merge failed: ${String(err.message).split("\n")[0]}` };
  }
}

module.exports = { integrateAgent, runAgentChecks, declaredChecks, killChecks };
