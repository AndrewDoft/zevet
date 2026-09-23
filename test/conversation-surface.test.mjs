import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

describe("IDE main surface", () => {
  test("conversation actions replace detail until a file is selected", async () => {
    const view = await import(
      pathToFileURL(path.join(ROOT, "board", "src", "lib", "view.mjs")).href
    );

    assert.deepEqual(view.showConversation(), {
      conversationOpen: true,
      selectedPath: null,
    });
    assert.equal(view.mainSurface("ide", null, true), "conversation");

    assert.deepEqual(view.showFile("src/App.tsx"), {
      conversationOpen: false,
      selectedPath: "src/App.tsx",
    });
    assert.equal(view.mainSurface("ide", "src/App.tsx", true), "detail");
    assert.equal(view.mainSurface("ide", null, false), "detail");
    assert.equal(view.mainSurface("agent", null, false), "conversation");
  });

  test("every conversation entry point uses the shared transition", () => {
    const board = readFileSync(path.join(ROOT, "board", "src", "lib", "board.ts"), "utf8");
    for (const action of ["openLauncher", "setActiveConsole", "openSession", "openSessionAgent"]) {
      const start = board.lastIndexOf(`\n  ${action}:`);
      assert.notEqual(start, -1, `${action} is missing`);
      const rest = board.slice(start + 1);
      const next = rest.slice(1).search(/\n  [A-Za-z]\w*:/);
      const nextAction = next === -1 ? board.length : start + 2 + next;
      assert.match(board.slice(start, nextAction), /showConversation\(\)/, `${action} must show the conversation`);
    }
  });
});

describe("the rail's repo", () => {
  test("follows the thread in front to its repo, and only on a move", async () => {
    const { repoToFollow } = await import(
      pathToFileURL(path.join(ROOT, "board", "src", "lib", "view.mjs")).href
    );
    // Thread from A opened while B is showing: A.
    assert.equal(repoToFollow("C:/b", "C:/a", "C:/b"), "C:/a");
    // Already showing it: nothing to do.
    assert.equal(repoToFollow("C:/b", "C:/a", "C:/a"), null);
    // Same thread in front, folder picked by hand: the pick stands.
    assert.equal(repoToFollow("C:/a", "C:/a", "C:/b"), null);
    // No thread in front (a new one being started): leave it.
    assert.equal(repoToFollow("C:/a", null, "C:/b"), null);
  });

  test("board.ts wires it to the thread in front", () => {
    const board = readFileSync(path.join(ROOT, "board", "src", "lib", "board.ts"), "utf8");
    assert.match(board, /repoToFollow\(frontRoot, root, s\.localRoot\)[\s\S]{0,120}openLocalRoot\(follow\)/);
  });
});
