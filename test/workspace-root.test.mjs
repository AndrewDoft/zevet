// "not an opened workspace" must not reach a person who did nothing wrong.
// desktop/workspace-root.js is the pure guard main.js's knownRoot delegates to;
// board/src/lib/workspace-root.mjs is how the board treats a refusal.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { resolveKnown, NOT_OPEN } = require(path.join(ROOT, "desktop", "workspace-root.js"));
const agentSessions = require(path.join(ROOT, "desktop", "agent-sessions.js"));
const board = await import(pathToFileURL(path.join(ROOT, "board", "src", "lib", "workspace-root.mjs")).href);
const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");

const tmp = mkdtempSync(path.join(os.tmpdir(), "ws-root-"));
const A = path.join(tmp, "repoA");
const WT = path.join(tmp, "wt-a"); // a linked worktree of A
const OTHER_ORIGIN = path.join(tmp, "repoB");
const WT_B = path.join(tmp, "wt-b"); // a linked worktree of B (never opened)
const UNRELATED = path.join(tmp, "unrelated");
for (const [origin, wt, name] of [[A, WT, "wt-a"], [OTHER_ORIGIN, WT_B, "wt-b"]]) {
  mkdirSync(path.join(origin, ".git", "worktrees", name), { recursive: true });
  writeFileSync(path.join(origin, ".git", "worktrees", name, "commondir"), "../..\n");
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, ".git"), "gitdir: " + path.join(origin, ".git", "worktrees", name) + "\n");
}
mkdirSync(path.join(A, "apps", "web"), { recursive: true });
mkdirSync(UNRELATED, { recursive: true });
const known = (root, ws = [A]) => resolveKnown(root, ws, agentSessions.originOf);

describe("resolveKnown: what a renderer may name as a root", () => {
  test("an opened workspace, a subfolder of it, and a worktree of it are known", () => {
    assert.equal(known(A), path.resolve(A));
    assert.equal(known(path.join(A, "apps", "web")), path.resolve(A, "apps", "web"));
    assert.equal(known(WT), path.resolve(WT));
  });

  test("an unrelated folder is still refused", () => {
    assert.equal(known(UNRELATED), null);
    assert.equal(known(tmp), null, "a parent of a workspace is wider, not known");
    assert.equal(known(path.parse(tmp).root), null);
  });

  test("a worktree whose origin is NOT opened is refused", () => {
    assert.equal(known(WT_B), null);
    assert.equal(known(WT_B, [A]), null);
    assert.equal(known(WT_B, [OTHER_ORIGIN]), path.resolve(WT_B));
  });

  test("a lookalike prefix and a .. escape are refused", () => {
    mkdirSync(A + "-evil", { recursive: true });
    assert.equal(known(A + "-evil"), null);
    assert.equal(known(path.join(A, "..", "unrelated")), null);
  });

  test("empty, null and nothing opened are refused", () => {
    assert.equal(known(""), null);
    assert.equal(known(null), null);
    assert.equal(known(A, []), null);
    // path.resolve("") is the process cwd: an empty root must not pass because the app happens to run in a workspace.
    const cwdOpen = [process.cwd()];
    for (const r of ["", "   ", null, undefined]) assert.equal(resolveKnown(r, cwdOpen, () => ""), null, JSON.stringify(r));
  });
});

describe("main.js", () => {
  const main = read("desktop", "main.js");
  test("knownRoot delegates to resolveKnown over the opened workspaces and agentSessions.originOf", () => {
    assert.match(main, /function knownRoot\(root\) \{\s*return resolveKnown\(root, readWorkspaces\(\), agentSessions\.originOf\);\s*\}/);
  });
  test("the refusal text main replies with is the one the board matches", () => {
    assert.ok(main.includes('error: "not an opened workspace"'));
    assert.equal(NOT_OPEN, "not an opened workspace");
    assert.equal(NOT_OPEN, board.NOT_OPEN);
  });
  test("workspace-root.js ships in the package", () => {
    assert.ok(JSON.parse(read("desktop", "package.json")).payload.files.includes("workspace-root.js"));
  });
});

describe("board: a refused root is not an error to show", () => {
  const src = read("board", "src", "lib", "board.ts");

  test("isNotOpen matches only the bare refusal", () => {
    assert.equal(board.isNotOpen({ ok: false, error: NOT_OPEN }), true);
    assert.equal(board.isNotOpen({ ok: false, error: "EACCES: permission denied" }), false);
    assert.equal(board.isNotOpen({ ok: true }), false);
    assert.equal(board.isNotOpen(null), false);
  });

  test("shownError never prints the internal text, and keeps real failures", () => {
    assert.ok(!board.shownError(NOT_OPEN, "x").includes("opened workspace"));
    assert.equal(board.shownError("EACCES: permission denied", "x"), "EACCES: permission denied");
    assert.equal(board.shownError(undefined, "could not start"), "could not start");
  });

  test("a tree load refused as not-open unsets the root instead of setting localError", () => {
    const at = src.indexOf("} else if (isNotOpen(r)) {");
    assert.ok(at > 0, "tree callback must branch on isNotOpen");
    const branch = src.slice(at, src.indexOf("} else {", at));
    assert.match(branch, /unsetLocalRoot\(\)/);
    assert.ok(!/localError/.test(branch), "the refused branch must not touch localError");
    assert.match(src.slice(at, at + 900), /localError: \(r && r\.error\) \|\| "could not read that folder"/, "real failures keep their own message");
  });

  test("start and resume failures go through shownError", () => {
    assert.equal((src.match(/shownError\(r && r\.error, "could not (start|continue)"\)/g) || []).length, 3);
  });

  // No folder open: nothing that needs one may call the bridge with a null root.
  for (const [name, call] of [
    ["openLocalFile", "br.read(root, relPath)"],
    ["refreshCommits", "br.commits(root, 200)"],
    ["refreshAgentSettings", "br.agentSettings(root)"],
    ["saveAgentSettings", "br.saveAgentSettings(root, patch)"],
    ["refreshMemories", "br.memories(root)"],
    ["refreshStats", "bridge.local.stats(root, paths)"],
    ["refreshAgentLine", "br.diffHunks(g.localRoot, e.relPath)"],
    ["startAgent", "br.startAgent(name, root,"],
  ]) {
    test(`${name} checks for a root before calling the bridge`, () => {
      const callAt = src.indexOf(call);
      assert.ok(callAt > 0, `${call} not found`);
      const before = src.slice(Math.max(0, callAt - 4000), callAt);
      const guard = Math.max(before.lastIndexOf("!root"), before.lastIndexOf("!g.localRoot"));
      assert.ok(guard >= 0, `${name}: no null-root guard ahead of ${call}`);
    });
  }
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
