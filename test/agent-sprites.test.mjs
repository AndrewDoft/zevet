// The sprite grids, checked for the things a drawing can silently get wrong.
//
// There is no DOM here and no rendering: this asserts the GEOMETRY and the tool
// mapping, which is where the bugs actually are. A row one character too long
// shifts everything after it and produces a figure that looks fine in isolation
// and wrong next to its neighbours -- exactly the kind of thing that survives
// eyeballing and is caught by an invariant. (The first version of TOOLS.page
// had a 7-character row; this file is why it did not ship.)
//
// ⚠️ WHAT THIS DOES NOT CHECK: that the sprites look like anything. Nobody has
// seen them on a real board. The grids are eyeballed, and that is all.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The file is a browser script, not a module. Run it in a vm and take the
 *  global it defines -- the same way the board will load it. */
function load() {
  const src = readFileSync(path.join(ROOT, "hub", "public", "agent-sprites.js"), "utf8");
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  return ctx.zevetSprites;
}

const sprites = load();

describe("agent sprites", () => {
  test("the module defines exactly what the board consumes", () => {
    assert.equal(typeof sprites.spriteFor, "function");
    assert.equal(typeof sprites.toolKind, "function");
    // Array.from, not .sort() on what came back: an array built inside a vm
    // context has that context's Array.prototype, and assert's strict deepEqual
    // compares prototypes. Without the copy this fails with two array literals
    // printed identically side by side, which is a deeply unhelpful five
    // minutes.
    assert.deepEqual(Array.from(sprites.kinds()).sort(), ["eraser", "lens", "none", "page", "pencil", "shell"]);
  });

  test("every sprite is the same 16x8 grid", () => {
    // The invariant that makes one figure line up with the next.
    for (const kind of sprites.kinds()) {
      const svg = sprites.spriteFor({ hint: kind });
      assert.match(svg, /viewBox="0 0 16 8"/, `${kind} is not 16x8`);
      // No rect may start at or past x=16, which is what an over-long row
      // would produce.
      for (const m of svg.matchAll(/x="(\d+)"[^>]*width="(\d+)"/g)) {
        const right = Number(m[1]) + Number(m[2]);
        assert.ok(right <= 16, `${kind} has a rect ending at x=${right}`);
      }
      for (const m of svg.matchAll(/y="(\d+)"/g)) {
        assert.ok(Number(m[1]) < 8, `${kind} has a rect at y=${m[1]}`);
      }
    }
  });

  test("the figure is identical across tools and only the tool changes", () => {
    // The person is the constant; the tool is what their agent is doing this
    // second. If a tool grid ever bled into the figure's 10 columns this fails.
    const bodyOf = (svg) => svg.match(/<g fill="currentColor">(.*?)<\/g>/)[1];
    const base = bodyOf(sprites.spriteFor({ hint: "none" }));
    for (const kind of sprites.kinds()) {
      assert.equal(bodyOf(sprites.spriteFor({ hint: kind })), base, `${kind} altered the figure`);
    }
  });

  test("the body is currentColor so it takes the teammate's colour", () => {
    const svg = sprites.spriteFor({ tool: "Edit" });
    assert.match(svg, /<g fill="currentColor">/);
    // The tool is the same hue, dimmed -- not a second colour.
    assert.match(svg, /<g fill="currentColor" opacity="0\.55">/);
    // Eyes are the surface behind the sprite, with a fallback.
    assert.match(svg, /var\(--zevet-sprite-eye, #eae7e2\)/);
    assert.doesNotMatch(svg, /fill="#(?!eae7e2)/, "a colour was hardcoded");
  });

  test("real tool names off the wire map to a tool", () => {
    // These are the names Claude Code and Codex actually send, which
    // client/hook.mjs forwards verbatim as `tool`.
    assert.equal(sprites.toolKind("Edit"), "pencil");
    assert.equal(sprites.toolKind("MultiEdit"), "pencil");
    assert.equal(sprites.toolKind("Write"), "page");
    assert.equal(sprites.toolKind("Read"), "lens");
    assert.equal(sprites.toolKind("Grep"), "lens");
    assert.equal(sprites.toolKind("Glob"), "lens");
    assert.equal(sprites.toolKind("Bash"), "shell");
    assert.equal(sprites.toolKind("apply_patch"), "pencil");
  });

  test("matching ignores case and separators", () => {
    assert.equal(sprites.toolKind("BASH"), "shell");
    assert.equal(sprites.toolKind("multi_edit"), "pencil");
    assert.equal(sprites.toolKind("Notebook Edit"), "pencil");
  });

  test("an unknown tool leaves the figure empty-handed rather than guessing", () => {
    assert.equal(sprites.toolKind("SomeToolShippedNextMonth"), "none");
    assert.equal(sprites.toolKind(""), "none");
    assert.equal(sprites.toolKind(null), "none");
  });

  test("an explicit hint wins, which is how a delete gets an eraser", () => {
    // Nothing on the wire says "delete" -- it arrives as an Edit that removed
    // lines, and only the caller can see that. So the hint has to beat the name.
    assert.equal(sprites.toolKind("Edit", "eraser"), "eraser");
    assert.equal(sprites.toolKind("Bash", "eraser"), "eraser");
    // A nonsense hint falls back to the tool name rather than drawing nothing.
    assert.equal(sprites.toolKind("Edit", "trombone"), "pencil");
  });

  test("the drawing is run-length encoded, not one rect per pixel", () => {
    // 128 cells; a naive encoder emits one rect each and the board redraws
    // these on every event.
    const svg = sprites.spriteFor({ tool: "Edit" });
    const rects = [...svg.matchAll(/<rect /g)].length;
    assert.ok(rects < 60, `${rects} rects — the run-length encoding is not working`);
    assert.ok(rects > 10, `${rects} rects — suspiciously few, is anything drawn?`);
  });
});
