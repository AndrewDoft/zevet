// Watching the disk, because the disk is where the other author lives.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS AT ALL
//
// Everything else in this app assumes the human in the editor is the only one
// writing. They are not. Claude Code and Codex are editing the same files, on
// the same disk, while the editor has them open — that is the entire product.
// Without this module the sequence is: the agent rewrites `server.mjs`, the
// editor still holds the text it read ten minutes ago, the person types one
// character, the CRDT publishes ITS version, and the agent's work is gone with
// no error and no diff to blame. Silent clobbering is the worst failure this
// project has, and this file is the only thing standing in front of it.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ WHY THE DIRECTORY AND NOT THE FILE
//
// `fs.watch(file)` attaches to the INODE, not to the name. This repo's own
// `local-fs.js#writeTextFile` writes `foo.js.zevet-<hex>.tmp` and then renames
// it over `foo.js` — deliberately, so a crash mid-write cannot truncate
// somebody's source. After that rename the name `foo.js` points at a new
// inode and the watcher is still holding the old one: it goes permanently deaf
// and reports nothing, forever, with no error. Every serious editor and most
// tools (git, formatters, `sed -i`, Claude Code's own writer) use the same
// write-then-rename pattern, so a file watcher is deaf to almost everything
// that matters.
//
// Watching the containing DIRECTORY and filtering by basename survives that:
// the rename is itself a directory event, carrying the new name.
//
// Rejected alternatives, and why:
//   • `fs.watchFile` (stat polling). Works everywhere, survives renames, and
//     costs a stat per file per interval forever — on a tree with twenty tabs
//     open that is a permanent background load for a latency nobody wants
//     (the default interval is 5007ms; tightening it is what makes it cost).
//     Kept in mind as the fallback if `fs.watch` proves too unreliable in the
//     field, which has NOT been established either way yet.
//   • `chokidar`. It is the right answer to all of this and it is a
//     dependency. The desktop app has none beyond Electron, and every
//     dependency here runs with the user's full filesystem rights (see the
//     header of local-fs.js). Not worth it for one watcher.
//   • `recursive: true` on the workspace root. Not portable — it is supported
//     on Windows and macOS and NOT on Linux, where Node throws ERR_FEATURE_
//     UNAVAILABLE_ON_PLATFORM. One watcher per open file's directory is a
//     handful of watchers, which is affordable everywhere.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ WHAT IS RELIED ON, AND WHAT IS TAKEN ON FAITH
//
// VERIFIED ON THIS MACHINE (Windows 11, Node 22 / the gate suite in
// test/file-watch.test.mjs, run against real temp directories and real writes):
//   • a plain overwrite of a watched file produces a directory event naming it
//   • a temp-file-then-rename write — the real `writeTextFile` pattern —
//     produces a directory event naming the TARGET, so the change is seen
//   • events for other files in the same directory arrive and are filtered out
//   • a burst of ten writes coalesces to a single report at this debounce
//
// VERIFIED ON A REAL macOS RUNNER (GitHub Actions, 2026-09-19 — the first time
// any of this had executed on a Mac):
//   • the suite passes there, but only after the contents check in `fire`
//   • `filename` really is absent most of the time, exactly as the docs warn.
//     Three tests failed on the first Mac run because a write to a NEIGHBOURING
//     file produced a report for the watched one: the no-filename fallback
//     below woke every subscription in the directory, as designed, and nothing
//     downstream noticed the file was identical. See `fire` for the fix and why
//     comparing contents is free rather than a workaround.
//
// TAKEN ON FAITH, NOT RUN HERE, AND NOT CLAIMED:
//   • Linux/inotify. Never run here. inotify does name the file, so it should
//     look like Windows rather than like macOS — but that is a reading of the
//     documentation, not a result.
//   • Network drives, SMB shares, VirtualBox/WSL shared folders and Dropbox
//     folders. `fs.watch` is documented as unreliable on network filesystems
//     and simply does not fire on some of them. A user editing a repo on a
//     mapped drive may get NO change events at all, and this module has no way
//     to know that has happened. There is no fallback today; `watchFile`
//     polling is where one would go.
//   • Editors that write by truncate-in-place rather than rename. They should
//     produce a `change` event naming the file, which is the easier case, but
//     no such editor has been exercised against this.
//
// The honest summary: this is correct for the write patterns this repo
// produces on the platform it was developed on, and plausible elsewhere.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const localFs = require("./local-fs.js");
const { createHash } = require("node:crypto");

/**
 * How long to wait after the last event before re-reading.
 *
 * One save is several events — on Windows a rename alone can produce a pair,
 * and an agent rewriting a file can produce a dozen in a few milliseconds. The
 * debounce is TRAILING (every new event restarts the clock) rather than
 * leading, because reading on the FIRST event of a write-then-rename reads the
 * file as it was before the rename landed: the old text, reported as if it were
 * new. Waiting for quiet is the only way to read the settled file.
 *
 * 120ms is a compromise, not a measurement: below about 50ms the Windows
 * rename pair started arriving on either side of the window during
 * development; above ~200ms a person watching an agent work can feel it.
 */
const DEFAULT_DEBOUNCE_MS = 120;

/** Windows compares filenames case-insensitively; POSIX does not. Same rule as
 *  local-fs.js, kept here rather than imported because that one is not
 *  exported and duplicating four characters beats widening that module's API. */
const CASE_FOLD = process.platform === "win32";
function foldCase(p) {
  return CASE_FOLD ? p.toLowerCase() : p;
}

/** A cheap fingerprint of a file's contents, for "did this actually change?".
 *  sha256 rather than length-and-mtime: an agent that rewrites a file to the
 *  same length in the same second is not a hypothetical, it is a formatter. */
function digest(text) {
  return createHash("sha256").update(text ?? "", "utf8").digest("hex");
}

/**
 * A set of watched files, at most one `fs.watch` per containing directory.
 *
 * Deliberately Electron-free: it takes an `onChange` callback and nothing else,
 * so the gate can exercise it against real directories with real writes rather
 * than against an Electron harness that would itself need proving. `main.js`
 * is the only thing that knows this feeds a renderer.
 */
class FileWatch {
  /**
   * @param {{onChange?: (evt: {root:string, relPath:string, text:string,
   *          bytes:number, bom:boolean, eol:"crlf"|"lf"}) => void,
   *          debounceMs?: number}} [options]
   */
  constructor({ onChange, debounceMs = DEFAULT_DEBOUNCE_MS } = {}) {
    this.onChange = typeof onChange === "function" ? onChange : () => {};
    this.debounceMs = Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : DEFAULT_DEBOUNCE_MS;
    /** Subscriptions by (root, relPath), which is the identity a renderer uses. */
    this.subs = new Map();
    /** One entry per watched directory: `{ watcher, subs: Set }`. */
    this.dirs = new Map();
  }

  /** The key a renderer's (root, relPath) pair maps to. */
  static key(root, relPath) {
    return `${foldCase(path.resolve(String(root || "")))} ${foldCase(
      path.normalize(String(relPath || "")),
    )}`;
  }

  /**
   * Start reporting changes to one file.
   *
   * Idempotent: a second call for the same (root, relPath) is a no-op and
   * produces neither a second watcher nor a second event. The renderer opens
   * and re-opens tabs and must not have to track that.
   *
   * @returns {{ok: true} | {ok: false, error: string}}
   */
  watch(root, relPath) {
    const key = FileWatch.key(root, relPath);
    if (this.subs.has(key)) return { ok: true };

    // THE GUARD IS local-fs.js's, NOT A SECOND ONE WRITTEN HERE. A read is
    // attempted first and its refusal is returned verbatim, so anything the
    // read path will not open is also something this will not watch: outside
    // the workspace, a symlink leaving it, a folder, a binary, something too
    // big. Writing a parallel containment check here would be a second place
    // for that logic to be wrong, and the two would drift.
    const first = localFs.readTextFile(root, relPath, {});
    if (!first.ok) return { ok: false, error: first.error };

    // Where the bytes actually land. The read above already proved that the
    // resolved file is inside the root, and a directory containing a file that
    // is inside the root is itself inside the root, so this needs no further
    // check — it is a prefix of a path that has been checked.
    //
    // Resolved rather than lexical because a symlinked directory inside the
    // workspace writes into the TARGET directory, and that is where the events
    // are. (A symlink leaving the workspace never gets here: the read refused.)
    let real;
    try {
      real = fs.realpathSync(path.resolve(root, relPath));
    } catch (err) {
      // It existed a microsecond ago, for the read. Losing it between the two
      // calls is a race with a delete, not a defect.
      return { ok: false, error: `cannot watch that file: ${err.code || err.message}` };
    }
    const dir = path.dirname(real);
    const base = path.basename(real);

    const sub = {
      key,
      root: String(root),
      relPath: String(relPath),
      dir,
      base: foldCase(base),
      timer: null,
      // What this file looked like the last time anybody was told about it.
      // Seeded from the read above, so the first report is a real change and
      // not "here is the file you already have". See `fire`.
      lastHash: digest(first.text),
    };

    let entry = this.dirs.get(foldCase(dir));
    if (!entry) {
      let watcher;
      try {
        // `persistent: false` deliberately NOT set: while a file is open in the
        // editor, a pending change is worth keeping the process alive for, and
        // the process is an app with a window anyway. `recursive` is left off —
        // see the header for why it is not portable.
        watcher = fs.watch(dir, { persistent: true });
      } catch (err) {
        return { ok: false, error: `cannot watch that folder: ${err.code || err.message}` };
      }
      entry = { watcher, subs: new Set() };
      this.dirs.set(foldCase(dir), entry);

      watcher.on("change", (_eventType, filename) => this.onDirEvent(entry, filename));
      watcher.on("error", () => {
        // The directory was deleted or became unreadable. Every subscription
        // under it is dead — there is nothing left to re-read — so they are
        // dropped rather than left looking live. Silent because the renderer's
        // next read will fail with a real message about the real file, which
        // is more useful than "watcher error" from a module it cannot see.
        this.dropDir(entry);
      });
    }

    entry.subs.add(sub);
    this.subs.set(key, sub);
    // FSEvents starts asynchronously. A save between the initial read and
    // the native subscription becoming active may never generate an event.
    // Reconcile once after registration; the content hash suppresses unchanged
    // files. This also covers writes racing the initial read on other systems.
    this.schedule(sub);
    return { ok: true };
  }

  /** Stop reporting changes to one file. Returns `{ok:true}` even if it was
   *  never watched: the renderer closing a tab should not have to know. */
  unwatch(root, relPath) {
    const sub = this.subs.get(FileWatch.key(root, relPath));
    if (!sub) return { ok: true };
    this.subs.delete(sub.key);
    if (sub.timer) clearTimeout(sub.timer);
    sub.timer = null;
    const entry = this.dirs.get(foldCase(sub.dir));
    if (entry) {
      entry.subs.delete(sub);
      // The last file in a directory leaving takes the directory watcher with
      // it. An `fs.watch` handle is a real OS resource (an inotify watch, a
      // ReadDirectoryChangesW request) and leaking one per file ever opened is
      // how a long session runs out of them.
      if (entry.subs.size === 0) this.dropDir(entry);
    }
    return { ok: true };
  }

  /** Everything, on window close or quit. */
  closeAll() {
    for (const entry of [...this.dirs.values()]) this.dropDir(entry);
    this.dirs.clear();
    this.subs.clear();
  }

  /** How many files and directories are live. For tests and for nothing else. */
  get counts() {
    return { files: this.subs.size, dirs: this.dirs.size };
  }

  // ---- internals ----------------------------------------------------------

  dropDir(entry) {
    for (const sub of entry.subs) {
      if (sub.timer) clearTimeout(sub.timer);
      sub.timer = null;
      this.subs.delete(sub.key);
    }
    entry.subs.clear();
    try {
      entry.watcher.close();
    } catch {
      // Already closed, or the handle died with the directory.
    }
    for (const [k, v] of this.dirs) if (v === entry) this.dirs.delete(k);
  }

  onDirEvent(entry, filename) {
    // `filename` is documented as possibly null — it is not always provided on
    // every platform, and macOS in particular is called out. When it is
    // missing the only safe reading is "something in this directory changed",
    // so every subscription in it is woken. That is a handful of re-reads of
    // files that are open in tabs, not a tree walk, and the debounce still
    // collapses a burst. Guessing "probably not mine" would be the version
    // that loses an agent's edit.
    const name = filename === null || filename === undefined ? null : foldCase(String(filename));
    for (const sub of entry.subs) {
      // macOS may name the watched directory itself, rather than a child.
      // Treat that as a directory-wide hint, just like an absent filename.
      if (name === null || name === sub.base || name === foldCase(path.basename(sub.dir))) this.schedule(sub);
    }
  }

  schedule(sub) {
    if (sub.timer) clearTimeout(sub.timer);
    sub.timer = setTimeout(() => {
      sub.timer = null;
      this.fire(sub);
    }, this.debounceMs);
  }

  fire(sub) {
    // Still subscribed? A close during the debounce window must not produce an
    // event for a tab that is gone.
    if (!this.subs.has(sub.key)) return;
    const read = localFs.readTextFile(sub.root, sub.relPath, {});
    if (!read.ok) {
      // A DELETE IS NOT REPORTED, and that is a gap rather than a decision I am
      // pleased with. The contract this feeds (`onFileChanged`) carries text,
      // and there is no text to carry; inventing an empty string would tell the
      // editor to publish an empty document into the shared CRDT, which is the
      // clobber this whole module exists to prevent. So a deleted or
      // now-unreadable file goes quiet and the renderer finds out on its next
      // tree refresh or save. If deletion needs to reach the editor, it needs a
      // field in the contract, and the contract is shared with another author.
      return;
    }

    // ⚠️ NOTHING IS REPORTED UNLESS THE CONTENTS ACTUALLY CHANGED, and this is
    // load-bearing on macOS.
    //
    // `onDirEvent` deliberately wakes EVERY subscription in a directory when
    // the OS hands it no filename — guessing "probably not mine" is how an
    // agent's edit gets lost. On Windows that fallback almost never fires,
    // because the filename is always there. On macOS, FSEvents coalesces and
    // Node often reports nothing, so every write anywhere in a folder woke
    // every file open in it: a neighbouring file being touched pushed a
    // "changed" event at an editor whose document had not changed, which the
    // renderer then folds into the shared CRDT.
    //
    // MEASURED, on a real macOS runner: three tests in the suite failed there
    // and had never run on a Mac before — a write to `theirs.txt` produced a
    // report for `mine.txt`. Comparing contents makes the conservative wake-up
    // free: it costs a read that was happening anyway, it cannot lose an edit
    // (identical bytes are not an edit), and it makes the three platforms
    // behave the same way for the same reason.
    const hash = digest(read.text);
    if (hash === sub.lastHash) return;
    sub.lastHash = hash;

    this.onChange({
      root: sub.root,
      relPath: sub.relPath,
      text: read.text,
      bytes: read.bytes,
      // Carried through because `writeTextFile` takes them back: a file read
      // with a BOM and CRLF must be saved with a BOM and CRLF or the next
      // commit blames whoever pressed save for a whole-file diff.
      bom: read.bom,
      eol: read.eol,
    });
  }
}

module.exports = { FileWatch, DEFAULT_DEBOUNCE_MS };
