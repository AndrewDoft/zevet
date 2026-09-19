// desktop/file-watch.js — against a real filesystem, with real writes.
//
// NOTHING IS MOCKED HERE, and that is the whole point. This module exists
// because `fs.watch` behaves in specific awkward ways — it watches inodes, it
// fires several times for one save, it reports a rename as a directory event —
// and a fake `fs` would be a fake of my own beliefs about those behaviours
// rather than evidence about them. Every case below builds a directory in the
// OS temp dir, writes files into it the way the app really writes them, and
// waits for what actually arrives.
//
// ⚠️ WHAT THESE TESTS ESTABLISH IS PLATFORM-LOCAL. They were written and run on
// Windows 11. They will run on macOS and Linux and I have not run them there;
// if the coalescing case is ever seen to be flaky on another platform, the
// honest fix is to widen the assertion and say so, not to raise the timeout
// until it passes.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { FileWatch, DEFAULT_DEBOUNCE_MS } = require("../desktop/file-watch.js");
const localFs = require("../desktop/local-fs.js");

/**
 * The debounce the cases below run at.
 *
 * Shorter than the shipped default so the suite is not dominated by waiting,
 * but not so short that the Windows rename pair straddles it — which is the
 * failure the shipped 120ms is sized against. The coalescing case uses the
 * real default instead, because that is the number whose behaviour is being
 * claimed in the module header.
 */
const DEBOUNCE = 60;

/** How long an event is given to arrive before a case gives up on it.
 *  Generous: `fs.watch` latency is not bounded by anything documented, and a
 *  loaded CI box is slower than a laptop. A test that waits is fine; a test
 *  that flakes teaches everyone to ignore red. */
const ARRIVE_MS = 4000;

/** How long a case waits to be sure something is NOT coming. Necessarily a
 *  guess — absence cannot be proven — and deliberately several times the
 *  debounce so it is absence rather than impatience. */
const QUIET_MS = 700;

function tempRoot() {
  // realpath'd so the module's own realpath of the file agrees with the root
  // it is checked against (/var → /private/var on macOS, 8.3 names on Windows).
  return realpathSync(mkdtempSync(path.join(tmpdir(), "zevet-watch-")));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, ms = ARRIVE_MS) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(10);
  }
}

describe("file-watch: seeing what an agent did on disk", () => {
  let root;
  let seen;
  let fw;

  beforeEach(() => {
    root = tempRoot();
    seen = [];
    fw = new FileWatch({ onChange: (e) => seen.push(e), debounceMs: DEBOUNCE });
  });

  afterEach(() => {
    fw.closeAll();
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  });

  test("a change to the watched file is reported, once, with the new text", async () => {
    writeFileSync(path.join(root, "a.txt"), "before\n");
    assert.deepEqual(fw.watch(root, "a.txt"), { ok: true });

    writeFileSync(path.join(root, "a.txt"), "after\n");

    assert.ok(await waitFor(() => seen.length >= 1), "no change was ever reported");
    await sleep(QUIET_MS); // let any second report show up rather than be missed
    assert.equal(seen.length, 1, `expected one report, got ${seen.length}`);
    assert.equal(seen[0].relPath, "a.txt");
    assert.equal(seen[0].root, root);
    assert.equal(seen[0].text, "after\n");
    assert.equal(seen[0].bytes, 6);
  });

  test("the payload carries bom and eol, so a save can put the file back as it was", async () => {
    // A file that really does have both, because these fields exist to survive
    // a round trip and a test with an LF no-BOM file would prove nothing.
    writeFileSync(path.join(root, "win.txt"), "﻿one\r\ntwo\r\n");
    fw.watch(root, "win.txt");
    writeFileSync(path.join(root, "win.txt"), "﻿one\r\ntwo\r\nthree\r\n");

    assert.ok(await waitFor(() => seen.length >= 1), "no change was reported");
    assert.equal(seen[0].bom, true);
    assert.equal(seen[0].eol, "crlf");
    // The BOM is stripped from `text` by readTextFile and reported as a flag;
    // asserted here so a change to that contract cannot pass quietly.
    assert.equal(seen[0].text.charCodeAt(0), "o".charCodeAt(0));
  });

  test("a temp-file-then-rename write is still reported — the case that motivates watching the folder", async () => {
    // THE REAL WRITER, not an imitation of it. `writeTextFile` creates
    // `x.txt.zevet-<hex>.tmp`, fsyncs it and renames it over the target, which
    // replaces the inode. A watcher attached to the file would be deaf from
    // here on; this asserts the directory watch is not.
    writeFileSync(path.join(root, "x.txt"), "one\n");
    fw.watch(root, "x.txt");

    const wrote = localFs.writeTextFile(root, "x.txt", "two\n", {});
    assert.equal(wrote.ok, true, wrote.error);
    // Belt and braces: confirm the writer really did use a temp file and clean
    // it up, so this case cannot quietly become a plain-overwrite test if that
    // implementation ever changes.
    assert.deepEqual(
      readdirSync(root).filter((n) => n.includes(".zevet-")),
      [],
      "a temp file was left behind",
    );

    assert.ok(await waitFor(() => seen.length >= 1), "the rename was not seen");
    assert.equal(seen[seen.length - 1].text, "two\n");

    // And again, to prove the watcher did not go deaf after the FIRST inode
    // swap — which is exactly how the file-watching version of this fails.
    seen.length = 0;
    localFs.writeTextFile(root, "x.txt", "three\n", {});
    assert.ok(await waitFor(() => seen.length >= 1), "the second rename was not seen");
    assert.equal(seen[seen.length - 1].text, "three\n");
  });

  test("a change to a different file in the same directory is not reported", async () => {
    writeFileSync(path.join(root, "mine.txt"), "mine\n");
    writeFileSync(path.join(root, "theirs.txt"), "theirs\n");
    fw.watch(root, "mine.txt");

    writeFileSync(path.join(root, "theirs.txt"), "theirs, changed\n");
    // The watch is on the whole directory, so this event IS delivered to the
    // module and must be filtered by basename. Anything less and every open
    // tab reloads whenever any neighbouring file moves — which, with an agent
    // working, is constantly.
    await sleep(QUIET_MS);
    assert.equal(seen.length, 0, `a neighbouring file produced ${seen.length} report(s)`);

    // ...and the subscription is still alive after having ignored it.
    writeFileSync(path.join(root, "mine.txt"), "mine, changed\n");
    assert.ok(await waitFor(() => seen.length >= 1), "the watched file stopped being reported");
  });

  test("two files in one directory share a single watcher and report separately", async () => {
    writeFileSync(path.join(root, "a.txt"), "a\n");
    writeFileSync(path.join(root, "b.txt"), "b\n");
    fw.watch(root, "a.txt");
    fw.watch(root, "b.txt");
    assert.deepEqual(fw.counts, { files: 2, dirs: 1 }, "one directory should mean one OS watcher");

    writeFileSync(path.join(root, "b.txt"), "b2\n");
    assert.ok(await waitFor(() => seen.length >= 1));
    assert.equal(seen[0].relPath, "b.txt");
  });

  test("watching twice does not produce two watchers or two events", async () => {
    writeFileSync(path.join(root, "a.txt"), "one\n");
    assert.deepEqual(fw.watch(root, "a.txt"), { ok: true });
    assert.deepEqual(fw.watch(root, "a.txt"), { ok: true });
    // Same file, different spelling of the same relative path: still one.
    assert.deepEqual(fw.watch(root, "./a.txt"), { ok: true });
    assert.deepEqual(fw.counts, { files: 1, dirs: 1 });

    writeFileSync(path.join(root, "a.txt"), "two\n");
    assert.ok(await waitFor(() => seen.length >= 1));
    await sleep(QUIET_MS);
    assert.equal(seen.length, 1, `one write produced ${seen.length} reports`);
  });

  test("unwatch stops it, and closeAll leaves nothing behind", async () => {
    writeFileSync(path.join(root, "a.txt"), "one\n");
    writeFileSync(path.join(root, "b.txt"), "one\n");
    fw.watch(root, "a.txt");
    fw.watch(root, "b.txt");

    assert.deepEqual(fw.unwatch(root, "a.txt"), { ok: true });
    assert.deepEqual(fw.counts, { files: 1, dirs: 1 });

    writeFileSync(path.join(root, "a.txt"), "two\n");
    await sleep(QUIET_MS);
    assert.equal(seen.length, 0, "an unwatched file was still reported");

    // The other subscription is untouched by the first one leaving.
    writeFileSync(path.join(root, "b.txt"), "two\n");
    assert.ok(await waitFor(() => seen.length >= 1), "unwatching one file killed the other");

    fw.closeAll();
    assert.deepEqual(fw.counts, { files: 0, dirs: 0 });
    seen.length = 0;
    writeFileSync(path.join(root, "b.txt"), "three\n");
    await sleep(QUIET_MS);
    assert.equal(seen.length, 0, "a report arrived after closeAll");

    // Unwatching something that was never watched is not an error: a renderer
    // closing a tab should not have to remember whether it opened a watch.
    assert.deepEqual(fw.unwatch(root, "never.txt"), { ok: true });
  });

  test("a report scheduled before unwatch does not fire after it", async () => {
    writeFileSync(path.join(root, "a.txt"), "one\n");
    fw.watch(root, "a.txt");
    writeFileSync(path.join(root, "a.txt"), "two\n");
    // Inside the debounce window, so the timer is very likely already pending.
    fw.unwatch(root, "a.txt");
    await sleep(QUIET_MS);
    assert.equal(seen.length, 0, "a closed tab was still told about a change");
  });

  test("a burst of ten writes coalesces", async () => {
    // WHAT IS AND IS NOT GUARANTEED. The debounce is trailing: each event
    // restarts a 120ms clock, so any burst whose events are less than 120ms
    // apart produces exactly ONE report. Ten synchronous writes are far inside
    // that, and one report is what is observed on this machine (Windows 11).
    // It is NOT a guarantee in general: a scheduler stall, a slow network
    // filesystem or an agent writing at 5Hz can drop a gap larger than the
    // window into the middle of a burst and produce two. The invariant that
    // holds regardless — and the one the editor actually depends on — is that
    // the LAST report carries the FINAL contents, never a stale intermediate.
    const burst = new FileWatch({ onChange: (e) => seen.push(e), debounceMs: DEFAULT_DEBOUNCE_MS });
    try {
      writeFileSync(path.join(root, "hot.txt"), "0\n");
      burst.watch(root, "hot.txt");
      for (let i = 1; i <= 10; i++) writeFileSync(path.join(root, "hot.txt"), `${i}\n`);

      assert.ok(await waitFor(() => seen.length >= 1), "a burst produced no report at all");
      await sleep(QUIET_MS);
      assert.ok(
        seen.length <= 2,
        `ten writes produced ${seen.length} reports — the debounce is not coalescing`,
      );
      assert.equal(seen[seen.length - 1].text, "10\n", "the last report is not the final contents");
    } finally {
      burst.closeAll();
    }
  });

  test("it refuses exactly what the read path refuses, and refuses it the same way", async () => {
    // The containment guard is local-fs.js's, reused rather than reimplemented.
    // These assert the REFUSAL TEXT, not merely `ok:false`: a traversal that
    // happens to point at a missing file is also `ok:false`, so a test checking
    // the boolean alone would pass with the guard removed.
    mkdirSync(path.join(root, "sub"), { recursive: true });
    writeFileSync(path.join(root, "sub", "ok.txt"), "fine\n");

    assert.deepEqual(fw.watch(root, "../outside.txt"), { ok: false, error: "outside the workspace" });
    assert.deepEqual(fw.watch(root, "missing.txt"), { ok: false, error: "no such file" });
    assert.deepEqual(fw.watch(root, "sub"), { ok: false, error: "that is a folder" });

    writeFileSync(path.join(root, "blob.bin"), Buffer.from([0x41, 0x00, 0x42]));
    assert.deepEqual(fw.watch(root, "blob.bin"), { ok: false, error: "looks binary" });

    // None of those left a watcher behind.
    assert.deepEqual(fw.counts, { files: 0, dirs: 0 });

    // And a file in a subdirectory is watched in ITS directory, which is a
    // second OS watcher and not the root's.
    assert.deepEqual(fw.watch(root, "sub/ok.txt"), { ok: true });
    assert.deepEqual(fw.counts, { files: 1, dirs: 1 });
    writeFileSync(path.join(root, "sub", "ok.txt"), "changed\n");
    assert.ok(await waitFor(() => seen.length >= 1), "a file in a subdirectory was not watched");
    assert.equal(seen[0].relPath, "sub/ok.txt");
  });
});
