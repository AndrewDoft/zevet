// A \uXXXX escape only means something inside a string literal.
//
// Seven of them had ended up in JSX TEXT, where there is no escape processing
// and the six characters render exactly as typed. The board shipped with
// "Open a folder…" on a button, "Reconnecting…" in the tree and
// "zevet’s built-in index" in settings.
//
// tsc cannot see this — it is valid text — and neither can a reader skimming a
// diff, because the source looks identical to the places where the escape is
// correct. So it is checked.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const SRC = path.join(ROOT, "board", "src");

/** Blank out every quoted string; whatever escape survives is in JSX text. */
const STRINGS = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const ESCAPE = /\\u[0-9a-fA-F]{4}/;

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      // The registry's own files are upstream's; they are re-installed
      // wholesale and are not ours to police.
      if (name === "assistant-ui") continue;
      out.push(...sources(full));
    } else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("no unicode escape renders as itself", () => {
  test("every \\uXXXX in board/src is inside a string literal", () => {
    const bad = [];
    for (const file of sources(SRC)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (ESCAPE.test(line.replace(STRINGS, "\u0000"))) {
            bad.push(`${path.relative(ROOT, file)}:${i + 1}  ${line.trim()}`);
          }
        });
    }
    assert.deepEqual(
      bad,
      [],
      "these escapes are in JSX text and will render literally — use the character:\n        " +
        bad.join("\n        "),
    );
  });
});
