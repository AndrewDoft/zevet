"use strict";

const fs = require("node:fs");

/** Integrate one completed agent worktree, at most once for this run. */
async function integrateAgent({ worktree, runId, git, checks }) {
  if (!worktree || !runId || typeof git !== "function" || typeof checks !== "function") {
    return { status: "failed", why: "integration data was incomplete" };
  }
  const marker = `${worktree.dir}.integration.json`;
  let record = null;
  try { record = JSON.parse(fs.readFileSync(marker, "utf8")); } catch {}
  if (record && record.runId === String(runId)) return record.result;
  const fail = (why) => {
    const result = { status: "failed", why: String(why) };
    try { fs.writeFileSync(marker, JSON.stringify({ runId: String(runId), result })); } catch {}
    return result;
  };
  let verdict;
  try { verdict = await checks(worktree.dir); } catch (err) { return fail(`checks could not run: ${err.message}`); }
  if (!verdict || verdict.green !== true) return fail(verdict?.why || "checks are not green");
  try {
    const parent = (await git(["-C", worktree.repo, "rev-parse", "--abbrev-ref", "HEAD"])).trim();
    await git(["-C", worktree.repo, "merge", "--no-ff", "--no-edit", worktree.branch]);
    const result = { status: "integrated", branch: worktree.branch, parent };
    fs.writeFileSync(marker, JSON.stringify({ runId: String(runId), result }));
    return result;
  } catch (err) {
    return fail(`merge failed: ${err.message}`);
  }
}

function runAgentChecks(dir, exec = require("node:child_process").execFile) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const run = (args) => new Promise((resolve) => exec(npm, args, { cwd: dir, windowsHide: true, timeout: 15 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout = "", stderr = "") => resolve({ err, stdout: String(stdout), stderr: String(stderr) })));
  return Promise.all([run(["test"]), run(["run", "typecheck"])]).then(([tests, types]) => ({
    green: !tests.err && !types.err && !/cancelled\s+[1-9]/i.test(tests.stdout + tests.stderr),
    why: tests.err ? "tests failed" : types.err ? "typecheck failed" : "tests were cancelled",
  }));
}

module.exports = { integrateAgent, runAgentChecks };
