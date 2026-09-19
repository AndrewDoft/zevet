// Line counts and diff stats for the file tree, so a row can say `412 · +18 −3`.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ THIS SPAWNS `git`, AND local-fs.js DELIBERATELY DOES NOT. That is not an
// inconsistency, it is the same reasoning reaching a different answer in a
// different place. `client/hook.mjs` refuses to shell out because it runs
// before every single tool call and is measured in milliseconds against a
// 1500ms budget — "not worth a subprocess on somebody else's turn for
// information that is two file reads away". This module runs when a person
// opens a workspace panel and when files change, at human speed, and there is
// no filesystem-only way to learn what git thinks changed. Wrong tool there,
// right tool here.
//
// ⚠️ EVERYTHING HERE IS BEST-EFFORT AND FAILS TO EMPTY. A workspace that is not
// a git repo, a git that is not installed, a repo mid-rebase with no HEAD — all
// of them return "no diff information" rather than throwing. The panel degrades
// to line counts alone. A file tree that refuses to draw because `git` is
// missing would be a worse tool than one that draws without badges.
//
// ⚠️ NOT VERIFIED: this has been run against ordinary repos only. Submodules,
// worktrees with a detached HEAD, and repos with no commits at all are handled
// by the fail-to-empty path rather than by anything that was tested against a
// real one of each.
"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/**
 * A repo with no commits has no HEAD, so `git diff HEAD` errors rather than
 * reporting every file as new. `EMPTY_TREE` is git's fixed hash for the empty
 * tree object and diffing against it gives the right answer: everything added.
 * The value is a constant of git's, not a hash of anything in this repo.
 */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Nobody needs stats on a 50MB file, and reading one to count its newlines is
 *  how a panel becomes a freeze. Matches local-fs.js's own read ceiling. */
const MAX_COUNT_BYTES = 512 * 1024;

/** One git call is allowed this long before the panel gives up on it. A repo on
 *  a cold network drive can take seconds, and a spinner forever is worse than
 *  a tree with no badges. */
const GIT_TIMEOUT_MS = 4000;

function git(rootDir, args) {
  return new Promise((resolve) => {
    execFile(
      "git",
      // `-c core.quotepath=false` so a path with non-ASCII characters comes
      // back as itself rather than as octal escapes, which would never match
      // the forward-slashed relative paths listTree produces.
      ["-C", rootDir, "-c", "core.quotepath=false", ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        // Resolve with null rather than rejecting: every caller's response to a
        // failure is "carry on without badges", and a rejected promise here
        // would mean every call site repeating that decision.
        if (err) return resolve(null);
        resolve(String(stdout));
      },
    );
  });
}

/**
 * Diff stats against HEAD, keyed by repo-relative forward-slashed path — the
 * same spelling `local-fs.js` hands out, so the tree can look a row up without
 * normalising anything.
 *
 * Returns `{ byPath: Map<string, {added, removed, status}>, ok: boolean }`.
 * `ok` false means git said nothing useful and the caller should draw no
 * badges at all, which is different from `ok` true with an empty map — that
 * one means a clean tree, and is worth showing.
 */
async function diffStats(rootDir) {
  const empty = { byPath: new Map(), ok: false };
  if (!rootDir || typeof rootDir !== "string") return empty;

  // Does this directory have a HEAD to diff against? One cheap call decides
  // between `HEAD` and the empty tree, and also tells us git works at all.
  const head = await git(rootDir, ["rev-parse", "--verify", "HEAD"]);
  const base = head && head.trim() ? "HEAD" : EMPTY_TREE;

  const numstat = await git(rootDir, ["diff", "--numstat", base]);
  if (numstat === null) return empty;

  const byPath = new Map();
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    // `<added>\t<removed>\t<path>`. A binary file reports "-\t-\t<path>", which
    // is a real answer and not a parse failure: it changed, and the count is
    // meaningless. Recorded as nulls so the caller can say "binary" rather
    // than "+0 −0", which would read as "unchanged".
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [a, r] = parts;
    // A rename arrives as `old => new` (or with a brace form) in the third
    // field. Take the last path; the row the user is looking at is the new one.
    const rel = parts.slice(2).join("\t");
    const binary = a === "-" || r === "-";
    byPath.set(renamedTo(rel), {
      added: binary ? null : Number(a),
      removed: binary ? null : Number(r),
      status: "modified",
    });
  }

  // Untracked files are absent from `git diff` entirely, and a new file with no
  // badge next to a modified one with `+18` reads as "unchanged", which is the
  // opposite of true. `--porcelain` names them; their whole length is "added".
  const porcelain = await git(rootDir, ["status", "--porcelain", "--untracked-files=all"]);
  if (porcelain !== null) {
    for (const line of porcelain.split("\n")) {
      if (!line.startsWith("?? ")) continue;
      const rel = line.slice(3).trim().replace(/^"|"$/g, "");
      if (!byPath.has(rel)) byPath.set(rel, { added: null, removed: 0, status: "untracked" });
    }
  }

  return { byPath, ok: true };
}

/**
 * `dir/{old => new}/file.ts` and `old.ts => new.ts` are both git's rename
 * spellings. The tree has a row for the file that exists NOW, so both resolve
 * to the right-hand side.
 */
function renamedTo(rel) {
  const brace = rel.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) {
    // The middle may be empty on either side (`a/{ => b}/f.ts`), and joining
    // naively then leaves a doubled slash that matches nothing.
    return (brace[1] + brace[3] + brace[4]).replace(/\/{2,}/g, "/");
  }
  const arrow = rel.split(" => ");
  return (arrow.length === 2 ? arrow[1] : rel).trim();
}

/**
 * Line counts, cached on (size, mtimeMs).
 *
 * The cache is the whole reason this is a module and not four lines inline. A
 * tree can hold thousands of files and the panel recounts on every refresh;
 * without a cache that is thousands of reads a second while an agent is
 * working. With one, a file is read once and then only when it actually
 * changes — which is exactly the event the board already knows about.
 *
 * ⚠️ mtime granularity is one second on some filesystems, so two writes inside
 * the same second with the same resulting size will serve a stale count. The
 * alternative is hashing every file, which is the cost this exists to avoid.
 * The count is a badge on a tree row, not a correctness-critical number.
 */
class LineCounter {
  constructor() {
    /** @type {Map<string, {size:number, mtimeMs:number, lines:number|null}>} */
    this.cache = new Map();
  }

  /** `null` means "not counted": too big, binary, or unreadable. */
  count(rootDir, relPath) {
    const abs = path.join(rootDir, relPath);
    let st;
    try {
      // lstat, not stat: a symlink must not be followed here any more than it
      // is in local-fs.js, and counting the lines of whatever it points at
      // would be reading outside the workspace to draw a badge.
      st = fs.lstatSync(abs);
    } catch {
      this.cache.delete(abs);
      return null;
    }
    if (!st.isFile()) return null;

    const hit = this.cache.get(abs);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.lines;

    let lines = null;
    if (st.size <= MAX_COUNT_BYTES) {
      try {
        const buf = fs.readFileSync(abs);
        // The same NUL sniff local-fs.js uses, over the same first 8000 bytes.
        // Counting the "lines" of a PNG produces a number, and a wrong one.
        const sniff = buf.subarray(0, 8000);
        if (!sniff.includes(0)) lines = countLines(buf);
      } catch {
        lines = null;
      }
    }
    this.cache.set(abs, { size: st.size, mtimeMs: st.mtimeMs, lines });
    return lines;
  }

  /** Count a whole list, returning a plain object the renderer can ship over IPC. */
  countAll(rootDir, relPaths) {
    const out = Object.create(null);
    for (const rel of relPaths) out[rel] = this.count(rootDir, rel);
    return out;
  }

  forget(rootDir) {
    if (!rootDir) return this.cache.clear();
    const prefix = path.resolve(rootDir) + path.sep;
    for (const k of this.cache.keys()) if (k.startsWith(prefix)) this.cache.delete(k);
  }
}

/**
 * Lines, counted the way an editor counts them: a file with no trailing newline
 * still ends in a line, and an empty file has none.
 *
 * Counting `split("\n").length` instead is off by one on every file that ends
 * with a newline, which is almost all of them — the badge would say 413 for a
 * 412-line file and look like a bug forever.
 */
function countLines(buf) {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  // A trailing newline terminates the last line rather than starting a new one.
  return buf[buf.length - 1] === 0x0a ? n : n + 1;
}

module.exports = { diffStats, LineCounter, countLines, renamedTo, EMPTY_TREE, MAX_COUNT_BYTES };
