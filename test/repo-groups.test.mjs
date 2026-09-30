// The agents tree: worktrees file under their base repo, and everything is
// ordered by recent activity (Andrew, 2026-09-30).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { foldRepoGroups } from "../board/src/lib/sessions.mjs";

const require = createRequire(import.meta.url);
const { repoOf } = require("../desktop/agent-sessions.js");

test("a linked worktree answers its origin repo's name, from any depth", () => {
  const base = mkdtempSync(path.join(tmpdir(), "zv-repo-"));
  const origin = path.join(base, "masora2");
  const wtGit = path.join(origin, ".git", "worktrees", "fixb");
  mkdirSync(wtGit, { recursive: true });
  writeFileSync(path.join(wtGit, "commondir"), "../..\n");
  const wt = path.join(base, "masora2-w125-fixb");
  mkdirSync(path.join(wt, "apps", "web"), { recursive: true });
  writeFileSync(path.join(wt, ".git"), `gitdir: ${wtGit}\n`);
  assert.equal(repoOf(wt), "masora2");
  assert.equal(repoOf(path.join(wt, "apps", "web")), "masora2");
  assert.equal(repoOf(origin), "masora2");
  const other = path.join(base, "masora2-crm");
  mkdirSync(path.join(other, ".git"), { recursive: true });
  assert.equal(repoOf(other), "masora2-crm", "a real repo keeps its own name");
  assert.equal(repoOf(path.join(base, "nowhere")), "");
});

test("unresolved worktree names fold under their base; resolved names never do", () => {
  const out = foldRepoGroups(new Map([
    ["masora2", { rows: ["a"], resolved: true }],
    ["masora2-w125-fixb", { rows: ["b"], resolved: false }],
    ["masora2-d90277", { rows: ["c"], resolved: false }],
    ["zevet", { rows: ["d"], resolved: true }],
    ["zevet-crm", { rows: ["e"], resolved: true }],
  ]));
  assert.deepEqual([...out.keys()], ["masora2", "zevet", "zevet-crm"]);
  assert.deepEqual(out.get("masora2"), ["a", "b", "c"]);
});

test("the tree is ordered by activity: people, repos, agents", () => {
  const src = readFileSync(new URL("../board/src/components/people.tsx", import.meta.url), "utf8");
  assert.match(src, /\[\.\.\.roster\]\.sort\(\(a, b\) => b\.lastTs - a\.lastTs\)/);
  assert.match(src, /updated: c\.lastAt \?\? c\.startedAt/);
  assert.match(src, /rows\.sort\(\(a, b\) => b\.updated - a\.updated\)/);
  assert.match(src, /groups\.sort\(\(a, b\) => Number\(b\.rows\[0\]\.updated/);
  const board = readFileSync(new URL("../board/src/lib/board.ts", import.meta.url), "utf8");
  assert.match(board, /c\.lastAt = Date\.now\(\);/);
  const sessions = readFileSync(new URL("../desktop/agent-sessions.js", import.meta.url), "utf8");
  assert.match(sessions, /out\.sort\(\(a, b\) => b\.updated - a\.updated\)/, "subagents newest first");
});
