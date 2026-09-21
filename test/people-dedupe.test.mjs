// The Agents tree merges two sources into one row list: sessions read off
// disk, and consoles zevet itself launched. A launched console ALSO writes a
// session file as it runs, so the same agent can arrive from both — without
// a dedupe rule it would show up as two rows for one running thing.
//
// components/people.tsx is TSX, which this suite does not execute — same
// reasoning continue-session.test.mjs and board-theme.test.mjs give: node
// --test has no transpiler, so the contract is pinned against the source
// text instead.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const people = readFileSync(path.join(ROOT, "board", "src", "components", "people.tsx"), "utf8");

describe("people.tsx — a console and a matching disk session make ONE row", () => {
  test("every console is claimed by agent+sessionId before the disk scan runs", () => {
    // `claimed` has to exist, and has to be built from myConsoles, before
    // anything reads `list` (the disk scan) — otherwise there is nothing for
    // the session loop below to check against.
    assert.match(
      people,
      /const claimed = new Set\(myConsoles\.filter\(\(c\) => c\.sessionId\)\.map\(\(c\) => `\$\{c\.agent\}:\$\{c\.sessionId\}`\)\);/,
    );
    const claimedIdx = people.indexOf("const claimed = new Set(");
    const consoleLoopIdx = people.indexOf("for (const c of myConsoles) {");
    const sessionLoopIdx = people.indexOf("for (const s of list) {");
    assert.ok(
      claimedIdx > -1 && consoleLoopIdx > claimedIdx && sessionLoopIdx > consoleLoopIdx,
      "claimed must be built, then every console added, then the disk scan runs — in that order",
    );
  });

  test("a disk session claimed by a console is skipped, never pushed as a second row", () => {
    // The session loop's own `continue` is the only thing standing between
    // "one row" and "two rows for the same agent" — remove it and a
    // zevet-launched console doubles the instant its transcript hits disk.
    assert.match(
      people,
      /const resumeId = resumeIdForSession\(s\);\s*if \(resumeId && claimed\.has\(`\$\{s\.source\}:\$\{resumeId\}`\)\) continue;/,
    );
  });

  test("the console wins — the comment says so, and every console is unconditional", () => {
    // The rule has to be stated, not just implemented: a reader who deletes
    // the skip above should be told what they broke.
    assert.match(people, /THE CONSOLE WINS: it is live, and it is the\s*only one of the two that can be stopped/);
    // No filter on the console side: every entry in myConsoles becomes a row
    // no matter what the disk scan finds. Only the SESSION side is ever
    // dropped.
    const consoleLoop = people.slice(
      people.indexOf("for (const c of myConsoles) {"),
      people.indexOf("for (const s of list) {"),
    );
    assert.ok(!/continue/.test(consoleLoop), "a console row must never be skipped for being claimed");
  });
});
