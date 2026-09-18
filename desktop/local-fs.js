// zevet desktop — the local file tree, read from the user's own disk.
//
// WHERE THIS RUNS, because it decides everything below: the Electron MAIN
// process, on the teammate's machine, over their own files. The hub never sees
// any of it. Nothing here is ever sent anywhere — the board window renders a
// remote page and has no bridge to this module. What crosses into this file is
// a *string from a renderer*, and a renderer is the one input that must be
// treated as hostile even when it is our own: a compromised or spoofed hub can
// script the page, and the page can ask for a path.
//
// So this file has exactly one security-critical job, `readTextFile`'s
// containment check, and the rest is bookkeeping around it.
//
// CommonJS on purpose: the Electron main process is CommonJS, `main.js` is
// CommonJS, and this is `require`d from there. No dependencies — the desktop
// app has none beyond Electron and is worth keeping that way, since every
// dependency here runs with the user's full filesystem rights.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Directories that are never worth showing and are expensive to walk.
 *
 * `node_modules` is the reason the cap in `listTree` exists at all — a modest
 * web project holds tens of thousands of files in it, none of which a person
 * wants in a file tree. The build outputs (`.next`, `dist`, `out`) are
 * generated, so showing them invites someone to edit a file that the next
 * build deletes. `.git` is skipped for the same reason plus one more: its
 * contents are packfiles and loose objects, i.e. binary noise.
 *
 * Matched by exact basename at any depth. A source directory that happens to
 * be called `dist` is collateral damage; `opts.exclude` is the escape hatch,
 * and a caller that needs the opposite can pass a shorter list — see
 * `skipSet`.
 */
const DEFAULT_SKIP = [
  ".git",
  "node_modules",
  ".next",
  "dist",
  "out",
  ".venv",
  "__pycache__",
  ".DS_Store",
];

/**
 * 4000 entries is a file tree a person can scroll; it is not a filesystem
 * index. The number is a *safety* limit rather than a UI one: the walk is
 * synchronous (see `listTree`), so the cap is what bounds how long the main
 * process can be blocked. Hitting it sets `truncated`, which the UI is
 * expected to show — silently returning a partial tree would be a lie about
 * the disk.
 */
const DEFAULT_MAX_ENTRIES = 4000;

/**
 * 12 levels is deeper than any hand-written source tree and shallower than the
 * cycles a pathological layout can produce. Symlinked directories are skipped
 * outright (below), so this is not the loop guard — it is the "somebody opened
 * their home directory" guard.
 */
const DEFAULT_MAX_DEPTH = 12;

/**
 * 512 KiB. Past this a "text file" is a log, a lockfile or a minified bundle,
 * and shipping it into a renderer costs a structured-clone copy plus whatever
 * the editor component does with it. Refused rather than trimmed, so the user
 * is never shown half a file that looks whole.
 */
const DEFAULT_MAX_BYTES = 512 * 1024;

/**
 * The classic heuristic: a NUL byte in the first chunk means this is not text.
 * It is a heuristic and it is stated as one — UTF-16 text is full of NULs and
 * will be refused, and a binary format whose first 8000 bytes happen to be
 * NUL-free will slip through and render as mojibake. Both failures are
 * cosmetic, which is why a cheap check is the right size of tool here.
 */
const BINARY_SNIFF_BYTES = 8000;

/** Windows compares paths case-insensitively; POSIX does not. */
const CASE_FOLD = process.platform === "win32";

function foldCase(p) {
  return CASE_FOLD ? p.toLowerCase() : p;
}

function skipSet(opts) {
  const extra = Array.isArray(opts.exclude) ? opts.exclude : [];
  return new Set([...DEFAULT_SKIP, ...extra.filter((n) => typeof n === "string" && n.length > 0)]);
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Resolves `rootDir` to a real absolute path.
 *
 * `realpathSync` and not just `resolve`, because every containment decision in
 * this file is a string comparison against this value. If the root still holds
 * a symlink (`/tmp` is `/private/tmp` on macOS; a junction is routine on
 * Windows) then a resolved target and the root are spelled differently for the
 * same directory, and a legitimate read gets refused as an escape. Normalising
 * both ends through the same call is what makes the comparison mean anything.
 */
function realRoot(rootDir) {
  if (typeof rootDir !== "string" || rootDir.length === 0) {
    return { ok: false, error: "no folder given" };
  }
  try {
    const abs = fs.realpathSync(path.resolve(rootDir));
    const st = fs.statSync(abs);
    if (!st.isDirectory()) return { ok: false, error: "not a folder" };
    return { ok: true, root: abs };
  } catch (err) {
    if (err.code === "ENOENT") return { ok: false, error: "no such folder" };
    if (err.code === "EACCES" || err.code === "EPERM") return { ok: false, error: "not allowed to read that folder" };
    return { ok: false, error: `cannot open that folder: ${err.code || err.message}` };
  }
}

/** Is `abs` the root itself, or somewhere beneath it? */
function within(root, abs) {
  if (foldCase(abs) === foldCase(root)) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return foldCase(abs).startsWith(foldCase(prefix));
}

/**
 * Directory entries, sorted the way a file tree reads: folders first, then
 * case-insensitive alphabetical.
 *
 * `localeCompare` is deliberately not used. It is locale- and ICU-dependent,
 * so the same repo would sort differently on two teammates' machines, and this
 * ordering is part of what the hub and the UI key on. Lowercased comparison
 * with the raw string as a tie-break is boring and identical everywhere —
 * which is the requirement.
 */
function byKindThenName(a, b) {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  const al = a.name.toLowerCase();
  const bl = b.name.toLowerCase();
  if (al !== bl) return al < bl ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return 0;
}

/**
 * A flat, ordered listing of `rootDir`.
 *
 * Flat rather than nested because the consumers are a virtualised list and a
 * path-keyed map; the shape is pre-order depth-first, so a parent is always
 * immediately followed by its subtree and the UI can indent by `depth` without
 * rebuilding a hierarchy.
 *
 * `path` is relative and forward-slashed ON EVERY PLATFORM, Windows included.
 * This is not cosmetic: the hub records activity against forward-slash paths,
 * and a `src\lib\a.ts` from a Windows desktop would simply never match the
 * `src/lib/a.ts` everything else speaks. It would not error — it would quietly
 * show nobody working on any file, which is the worst kind of bug to own.
 *
 * SYNCHRONOUS, and that is a decision. It blocks the Electron main process,
 * which is normally the thing you do not do; it is acceptable here only
 * because `maxEntries` and `maxDepth` bound the work to a few thousand `lstat`
 * calls. If either limit is ever raised much, this should move to
 * `fs.promises` first.
 *
 * @param {string} rootDir absolute or relative path to the workspace root
 * @param {{maxEntries?:number,maxDepth?:number,exclude?:string[]}} [opts]
 * @returns {{ok:true,root:string,entries:object[],truncated:boolean}|{ok:false,error:string}}
 */
function listTree(rootDir, opts = {}) {
  const options = opts || {};
  const maxEntries = positiveInt(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const maxDepth = positiveInt(options.maxDepth, DEFAULT_MAX_DEPTH);
  const skip = skipSet(options);

  const rooted = realRoot(rootDir);
  if (!rooted.ok) return rooted;
  const root = rooted.root;

  const entries = [];
  let truncated = false;

  // `depth` is the number of path separators in the relative path: a file
  // directly in the root is depth 0. `maxDepth` caps the depth we will
  // DESCEND INTO, so entries at depth `maxDepth` are listed and a directory
  // there is shown but not opened.
  function walk(absDir, relDir, depth) {
    if (truncated) return;

    let names;
    try {
      names = fs.readdirSync(absDir);
    } catch (err) {
      // A directory we may not read is a fact about the machine, not a failure
      // of the tree. The parent entry stays in the listing (a user seeing an
      // empty folder they cannot open is accurate); we say so on stderr rather
      // than swallowing it, because "why is this folder empty" is otherwise
      // unanswerable.
      console.warn(`[local-fs] skipping ${absDir}: ${err.code || err.message}`);
      return;
    }

    const kids = [];
    for (const name of names) {
      if (skip.has(name)) continue;

      const abs = path.join(absDir, name);
      let st;
      try {
        // lstat, NEVER stat. `stat` follows the link, so a symlink pointing at
        // `C:\` or `/` would report as an ordinary directory and we would walk
        // the entire disk — slowly, and into places the user never opened.
        st = fs.lstatSync(abs);
      } catch (err) {
        if (err.code === "ENOENT") continue; // deleted while we walked; normal
        console.warn(`[local-fs] skipping ${abs}: ${err.code || err.message}`);
        continue;
      }

      // Symlinks are skipped entirely, links to files included. Following a
      // linked directory is the disk-walking hazard above; listing a linked
      // FILE is milder but still misreports where the bytes live, and the tree
      // is a picture of this workspace. Refusing both keeps one rule.
      if (st.isSymbolicLink()) continue;

      const isDir = st.isDirectory();
      if (!isDir && !st.isFile()) continue; // sockets, FIFOs, devices

      kids.push({
        name,
        kind: isDir ? "dir" : "file",
        // A directory's `size` is its dirent size, which means nothing useful
        // to a reader; it is reported as 0 so nothing downstream displays a
        // number that looks like a byte count and is not.
        size: isDir ? 0 : st.size,
        mtimeMs: st.mtimeMs,
      });
    }

    kids.sort(byKindThenName);

    for (const kid of kids) {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      const rel = relDir ? `${relDir}/${kid.name}` : kid.name;
      entries.push({
        path: rel, // forward slashes by construction: never path.join here
        name: kid.name,
        kind: kid.kind,
        depth,
        size: kid.size,
        mtimeMs: kid.mtimeMs,
      });
      if (kid.kind === "dir" && depth < maxDepth) {
        walk(path.join(absDir, kid.name), rel, depth + 1);
        if (truncated) return;
      }
    }
  }

  walk(root, "", 0);
  return { ok: true, root, entries, truncated };
}

/**
 * Turns a renderer-supplied relative path into an absolute path inside `root`,
 * or `null` if it escapes.
 *
 * THIS IS THE FUNCTION THAT MATTERS. Everything else in this file is a
 * convenience; this one is the difference between "an IDE pane" and "a remote
 * page reading ~/.ssh/id_rsa". It is written to be boring and to refuse first.
 *
 * Three layers, because each catches something the others do not:
 *
 *  1. Spellings that mean "absolute" ANYWHERE are rejected up front, on every
 *     platform. `/etc/passwd` is not absolute on Windows and `C:\Windows` is
 *     not absolute on POSIX, so relying on `path.isAbsolute` alone means the
 *     rule changes with the OS — and the string may well have come from a
 *     different OS's idea of a path. UNC (`\\server\share`) is its own case:
 *     `path.resolve` on Windows treats it as a root and would happily reach a
 *     file server.
 *  2. `path.resolve` then collapses `..`, and the result is checked for
 *     containment. This is what stops `../../etc/passwd` and, importantly,
 *     `a/../../b` — which no prefix check on the raw string would catch.
 *  3. The caller re-checks containment AFTER `realpathSync`, because a symlink
 *     *inside* the workspace is a legal relative path whose bytes live outside
 *     it. Lexical containment cannot see that; only the resolved path can.
 *
 * NUL is rejected because Node throws on it anyway, and a thrown error here
 * would surface as an opaque crash rather than a refusal.
 */
function insideRoot(root, relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) return null;
  if (relPath.includes("\0")) return null;
  if (/^[\\/]/.test(relPath)) return null; // /etc/passwd, \Windows, \\server\share
  if (/^[A-Za-z]:/.test(relPath)) return null; // C:\Windows\win.ini, and C:relative

  const abs = path.resolve(root, relPath);
  return within(root, abs) ? abs : null;
}

/**
 * Reads one text file from inside the workspace.
 *
 * `relPath` is untrusted input — see `insideRoot`. Every refusal returns the
 * same shape as a success so the renderer has one code path, and the escape
 * refusal returns one fixed string rather than the path it rejected: echoing
 * an attacker's path into the UI is how a refusal becomes an oracle.
 *
 * @param {string} rootDir the workspace root
 * @param {string} relPath forward-slashed path relative to that root
 * @param {{maxBytes?:number}} [opts]
 * @returns {{ok:true,text:string,truncated:boolean,bytes:number}|{ok:false,error:string}}
 */
function readTextFile(rootDir, relPath, opts = {}) {
  const options = opts || {};
  const maxBytes = positiveInt(options.maxBytes, DEFAULT_MAX_BYTES);

  const rooted = realRoot(rootDir);
  if (!rooted.ok) return rooted;
  const root = rooted.root;

  const abs = insideRoot(root, relPath);
  if (!abs) return { ok: false, error: "outside the workspace" };

  let real;
  try {
    // Layer 3: resolve the link chain and check containment again. A symlink
    // living in the workspace and pointing at /etc/passwd passes the lexical
    // check and fails here.
    real = fs.realpathSync(abs);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return { ok: false, error: "no such file" };
    if (err.code === "EACCES" || err.code === "EPERM") return { ok: false, error: "not allowed to read that file" };
    return { ok: false, error: `cannot open that file: ${err.code || err.message}` };
  }
  if (!within(root, real)) return { ok: false, error: "outside the workspace" };

  let st;
  try {
    st = fs.statSync(real);
  } catch (err) {
    return { ok: false, error: `cannot open that file: ${err.code || err.message}` };
  }
  if (st.isDirectory()) return { ok: false, error: "that is a folder" };
  if (!st.isFile()) return { ok: false, error: "not a regular file" };
  if (st.size > maxBytes) {
    return { ok: false, error: `too big — ${st.size} bytes, limit ${maxBytes}` };
  }

  let buf;
  let bytes;
  let fd;
  try {
    fd = fs.openSync(real, "r");
    // maxBytes + 1 on purpose. The size check above reads a stat taken a
    // moment earlier, and a file being appended to — a log, a build output —
    // can outgrow it between the two calls. Reading one byte past the limit is
    // how we notice, instead of trusting a number that has expired.
    buf = Buffer.allocUnsafe(maxBytes + 1);
    bytes = fs.readSync(fd, buf, 0, maxBytes + 1, 0);
  } catch (err) {
    if (err.code === "EACCES" || err.code === "EPERM") return { ok: false, error: "not allowed to read that file" };
    if (err.code === "ENOENT") return { ok: false, error: "no such file" };
    return { ok: false, error: `cannot read that file: ${err.code || err.message}` };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  // `truncated` is only ever true on that grow-between-stat-and-read race, so
  // the suite exercises the refusal path above and not this one. Said plainly
  // rather than implied: this branch is reasoned, not measured. A cut here can
  // also land mid-codepoint and produce one U+FFFD at the end, which is
  // acceptable for a file that is already being reported as incomplete.
  let truncated = false;
  if (bytes > maxBytes) {
    bytes = maxBytes;
    truncated = true;
  }

  const data = buf.subarray(0, bytes);
  if (data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return { ok: false, error: "looks binary" };
  }

  let text = data.toString("utf8");
  // A UTF-8 BOM decodes to U+FEFF, which is invisible, sorts before
  // everything, and breaks the first line of anything that parses — JSON,
  // shebangs, a diff. Windows editors still write it. `bytes` deliberately
  // keeps counting it: it is the size of the file on disk, not of the string.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  return { ok: true, text, truncated, bytes };
}

/**
 * Does `dir` look like a git repository?
 *
 * `.git` is checked as an ENTRY, not as a directory: in a `git worktree` (and
 * in a submodule) `.git` is a FILE containing a `gitdir:` pointer. Testing
 * `isDirectory()` would tell every worktree user that their checkout is not a
 * repo, and worktrees are exactly how someone runs two agents on one project —
 * which is the audience for this whole app.
 *
 * `lstatSync` rather than `existsSync` so a dangling symlink still counts as
 * "there is something called .git here", which is the question being asked.
 * This is a hint used to decide whether to offer to wire a folder up, so
 * cheerful guessing is correct and a false positive costs nothing.
 */
function isProbablyRepo(dir) {
  if (typeof dir !== "string" || dir.length === 0) return false;
  try {
    fs.lstatSync(path.join(dir, ".git"));
    return true;
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return false;
    // EACCES and friends: we cannot tell, so we say no rather than claim a
    // repo we never saw. Noted on stderr because a permission error on a
    // folder the user just picked is worth a trace.
    console.warn(`[local-fs] cannot check ${dir} for .git: ${err.code || err.message}`);
    return false;
  }
}

module.exports = {
  listTree,
  readTextFile,
  isProbablyRepo,
  // Exported so the UI can show the same numbers it is being limited by, and
  // so the tests assert against the real defaults instead of copies of them.
  DEFAULT_SKIP,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_BYTES,
};
