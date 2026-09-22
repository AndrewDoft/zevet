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
// So this file HAD exactly one security-critical job, `readTextFile`'s
// containment check. It now has TWO: `writeTextFile` is the second, and it is
// the more dangerous one. A read that escapes the workspace leaks a file; a
// write that escapes the workspace IS the machine — an in-workspace symlink to
// ~/.ssh/authorized_keys, a line appended to a shell profile, a rewritten
// .git/hooks/pre-commit that runs on the next commit. The write path therefore
// repeats every check the read path makes and adds four more (no symlink at
// the target, no inventing directories, nothing inside `.git` or the other
// skipped names, and the bytes land by rename or not at all).
//
// This comment said "exactly one" for as long as that was true, which is the
// only reason it is worth reading. If a third job ever appears here, say three.
//
// CommonJS on purpose: the Electron main process is CommonJS, `main.js` is
// CommonJS, and this is `require`d from there. No dependencies — the desktop
// app has none beyond Electron and is worth keeping that way, since every
// dependency here runs with the user's full filesystem rights.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
// Only for the temp-file suffix in `writeTextFile`. `node:crypto` is a builtin,
// so the "no dependencies" rule above is intact; `Math.random` would also have
// been fine for uniqueness, but a collision here would overwrite somebody's
// file and the cost of never having to think about that again is one require.
const crypto = require("node:crypto");

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

/**
 * Does any segment of `abs`, relative to `root`, name something this app
 * will not write into?
 *
 * Shared by the two calls in writeTextFile ON PURPOSE. They check DIFFERENT
 * paths -- the spelling handed in, and the one resolved through symlinks --
 * and the bug this guards against was the second never being checked at all.
 * One function so they cannot drift apart again.
 */
function hasSkippedSegment(root, abs, folded) {
  return path
    .relative(root, abs)
    .split(/[\\/]+/)
    .filter((seg) => seg.length > 0)
    .some((seg) => folded.has(foldCase(seg)));
}

function skipSet(opts) {
  const extra = Array.isArray(opts.exclude) ? opts.exclude : [];
  return new Set([...DEFAULT_SKIP, ...extra.filter((n) => typeof n === "string" && n.length > 0)]);
}

/**
 * Paths Git says are ignored in this checkout, normalized to the spelling the
 * tree uses. Tracked files stay out of this result by design: a .gitignore is
 * often intentionally tracked, and a file tree must not hide source merely
 * because a rule would ignore a new copy of it.
 */
function ignoredByGit(root) {
  try {
    return new Set(
      execFileSync(
        "git",
        ["-C", root, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      )
        .split(/\r?\n/)
        .filter(Boolean)
        .map((p) => p.replace(/\\/g, "/").replace(/\/+$/, "")),
    );
  } catch {
    // A plain folder, a missing git executable, or a broken repository still
    // deserves a tree. Only a repository that answers gets Git filtering.
    return new Set();
  }
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
  const ignored = ignoredByGit(root);

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
      const rel = relDir ? `${relDir}/${name}` : name;
      if (ignored.has(rel) || Array.from(ignored).some((ignoredPath) => rel.startsWith(ignoredPath + "/"))) continue;
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
 * `bom` and `eol` are ADDED fields, not replacements: `text`, `truncated` and
 * `bytes` mean exactly what they always did, because `desktop/main.js`'s
 * `local:read` and the viewer in `hub/public/index.html` read those three and
 * nothing else. They exist so `writeTextFile` can put a file back the way it
 * found it — see `dominantEol` and the BOM note at the bottom of this function.
 *
 * @param {string} rootDir the workspace root
 * @param {string} relPath forward-slashed path relative to that root
 * @param {{maxBytes?:number}} [opts]
 * @returns {{ok:true,text:string,truncated:boolean,bytes:number,bom:boolean,eol:"crlf"|"lf"}|{ok:false,error:string}}
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
  //
  // Stripping it is right for a reader and WRONG for a round-trip: read, edit,
  // write back without it and the file silently changed in a way git will
  // blame on whoever saved it. So the fact is reported rather than thrown
  // away, and `writeTextFile` takes it back as an option.
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);

  return { ok: true, text, truncated, bytes, bom, eol: dominantEol(text) };
}

/**
 * Which line ending this text mostly uses: `"crlf"` or `"lf"`.
 *
 * COUNTED, not sniffed from the first newline. A file touched on a Windows box
 * and a mac genuinely holds both, and the majority spelling is the one whose
 * restoration produces the smallest diff — which is the entire point of
 * carrying this around.
 *
 * A file with NO newlines at all has no answer, and this reports `"lf"`. That
 * is a DEFAULT, not an observation, and it is said out loud because a caller
 * writing the first line into a one-line file on Windows is getting a guess.
 * The alternative, reporting `null` and making every caller handle it, buys a
 * distinction nobody can act on: with no existing newline there is no original
 * to be faithful to.
 *
 * Lone CR (pre-OS X Mac) is not counted and not restored. It is 25 years dead
 * and pretending to handle it would be the bigger lie.
 */
function dominantEol(text) {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue;
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf ? "crlf" : "lf";
}

/**
 * Writes one text file inside the workspace. Atomically, or not at all.
 *
 * THE SECOND FUNCTION THAT MATTERS, and the worse one to get wrong. A read
 * that escapes leaks a file. A write that escapes owns the machine: the
 * classic shape is an ordinary-looking symlink in the repo pointing at
 * ~/.ssh/authorized_keys, and the classic second shape is .git/hooks/pre-commit,
 * which the user's next commit executes without anybody choosing to run it.
 *
 * So the containment is `readTextFile`'s, deliberately step for step, plus the
 * four things a write needs and a read does not:
 *
 *  1. `insideRoot`, unchanged: anything that SPELLS absolute on any platform
 *     (`/x`, `\x`, `C:x`, `\\server\share`) is refused before `path.resolve`
 *     ever sees it, then `..` is collapsed and containment re-checked.
 *  2. `realpathSync` containment, but on the PARENT directory rather than the
 *     target — the target legitimately may not exist yet, and `realpathSync`
 *     on a path that is not there is an ENOENT, not a verdict. Resolving the
 *     parent and re-joining the basename is what keeps a symlinked directory
 *     inside the workspace (`ws/link -> /etc`) from being a write escape: the
 *     lexical check passes it and only the resolved parent catches it.
 *  3. lstat of the target, refusing a symlink AT it. An ordinary write follows
 *     a link and lands wherever it points; a link whose target is inside the
 *     workspace today can be repointed outside it between the check and the
 *     write. Refusing every symlink is one rule and matches `listTree`, which
 *     does not show them either — so the editor never offers to save one.
 *  4. A parent that does not already exist is refused rather than created.
 *     There is no `mkdir -p` here on purpose: an editor saves a file into a
 *     folder somebody already made, and "create every directory named in an
 *     untrusted string" is a capability with no use case attached to it.
 *
 * And the names in `DEFAULT_SKIP` are refused at EVERY level of the path, not
 * just the last. `.git` is the reason — nothing typed into an editor pane has
 * business rewriting a hook, an index or a ref — and `node_modules` and the
 * build outputs follow because the tree does not show them, so any path
 * reaching them came from somewhere other than a user clicking a file. Matched
 * case-insensitively on Windows, which is stricter than `listTree`'s exact
 * match (that one only has to be right about what to DISPLAY): `.GIT\config`
 * is `.git\config` to NTFS, and a guard a change of case walks around is not a
 * guard.
 *
 * `opts.maxBytes` and `opts.exclude` are for callers in the main process. The
 * IPC handler does NOT forward them from the renderer — see `local:write` in
 * main.js — because a renderer that could set its own limit or shorten its own
 * skip list would be reviewing its own guard.
 *
 * @param {string} rootDir the workspace root
 * @param {string} relPath forward-slashed path relative to that root
 * @param {string} text the new contents
 * @param {{maxBytes?:number,exclude?:string[],bom?:boolean,eol?:"crlf"|"lf"}} [opts]
 *   `bom` and `eol` are what `readTextFile` reported when the file was opened;
 *   passing them back restores the file's own spelling. Leaving either out
 *   writes the string exactly as handed over.
 * @returns {{ok:true,bytes:number,bom:boolean,eol:"crlf"|"lf",created:boolean}|{ok:false,error:string}}
 */
function writeTextFile(rootDir, relPath, text, opts = {}) {
  const options = opts || {};
  const maxBytes = positiveInt(options.maxBytes, DEFAULT_MAX_BYTES);
  // Not a string is a caller bug rather than an attack, but it arrives over
  // the same IPC as everything else, so it is refused in the same shape.
  if (typeof text !== "string") return { ok: false, error: "nothing to write" };

  const rooted = realRoot(rootDir);
  if (!rooted.ok) return rooted;
  const root = rooted.root;

  // Layers 1 and 2, identical to the read path.
  const abs = insideRoot(root, relPath);
  if (!abs) return { ok: false, error: "outside the workspace" };
  // `"."` and `"sub/.."` resolve to the root itself, which `within` accepts
  // because it IS contained — it is simply not a file.
  if (foldCase(abs) === foldCase(root)) return { ok: false, error: "that is a folder" };

  const skip = skipSet(options);
  const folded = new Set([...skip].map(foldCase));
  /* Cheap, lexical, and NOT the one that matters -- it refuses the obvious
     spelling before anything touches the disk. The authoritative check is
     the second call below, against the RESOLVED target. */
  if (hasSkippedSegment(root, abs, folded)) {
    return { ok: false, error: "not a file this app will write" };
  }

  // BOM and line endings are settled before anything touches the disk, because
  // `maxBytes` has to be measured against the bytes that will actually land --
  // a CRLF restore on a large file adds one byte per line, and a limit checked
  // against the string instead of the buffer is a limit that can be stepped
  // over by a few thousand bytes.
  let body = text;
  if (options.eol === "crlf" || options.eol === "lf") {
    const unified = body.replace(/\r\n/g, "\n");
    body = options.eol === "crlf" ? unified.replace(/\n/g, "\r\n") : unified;
  }
  if (typeof options.bom === "boolean") {
    const bare = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;
    body = options.bom ? `\uFEFF${bare}` : bare;
  }
  const buf = Buffer.from(body, "utf8");
  if (buf.length > maxBytes) {
    return { ok: false, error: `too big \u2014 ${buf.length} bytes, limit ${maxBytes}` };
  }

  const parent = path.dirname(abs);
  const base = path.basename(abs);

  // Layer 3, moved to the parent. This ENOENT is also the "no mkdir -p" rule:
  // a parent that is not there is a refusal, not a thing to go and create.
  let realParent;
  try {
    realParent = fs.realpathSync(parent);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") {
      return { ok: false, error: "no such folder to write into" };
    }
    if (err.code === "EACCES" || err.code === "EPERM") return { ok: false, error: "not allowed to write there" };
    return { ok: false, error: `cannot open that folder: ${err.code || err.message}` };
  }
  if (!within(root, realParent)) return { ok: false, error: "outside the workspace" };

  try {
    if (!fs.statSync(realParent).isDirectory()) return { ok: false, error: "no such folder to write into" };
  } catch (err) {
    return { ok: false, error: `cannot open that folder: ${err.code || err.message}` };
  }

  // Rebuilt from the RESOLVED parent, so every call after this point — the
  // lstat, the temp file, the rename — is aimed at the directory that was
  // actually checked and not at the spelling that was handed in.
  const target = path.join(realParent, base);

  /* ⚠️ THE SKIP LIST MUST BE CHECKED ON THE PATH THAT WILL BE WRITTEN.
     It was checked only on `abs`, the spelling handed in, while the bytes
     land on `target`, rebuilt from the RESOLVED parent -- and a symlinked
     directory inside the workspace makes those two different paths with
     different segments.

     `ws/docs -> .git/hooks`, which a repository can carry and git will
     check out, turns a write to "docs/pre-commit" into a write to
     `.git/hooks/pre-commit`: the segments are "docs" and "pre-commit",
     neither of which is in the skip list, and `within(root, realParent)`
     passes because `.git/hooks` really is inside the root. The file lands,
     keeps its mode, and runs on the next commit.

     main.js refuses to forward a caller-supplied `exclude` for exactly this
     reason -- "a shorter skip list is a path into .git/hooks". This was a
     second path into the same place, and the only one reachable without
     changing the skip list at all. Found by an agent running inside zevet,
     2026-09-21. */
  if (hasSkippedSegment(root, target, folded)) {
    return { ok: false, error: "not a file this app will write" };
  }

  let existing = null;
  try {
    // lstat, never stat: the whole question is whether the NAME is a link, and
    // `stat` answers about the thing on the far end of it.
    existing = fs.lstatSync(target);
  } catch (err) {
    if (err.code !== "ENOENT" && err.code !== "ENOTDIR") {
      if (err.code === "EACCES" || err.code === "EPERM") {
        return { ok: false, error: "not allowed to write that file" };
      }
      return { ok: false, error: `cannot open that file: ${err.code || err.message}` };
    }
  }
  if (existing) {
    if (existing.isSymbolicLink()) return { ok: false, error: "that is a symlink" };
    if (existing.isDirectory()) return { ok: false, error: "that is a folder" };
    if (!existing.isFile()) return { ok: false, error: "not a regular file" };
  }

  // Preserved, not re-derived: an executable script that comes back 0644 after
  // one save is a broken repo, and nobody will connect it to having edited a
  // file. Windows has no POSIX mode to speak of, so this is close to a no-op
  // there beyond the read-only bit — which is the part that would be lost.
  const mode = existing ? existing.mode & 0o777 : undefined;

  // Same directory, always. A temp file in the OS temp dir would make this a
  // cross-device move, and a rename across devices is not atomic — it is not
  // even permitted (EXDEV). Same directory means one rename, which NTFS and
  // APFS both make atomic, so a reader sees either the whole old file or the
  // whole new one. Writing in place instead would mean a crash mid-write
  // leaves somebody's source truncated, which for an app whose promise is that
  // your code stays put is the one failure that would be unforgivable.
  //
  // The temp file is briefly visible to a tree walk. Accepted: it exists for
  // microseconds, and `listTree` is a snapshot of a moving disk anyway.
  const tmp = path.join(realParent, `${base}.zevet-${crypto.randomBytes(6).toString("hex")}.tmp`);

  let fd;
  try {
    // "wx" — fail if it somehow exists rather than clobber it. With 96 bits of
    // entropy that is unreachable; it is here so that if it ever does happen it
    // happens as an error and not as a lost file.
    fd = fs.openSync(tmp, "wx", mode === undefined ? 0o666 : mode);
    fs.writeSync(fd, buf, 0, buf.length, 0);
    // The bytes reach the disk BEFORE the rename publishes the name. Without
    // this, a power loss can leave the rename durable and the contents not --
    // an empty file where the source was, which is the exact outcome the
    // rename was chosen to prevent.
    //
    // NOT VERIFIED, and not verifiable from a test suite: this is the
    // documented contract of fsync, not something observed here. The directory
    // entry itself is NOT fsynced (that needs an fd on the directory, which
    // Windows does not hand out), so a crash in the microsecond after the
    // rename can still lose the rename on some filesystems. The old file
    // survives intact in that case, which is the acceptable half of the risk.
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // openSync's mode is filtered by the process umask, so an 0o755 original
    // can come back 0o755 & ~umask. The chmod is what actually preserves it.
    // Best-effort: on Windows this can fail for reasons that have nothing to
    // do with whether the write succeeded.
    if (mode !== undefined) {
      try {
        fs.chmodSync(tmp, mode);
      } catch {
        /* the contents matter more than the bits */
      }
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already on the way down */
      }
    }
    // A temp file must never outlive a failed write. Leaving `.zevet-*.tmp`
    // droppings in somebody's source tree after a full disk or a locked file
    // is a small thing that reads as a broken program.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* it may never have been created */
    }
    if (err.code === "EACCES" || err.code === "EPERM") return { ok: false, error: "not allowed to write that file" };
    if (err.code === "EBUSY") return { ok: false, error: "that file is open in another program" };
    if (err.code === "ENOSPC") return { ok: false, error: "no space left on the disk" };
    return { ok: false, error: `cannot write that file: ${err.code || err.message}` };
  }

  return {
    // What LANDED, not what was asked for. If the caller passed `bom` and
    // `eol` this is the confirmation; if it passed neither, this is the report
    // of what its own string happened to contain.
    ok: true,
    bytes: buf.length,
    bom: buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf,
    eol: dominantEol(body),
    created: existing === null,
  };
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
  writeTextFile,
  isProbablyRepo,
  // Exported so the UI can show the same numbers it is being limited by, and
  // so the tests assert against the real defaults instead of copies of them.
  DEFAULT_SKIP,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_BYTES,
};
