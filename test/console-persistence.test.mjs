import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resumableEntries, write, read } from "../desktop/console-persistence.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("console persistence", () => {
  test("round trips only resumable Claude metadata atomically", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zevet-resume-"));
    const file = path.join(dir, "resume.json");
    const entries = [
      { id: "same", agent: "claude", root: "r", cwd: "w", worktree: "w", model: "m", mode: "auto", engine: "e", label: "l", sessionId: "sid", state: "working", running: true, worktreeRecord: { dir: "w", branch: "zevet/x" } },
      { id: "no", agent: "codex", running: true, sessionId: "x" },
      { id: "dead", agent: "claude", running: false, sessionId: "x" },
    ];
    assert.deepEqual(resumableEntries(entries), [{ id: "same", agent: "claude", cwd: "w", root: "r", worktree: "w", model: "m", mode: "auto", engine: "e", label: "l", worktreeRecord: { dir: "w", branch: "zevet/x" }, sessionId: "sid", inFlight: true }]);
    write(file, entries);
    assert.deepEqual(read(file), resumableEntries(entries));
    assert.equal(fs.existsSync(`${file}.${process.pid}.tmp`), false);
  });

  test("main.js restores before pruning, in place, and releases nothing mid-swap", () => {
    const main = fs.readFileSync(new URL("../desktop/main.js", import.meta.url), "utf8");
    assert.match(main, /async function releasePlacement\(p\) \{\s*if \(relaunching\) return;/);
    assert.match(main, /relaunching = true;\s*for \(const c of consoles\.values\(\)\)/);
    assert.match(main, /restoreResumableConsoles\(\)\.finally\(\(\) =>\s*worktrees\.prune\(new Set/);
    assert.match(main, /restorePlace: \{ root: s\.root, worktree: s\.worktreeRecord \|\| null \}/);
    assert.match(main, /const place = restorePlace\s*\?/);
  });
});
