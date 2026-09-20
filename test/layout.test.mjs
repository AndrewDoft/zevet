// The panes have to fill their windows.
//
// ⚠️ REPORTED BY ANDREW AGAINST 0.2.11: "everything needs to be max
// width/widened to fit in its windows. the agent thing is so narrow and looks
// weird." He was right, and the reason I did not see it is that I looked at
// the board in a browser at 1440 CSS px and he runs it in a 1240px window on a
// scaled display — about 830 CSS px. Every registry element is sized for a
// chat that owns the page, and this is a three-pane app.
//
// Four separate causes, each pinned below. None of them is visible in a
// screenshot taken at the wrong width, which is why they are assertions about
// the rules rather than about pixels.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const BOARD = path.join(ROOT, "board", "src");
const css = readFileSync(path.join(BOARD, "styles", "masora.css"), "utf8");

describe("the conversation fills its column", () => {
  test("the Thread's inline 44rem cap is overridden, with !important", () => {
    // ThreadPrimitive.Root sets --thread-max-width as an INLINE style, which a
    // stylesheet rule cannot beat. Measured before the fix: 672px of a 1042px
    // column on a 1600px window — 64%. After: 97%.
    const rule = css.slice(css.indexOf(".chat-thread [data-slot="), css.indexOf(".chat-thread [data-slot=") + 600);
    assert.match(rule, /--thread-max-width:[^;]*!important/);
  });

  test("the meters are a strip, not a block", () => {
    // Three stacked cards under the transcript took two thirds of the pane's
    // height and left the conversation a strip at the top — the exact inverse
    // of what the view is for.
    const rm = readFileSync(path.join(BOARD, "components", "runmeters.tsx"), "utf8");
    assert.match(rm, /useState\(false\)/, "the meters must default to closed");
    assert.match(rm, /aria-expanded=\{open\}/);
    assert.match(css, /\.run-meters-body \{/);
  });
});

describe("agent view gives the conversation the width", () => {
  test("the tree is a fraction, floored, not a fixed 300px", () => {
    const block = css.slice(css.indexOf("@media (max-width: 1000px)"), css.indexOf("@media (max-width: 1000px)") + 500);
    const m = /grid-template-columns: minmax\((\d+)px, ([\d.]+)fr\)/.exec(block);
    assert.ok(m, "the narrow-window tree track is gone");
    const [, floor, fr] = m;
    // Below ~170px the pane's own empty-state copy wraps to one word a line;
    // above ~0.3fr the conversation is the minority of the window.
    assert.ok(Number(floor) >= 160, `tree floor ${floor}px is too narrow for its own copy`);
    assert.ok(Number(fr) <= 0.3, `tree takes ${fr}fr, which leaves the conversation the minority`);
  });

  test("only one media query owns that track", () => {
    // Two competing queries is how the first attempt did nothing at all: the
    // rules were added above a pre-existing block that overrode them.
    const hits = [...css.matchAll(/body\[data-view="agent"\] \.middle \{[^}]*grid-template-columns/g)];
    assert.ok(hits.length <= 2, `${hits.length} rules set the agent middle tracks; they will fight`);
  });
});

describe("no control is offered that zevet cannot honour", () => {
  // Same class as ToolError's Retry: the registry ships affordances for a
  // product that drives the agent loop. zevet does not.
  test("AgentStatus's pause/retry trailing is suppressed", () => {
    for (const f of ["consoles.tsx", "people.tsx"]) {
      const src = readFileSync(path.join(BOARD, "components", f), "utf8");
      assert.match(src, /trailing=\{null\}/, `${f} renders AgentStatus's default Pause/Retry icon`);
    }
  });
});

describe("every dropdown follows the theme", () => {
  // A native <select> popup is drawn by the OS, so in dark mode it opened as a
  // white menu — the one piece of the board that never followed the theme.
  const sources = (dir) =>
    readdirSync(dir).flatMap((n) => {
      const full = path.join(dir, n);
      if (statSync(full).isDirectory()) return n === "assistant-ui" || n === "ui" ? [] : sources(full);
      return /\.tsx$/.test(n) ? [full] : [];
    });

  /** Comments name the thing they replaced, so they are stripped first —
   *  otherwise the note explaining the fix fails the test for the bug. */
  const code = (f) =>
    readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  test("no native <select> is left in the board's own components", () => {
    const offenders = sources(path.join(BOARD, "components"))
      .filter((f) => /<select\b/.test(code(f)))
      .map((f) => path.relative(ROOT, f));
    assert.deepEqual(offenders, [], `native <select> renders an OS popup that ignores the theme:\n        ${offenders.join("\n        ")}`);
  });
});
