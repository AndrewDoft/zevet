import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resumableEntries, resumedIdentity, write, read } from "../desktop/console-persistence.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("console persistence", () => {
  test("round trips only resumable Claude metadata atomically", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zevet-resume-"));
    const file = path.join(dir, "resume.json");
    const entries = [
      { id: "same", agent: "claude", root: "r", cwd: "w", worktree: "w", model: "m", mode: "auto", engine: "e", label: "l", sessionId: "sid", state: "working", running: true, worktreeRecord: { dir: "w", branch: "zevet/x" } },
      { id: "cx", agent: "codex", cwd: "w", root: "r", running: true, sessionId: "thr", state: "idle" },
      { id: "oc", agent: "opencode", cwd: "w", root: "r", running: true, sessionId: "ses", state: "idle" },
      { id: "no", agent: "gemini", running: true, sessionId: "x" },
      { id: "nosid", agent: "codex", running: true },
      { id: "dead", agent: "claude", running: false, sessionId: "x" },
    ];
    assert.deepEqual(resumableEntries(entries).map((e) => e.id), ["same", "cx", "oc"], "claude, codex and opencode are saved; an unknown agent or a missing session id is not");
    assert.deepEqual(resumableEntries(entries).slice(0, 1), [{ id: "same", agent: "claude", cwd: "w", root: "r", worktree: "w", model: "m", mode: "auto", engine: "e", label: "l", worktreeRecord: { dir: "w", branch: "zevet/x" }, sessionId: "sid", inFlight: true }]);
    write(file, entries);
    assert.deepEqual(read(file), resumableEntries(entries));
    assert.equal(fs.existsSync(`${file}.${process.pid}.tmp`), false);
  });

  test("main.js restores before pruning, in place, and releases nothing mid-swap", () => {
    const main = fs.readFileSync(new URL("../desktop/main.js", import.meta.url), "utf8");
    assert.match(main, /async function releasePlacement\(p, \{ integrate = false \} = \{\}\) \{\s*if \(relaunching\) return;/);
    assert.match(main, /relaunching = true;\s*for \(const c of consoles\.values\(\)\)/);
    assert.match(main, /restoreResumableConsoles\(\)\.finally\(\(\) =>\s*worktrees\.prune\(new Set/);
    assert.match(main, /restorePlace: \{ root: s\.root, worktree: s\.worktreeRecord \|\| null \}/);
    assert.match(main, /const place = restorePlace\s*\?/);
  });

  test("a continued console keeps its id and label; a live process's id is never reused", () => {
    assert.deepEqual(resumedIdentity({ running: false, label: "zv-int126" }, "b3645999", { model: "m" }), { id: "b3645999", label: "zv-int126" });
    assert.deepEqual(resumedIdentity({ running: false, label: "old" }, "b3645999", { label: "named" }), { id: "b3645999", label: "named" });
    assert.deepEqual(resumedIdentity({ running: true, label: "x" }, "live", {}), { id: "", label: "" });
    assert.deepEqual(resumedIdentity(undefined, "gone", {}), { id: "", label: "" });
    assert.deepEqual(resumedIdentity(null, "", {}), { id: "", label: "" });
  });

  test("main.js resumeAgent starts under the continued id and label, and does not stop the replacement", () => {
    const main = fs.readFileSync(new URL("../desktop/main.js", import.meta.url), "utf8");
    assert.match(main, /consolePersistence\.resumedIdentity\(continues \? consoleLog\.get\(continues\) : null, continues, opts\)/);
    assert.match(main, /\.\.\.\(kept\.id \? \{ id: kept\.id \} : \{\}\),\s*agent: String\(agent \|\| ""\)/);
    assert.match(main, /const prev = kept\.id \? null : consoles\.get\(continues\)/);
  });
});
