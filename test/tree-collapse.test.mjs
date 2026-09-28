// The file tree's fold/resize handle, and the button that replaces it once
// closed. Andrew: "there is some button or icon in zevet behind the filetree
// in line with the follow selector, and it seems to do nothing" — that was
// `#treeToggle` (App.tsx), whose row is wider than the 180px rail at a narrow
// window (see the max-width: 1100px rule in masora.css and layout.test.mjs's
// note that Andrew's own window is ~830 CSS px), so the button painted behind
// the treecol next to it in DOM order and could never be clicked.
//
// Fix: the button is gone. The tree still folds (`treeHidden`, unchanged) and
// still has the keyboard shortcut, but the two ways left to work it are the
// drag handle (dragging it shut, all the way to zero) and a new "Open tree"
// button beside the repo picker in the rail, shown only while it is shut.
//
// No jsdom in this repo (see test/dead-buttons.test.mjs's note); these are
// source assertions, same style as test/prefs-persist.test.mjs and
// test/layout.test.mjs.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const src = (rel) => readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");
const board = src("board/src/lib/board.ts");
const app = src("board/src/App.tsx");
const strip = src("board/src/components/strip.tsx");
const css = src("board/src/styles/masora.css");

describe("the stray control behind the tree is gone", () => {
  test("App.tsx no longer defines or renders a TreeToggle button", () => {
    assert.ok(!/function TreeToggle/.test(app), "TreeToggle's definition is still here");
    assert.ok(!/<TreeToggle/.test(app), "TreeToggle is still rendered");
    assert.ok(!/id="treeToggle"/.test(app), "the #treeToggle button markup is still here");
  });

  test("its dead CSS went with it", () => {
    assert.ok(!/\.tree-toggle\b/.test(css), "the .tree-toggle rules are still in masora.css");
  });

  test("the underlying fold state is untouched — treeHidden still drives --tree:0 and still folds/unfolds", () => {
    assert.match(board, /toggleTree:\s*\(\)\s*=>\s*get\(\)\.setTreeHidden\(!get\(\)\.treeHidden\)/);
    assert.match(css, /body\[data-tree="hidden"\]\s*\{\s*--tree:\s*0px;\s*\}/);
  });
});

describe("dragging the tree's edge fully shut", () => {
  test("only the tree pane snaps closed, at half its own floor — the rail has no hidden state to snap to", () => {
    assert.match(
      board,
      /if \(pane === "tree" && raw < lim\[0\] \/ 2\) \{/,
      "the tree-only snap-closed branch in buildSplits's pointerdown handler is missing",
    );
  });

  test("snapping closed calls setTreeHidden, not setPanes — so panes.tree (the last open width) is left alone", () => {
    const start = board.indexOf('if (pane === "tree" && raw < lim[0] / 2) {');
    assert.ok(start >= 0);
    const branch = board.slice(start, board.indexOf("} else {", start));
    assert.match(branch, /setTreeHidden\(true\)/);
    assert.ok(!/setPanes/.test(branch), "the closed branch also wrote panes.tree, so the last open width would not survive");
  });

  test("dragging back out past that point reopens it before resuming the normal clamp", () => {
    const start = board.indexOf("} else {", board.indexOf('if (pane === "tree" && raw < lim[0] / 2) {'));
    const branch = board.slice(start, board.indexOf("applyPanes();", start));
    assert.match(branch, /setTreeHidden\(false\)/);
    assert.match(branch, /clampPaneWidth\(raw, lim\[0\], lim\[1\]\)/);
  });
});

describe("setTreeHidden persists like every other board pref", () => {
  test("it writes the same zevet.* pref toggleTree used to, not just in-memory state", () => {
    assert.match(
      board,
      /setTreeHidden:\s*\(hidden\)\s*=>\s*\{\s*setPref\("treeHidden",\s*hidden \? "1" : "0"\);\s*set\(\{\s*treeHidden:\s*hidden\s*\}\);/,
    );
  });

  test("panes.tree (the last open width) already persists through the existing PANE_KEY mirror — setPanes is untouched", () => {
    assert.match(board, /zStorage\.setItem\(PANE_KEY, JSON\.stringify\(p\)\)/);
  });
});

describe('"Open tree" replaces it, beside the repo picker', () => {
  test("rendered only on desktop, and only while the tree is hidden", () => {
    assert.match(strip, /if \(bridge\.local && treeHidden\) \{/);
  });

  test("label only, no caption — zevet style", () => {
    const at = strip.indexOf("if (bridge.local && treeHidden) {");
    const block = strip.slice(at, strip.indexOf("}", strip.indexOf("</Seg>", at)));
    assert.match(block, />\s*Open tree\s*</);
    assert.ok(!/<p>|<span>.*Open tree.*<\/span>.*<span>/.test(block), "a second line of copy crept in beside the label");
  });

  test("clicking it calls setTreeHidden(false), restoring the width panes.tree already held", () => {
    assert.match(strip, /onClick=\{\(\) => setTreeHidden\(false\)\}/);
  });
});
