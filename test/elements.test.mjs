// The ledger: every assistant-ui element zevet installs is either on screen or
// written down here with the reason it is not.
//
// The registry has 156 items. Installing one is free and rendering one is not:
// an element takes props, and a prop with no honest source is a number that
// looks real and is invented. So this file walks the board's actual import
// graph from its entry point, and requires every installed element file that
// nothing reaches to appear in UNRENDERED below with a stated reason.
//
// It fails in both directions on purpose. An element that quietly stops being
// rendered has to be explained; an element that is explained here and then
// gets wired up has to have its excuse deleted. Neither can drift silently,
// which is the whole point — "does zevet have all the assistant-ui stuff" is a
// question this file answers rather than a thing anybody has to remember.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const SRC = path.join(ROOT, "board", "src");
const ELEMENTS = path.join(SRC, "components", "assistant-ui", "elements");

/* ---------------------------------------------------------------------------
 * Why an installed element is not on screen.
 *
 * Every entry is one of three kinds, and the kind matters:
 *
 *   "no data"    — zevet does not have the fact the element needs, and the
 *                  fact cannot be manufactured. Building it would mean
 *                  inventing the number, which is the one thing none of this
 *                  does.
 *   "not the shape" — the element models a product zevet is not: a chat
 *                  bubble on someone's marketing site, a phone, a shared
 *                  read-only link. The data exists; the surface does not.
 *   "superseded" — something else here does the same job, for a stated reason.
 *   "runtime-bound" — a `.aui` variant, which reads assistant-ui's own store.
 *                  zevet's runtime is an external store over three CLIs, so
 *                  these are wired to state nothing here fills. The
 *                  plain-props sibling is used instead wherever zevet has the
 *                  fact to give it.
 *   "removed with" — it WAS on screen, and the surface that held it was taken
 *                  out. Distinct from the four above because it is the only
 *                  kind that records a decision about the product rather than
 *                  about the element, and the only one where the element is
 *                  still perfectly usable — it just has nowhere to be.
 * ------------------------------------------------------------------------- */
// Empty since 2026-09-28: the 51 installed-but-never-rendered elements were deleted
// (audit §6). Installing one again means rendering it, or writing its reason here.
const UNRENDERED = {};

/* ---------------------------------------------------------------------------
 * The import graph.
 * ------------------------------------------------------------------------- */

const EXT = [".tsx", ".ts", ".mts", ".mjs", ".jsx", ".js"];

function resolve(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // a package, not ours

  const tries = [base, ...EXT.map((e) => base + e), ...EXT.map((e) => path.join(base, "index" + e))];
  // A `.mjs` import may be written against its `.d.mts` sibling; either file
  // being present means the module is reachable.
  for (const t of tries) {
    if (statSync(t, { throwIfNoEntry: false })?.isFile()) return t;
  }
  return null;
}

function specifiers(source) {
  const out = [];
  const re = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(source))) out.push(m[1]);
  return out;
}

function reachable(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const spec of specifiers(src)) {
      const next = resolve(spec, file);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

const installed = readdirSync(ELEMENTS)
  .filter((n) => /\.(tsx|ts)$/.test(n))
  .sort();

const live = reachable([path.join(SRC, "main.tsx")]);
const rendered = new Set(
  installed.filter((n) => live.has(path.join(ELEMENTS, n))),
);

describe("every installed element is on screen or explained", () => {
  test("nothing is silently unused", () => {
    const orphans = installed.filter((n) => !rendered.has(n) && !UNRENDERED[n]);
    assert.deepEqual(
      orphans,
      [],
      `installed but never rendered and never explained:\n  ${orphans.join("\n  ")}\n` +
        "Either render it, or add it to UNRENDERED with the reason. An element " +
        "that is installed and unexplained is dead weight nobody decided on.",
    );
  });

  test("no excuse outlives the thing it excused", () => {
    // An element that gets wired up later must lose its entry here, or the
    // ledger starts describing a board that no longer exists.
    const stale = Object.keys(UNRENDERED).filter((n) => rendered.has(n));
    assert.deepEqual(stale, [], `explained as unrendered, but actually rendered: ${stale.join(", ")}`);
  });

  test("no excuse names a file that is not installed", () => {
    const ghosts = Object.keys(UNRENDERED).filter((n) => !installed.includes(n));
    assert.deepEqual(ghosts, [], `UNRENDERED names files that do not exist: ${ghosts.join(", ")}`);
  });

  test("every reason says which kind of reason it is", () => {
    // The kinds are different decisions, and only some of them are ever worth
    // revisiting cheaply. "removed with" is the newest and the cheapest to
    // reverse: the element still works, it just has no host.
    for (const [file, why] of Object.entries(UNRENDERED)) {
      assert.match(
        why,
        /^(no data|not the shape|superseded|runtime-bound|removed with):/,
        `${file}'s reason does not start with one of the kinds`,
      );
      assert.ok(why.length > 60, `${file}'s reason is too short to be a reason`);
    }
  });

  test("the board renders more of the registry than it declines", () => {
    // The answer to "does zevet actually use assistant-ui, or does it just
    // have it installed". Self-adjusting rather than a number to bump: every
    // element wired up moves one file from the right side to the left.
    assert.ok(
      rendered.size > Object.keys(UNRENDERED).length,
      `${rendered.size} rendered against ${Object.keys(UNRENDERED).length} explained away — ` +
        "the ledger has become longer than the board.",
    );
  });

  test("no two entries share a reason", () => {
    // Copy-pasting an excuse is how a list like this stops being read. If two
    // elements really are declined for the same reason, say so in words that
    // name both.
    const byReason = new Map();
    for (const [file, why] of Object.entries(UNRENDERED)) {
      const seen = byReason.get(why);
      assert.equal(seen, undefined, `${file} and ${seen} carry the same reason verbatim`);
      byReason.set(why, file);
    }
  });
});
