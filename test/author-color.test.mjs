// Change colour = author colour. A teammate's additions and +N are THEIR
// --who colour, removals and −N a darker/muted variant of it, your own changes
// are your colour too, and only an author the roster has never heard of falls
// back to green/red. One helper (board/src/lib/authorcolor.mjs) makes the
// tokens; every surface spreads them and uses .d-add/.d-del.
//
// Three things are pinned: the helper, the palette (WCAG AA, computed, both
// themes), and each surface class by RENDERING the real component and reading
// the colour tokens off its markup. Each was mutation-proven: break the
// helper's index, drop a surface's `style`, or hard-code a green class, and the
// named test fails.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";
import { ADD_TINT, DEL_TINT, HUES, authorIndex, authorStyle, authorTokens, lastAuthor } from "../board/src/lib/authorcolor.mjs";

const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");
const roster = [{ actor: "me" }, { actor: "bob" }, { actor: "cat" }];

describe("authorcolor helper", () => {
  test("a teammate's tokens are their roster slot's colour; removals use the -del variant", () => {
    assert.deepEqual(authorTokens("bob", roster), {
      add: "var(--who-1)",
      del: "var(--who-1-del)",
      addBg: `color-mix(in srgb, var(--who-1) ${ADD_TINT}%, transparent)`,
      delBg: `color-mix(in srgb, var(--who-1-del) ${DEL_TINT}%, transparent)`,
    });
  });
  test("my own changes get my colour, not a generic one", () => {
    assert.equal(authorStyle("me", roster)["--diff-add"], "var(--who-0)");
  });
  test("an unknown or missing author gets no tokens (the CSS falls back to green/red)", () => {
    assert.deepEqual(authorStyle("stranger", roster), {});
    assert.deepEqual(authorStyle(null, roster), {});
    assert.deepEqual(authorStyle("bob", undefined), {});
    assert.equal(authorIndex("stranger", roster), -1);
  });
  test("slots wrap at HUES exactly as hueOf does, and HUES matches constants.ts", () => {
    const big = Array.from({ length: HUES + 2 }, (_, i) => ({ actor: "u" + i }));
    assert.equal(authorIndex("u" + HUES, big), 0);
    assert.equal(authorIndex("u" + (HUES + 1), big), 1);
    assert.equal(Number(/HUES = (\d+)/.exec(read("board", "src", "lib", "constants.ts"))[1]), HUES);
  });
  test("lastAuthor is whoever touched the file most recently", () => {
    assert.equal(lastAuthor({ me: 5, bob: 9, cat: 1 }), "bob");
    assert.equal(lastAuthor({}), null);
    assert.equal(lastAuthor(undefined), null);
  });
});

/* ---- the palette: WCAG AA, computed, both themes ------------------------ */

const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** `fg` at `pct`% over `bg` — what color-mix(.. pct%, transparent) paints. */
const over = (fg, pct, bg) => fg.map((v, i) => v * (pct / 100) + bg[i] * (1 - pct / 100));

const css = read("board", "src", "styles", "masora.css");
function theme(selectorRe) {
  const block = selectorRe.exec(css)[1];
  const get = (n) => hex(new RegExp(`--${n}:\\s*(#[0-9a-fA-F]{6})`).exec(block)[1]);
  return { paper: get("paper"), who: [...Array(HUES).keys()].map((i) => get(`who-${i}`)), del: [...Array(HUES).keys()].map((i) => get(`who-${i}-del`)) };
}
const themes = {
  light: theme(/\n {2}:root \{([\s\S]*?)\n {2}\}/),
  dark: theme(/:root\[data-theme="dark"\] \{([\s\S]*?)\n {2}\}/),
};

describe("author colours meet WCAG AA in both themes", () => {
  for (const [name, t] of Object.entries(themes)) {
    for (let i = 0; i < HUES; i++) {
      test(`${name} who-${i}: +N and added lines`, () => {
        assert.ok(ratio(t.who[i], t.paper) >= 4.5, "+N on the paper");
        assert.ok(ratio(t.who[i], over(t.who[i], ADD_TINT, t.paper)) >= 4.5, "added line text on its own tint");
      });
      test(`${name} who-${i}: −N and removed lines, and still a distinct variant`, () => {
        assert.ok(ratio(t.del[i], t.paper) >= 4.5, "−N on the paper");
        assert.ok(ratio(t.del[i], over(t.del[i], DEL_TINT, t.paper)) >= 4.5, "removed line text on its own tint");
        assert.notDeepEqual(t.del[i], t.who[i]);
        // darker in light, dimmer in dark: both are LOWER luminance than the add colour
        assert.ok(lum(t.del[i]) < lum(t.who[i]), "the removal colour is the quieter of the pair");
      });
    }
  }
});

/* ---- the surfaces: render the real components --------------------------- */

let vite;
let render;
let mod;
before(async () => {
  // Canonical casing/realpath, so vite and node load ONE copy of react (a
  // junctioned node_modules otherwise shows up under two spellings).
  const BOARD = realpathSync.native(path.join(ROOT, "board"));
  const boardReq = createRequire(path.join(BOARD, "package.json"));
  ({ createServer: vite } = await import(pathToFileURL(boardReq.resolve("vite")).href));
  vite = await vite({
    configFile: path.join(BOARD, "vite.config.ts"),
    root: BOARD,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { "lucide-react": path.join(ROOT, "test", "author-color.lucide-stub.mjs") } },
  });
  const React = boardReq("react");
  const { renderToStaticMarkup } = boardReq("react-dom/server");
  mod = {
    React,
    DiffCounts: (await vite.ssrLoadModule("/src/components/diffcounts.tsx")).DiffCounts,
    CodeDiff: (await vite.ssrLoadModule("/src/components/assistant-ui/elements/code-diff.tsx")).CodeDiff,
    FileTree: (await vite.ssrLoadModule("/src/components/assistant-ui/elements/file-tree.tsx")).FileTree,
  };
  render = (C, props) => renderToStaticMarkup(React.createElement(C, props));
});
after(async () => {
  if (vite) await vite.close();
});

/** Same hex-level read of a rendered style attribute. */
const styleOf = (html) => /style="([^"]*)"/.exec(html)?.[1] ?? "";
const HARD = /(?:text|bg)-(?:emerald|red)-/;
const diff = { filename: "a.js", additions: 2, deletions: 1, cycle: 1, lines: [{ kind: "added", text: "x" }, { kind: "removed", text: "y" }, { kind: "context", text: "z" }] };

describe("surface: +N/−N counts (tree badge, tree total)", () => {
  test("a teammate's counts carry their colour tokens and the author classes", () => {
    const html = render(mod.DiffCounts, { added: 3, removed: 1, style: authorStyle("bob", roster) });
    assert.match(styleOf(html), /--diff-add:var\(--who-1\)/);
    assert.match(styleOf(html), /--diff-del:var\(--who-1-del\)/);
    assert.match(html, /class="d-add">\+3</);
    assert.match(html, /class="d-del">−1</);
  });
  test("no author: no tokens, so the CSS fallback paints green/red", () => {
    assert.equal(styleOf(render(mod.DiffCounts, { added: 3, removed: 1, style: authorStyle("stranger", roster) })), "");
  });
  test("zero counts hide unless it is a total", () => {
    assert.doesNotMatch(render(mod.DiffCounts, { added: 0, removed: 4 }), /d-add/);
    assert.match(render(mod.DiffCounts, { added: 0, removed: 4, showZero: true }), /\+0/);
  });
  test("the tree wires the file's last toucher into the badge, and my colour into the total", () => {
    const tree = read("board", "src", "components", "tree.tsx");
    assert.match(tree, /author=\{lastAuthor\(node\.who\)\}/);
    assert.match(tree, /style=\{authorStyle\(author\)\}/);
    assert.match(tree, /showZero style=\{myAuthorStyle\(\)\}/);
  });
});

describe("surface: diff lines (conversation tool-call diff)", () => {
  test("a teammate's diff: counts and lines use the author classes under their tokens", () => {
    const html = render(mod.CodeDiff, { ...diff, style: authorStyle("cat", roster) });
    assert.match(styleOf(html), /--diff-add:var\(--who-2\)/);
    assert.match(html, /d-add-bg/);
    assert.match(html, /d-del-bg/);
    assert.doesNotMatch(html, HARD, "a hard-coded green/red would ignore the author");
  });
  test("an edit in my own chat is drawn in my colour", () => {
    assert.match(read("board", "src", "components", "tools.tsx"), /style=\{myAuthorStyle\(\)\}/);
  });
});

describe("surface: file-change tree element", () => {
  test("per-file and total counts follow the author", () => {
    const nodes = [{ path: "a.js", name: "a.js", depth: 0, kind: "file", additions: 4, deletions: 2 }];
    const html = render(mod.FileTree, { nodes, visibleCount: 1, totalAdditions: 4, totalDeletions: 2, style: authorStyle("bob", roster) });
    assert.match(styleOf(html), /--diff-add:var\(--who-1\)/);
    assert.equal((html.match(/class="d-add"/g) || []).length, 2);
    assert.equal((html.match(/class="d-del"/g) || []).length, 2);
    assert.doesNotMatch(html, HARD);
  });
});

describe("fallback and the stylesheet", () => {
  test("the author classes fall back to success/alert when no tokens are set", () => {
    assert.match(css, /\.d-add \{ color: var\(--diff-add, var\(--success\)\); \}/);
    assert.match(css, /\.d-del \{ color: var\(--diff-del, var\(--alert\)\); \}/);
    assert.match(css, /\.d-add-bg \{ background: var\(--diff-add-bg, [^;]*var\(--success\)/);
    assert.match(css, /\.d-del-bg \{ background: var\(--diff-del-bg, [^;]*var\(--alert\)/);
  });
  test("no change surface keeps its own green or red", () => {
    for (const f of ["assistant-ui/elements/code-diff.tsx", "assistant-ui/elements/file-tree.tsx", "tree.tsx", "diffcounts.tsx"]) {
      assert.doesNotMatch(read("board", "src", "components", f), HARD, f);
    }
  });
  test("the committed bundle ships the classes", () => {
    const built = read("hub", "public", "board.css");
    assert.match(built, /\.d-add\{color:var\(--diff-add,var\(--success\)\)\}/);
    assert.match(built, /--who-1-del:/);
  });
});
