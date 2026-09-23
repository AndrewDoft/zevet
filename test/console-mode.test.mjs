// Changing a console's permission posture mid-run.
//
// Andrew: "you should be able to change permissions throughout, even to
// dsp [--dangerously-skip-permissions]." A running CLI process cannot be
// handed new argv, so the only honest way to apply a new posture is a new
// process under `--resume <sessionId>` — machinery `sendPrompt` already had
// for a plain follow-up. This adds `ConsoleEntry.nextMode` (the posture the
// NEXT turn should run under) and a store action, `setConsoleMode`, that
// either applies a posture immediately (idle console) or parks it for
// `sendPrompt` to apply at the next turn (running console).
//
// board/src/lib/board.ts and board/src/components/people.tsx are TypeScript
// and TSX; node --test has no transpiler for either, so — same reasoning as
// people-dedupe.test.mjs and board-updates.test.mjs's connect.mjs precedent
// for plain modules — the contract is pinned against the source text.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const boardSrc = readFileSync(path.join(ROOT, "board", "src", "lib", "board.ts"), "utf8");
const typesSrc = readFileSync(path.join(ROOT, "board", "src", "lib", "types.ts"), "utf8");
const peopleSrc = readFileSync(path.join(ROOT, "board", "src", "components", "people.tsx"), "utf8");

function body(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start > -1, `expected to find ${JSON.stringify(marker)}`);
  // Slice to the next top-level `},` that closes an object-literal action —
  // every store action in this file ends exactly that way.
  const end = src.indexOf("\n  },", start);
  assert.ok(end > start, `expected ${JSON.stringify(marker)} to end with "\\n  },"`);
  return src.slice(start, end);
}

describe("ConsoleEntry.nextMode", () => {
  test("exists, and is documented as distinct from mode", () => {
    assert.match(typesSrc, /nextMode\?:\s*LaunchMode\s*\|\s*null;/);
    // The whole feature is broken if a reader conflates the two fields —
    // the doc comment has to say plainly that `mode` is NOT rewritten live.
    const idx = typesSrc.indexOf("nextMode?:");
    const commentAbove = typesSrc.slice(Math.max(0, idx - 700), idx);
    assert.match(commentAbove, /NOT `mode`/);
  });
});

describe("setConsoleMode", () => {
  const fn = body(boardSrc, "setConsoleMode: (key, mode) => {");

  test("refuses a mode the CLI table (MODES) does not know", () => {
    assert.match(fn, /if \(!MODES\.some\(\(m\) => m\.id === mode\)\) return;/);
  });

  test("no-ops when the target already matches where the console is headed", () => {
    assert.match(fn, /const heading = c\.running \? \(c\.nextMode \?\? c\.mode\) : c\.mode;/);
    assert.match(fn, /if \(heading === mode\) return;/);
  });

  test("a running console only ever gets nextMode written, never mode", () => {
    // The running branch must not touch `mode` at all — only `nextMode`.
    const runningBranch = fn.slice(fn.indexOf("x.running"), fn.indexOf(": { ...x, mode:"));
    assert.match(runningBranch, /\{ \.\.\.x, nextMode: mode as LaunchMode \}/);
    assert.ok(
      !/mode:\s*mode as LaunchMode/.test(runningBranch.replace("nextMode: mode as LaunchMode", "")),
      "the running branch must not set `mode` directly",
    );
  });

  test("an idle console gets mode written directly, and nextMode cleared", () => {
    assert.match(fn, /: \{ \.\.\.x, mode: mode as LaunchMode, nextMode: null \};/);
  });
});

describe("sendPrompt applies a pending posture change before it resumes", () => {
  const fn = body(boardSrc, "sendPrompt: (key, text) => {");

  test("the swap only fires for a running console with a real, different, resumable nextMode", () => {
    assert.match(
      fn,
      /const swapping =\s*before\.running && Boolean\(before\.nextMode\) && before\.nextMode !== before\.mode && Boolean\(before\.sessionId\);/,
    );
  });

  test("it reuses stopConsole — no second stop is written", () => {
    const stopCalls = fn.match(/bridge\.local\?\.stopAgent/g) || [];
    assert.equal(stopCalls.length, 0, "sendPrompt must not call stopAgent itself — that's stopConsole's job");
    assert.match(fn, /if \(swapping\) get\(\)\.stopConsole\(key\);/);
  });

  test("the swap (stop, then mode <- nextMode, then clear nextMode) precedes the resume branch reading c.mode", () => {
    const swapIdx = fn.indexOf("if (swapping) get().stopConsole(key);");
    const modeAssignIdx = fn.indexOf("c.mode = c.nextMode!;");
    const clearIdx = fn.indexOf("c.nextMode = null;");
    const resumeCheckIdx = fn.indexOf("if (!c.running && c.sessionId");
    const resumeCallIdx = fn.indexOf("bridge.local.resumeAgent(c.agent, c.root, c.sessionId, { model: c.model, mode: c.mode,");
    assert.ok(swapIdx > -1 && modeAssignIdx > -1 && clearIdx > -1 && resumeCheckIdx > -1 && resumeCallIdx > -1);
    // ⚠️ THIS ORDERING IS THE WHOLE FEATURE. Reversing any of these — e.g.
    // reading c.mode into resumeAgent before the swap, or stopping AFTER the
    // `!c.running` check runs — either resumes with the old posture or never
    // resumes at all (stopConsole must land first for `!c.running` to fire).
    assert.ok(swapIdx < modeAssignIdx, "must stop before moving nextMode into mode");
    assert.ok(modeAssignIdx < clearIdx, "must read c.nextMode before clearing it");
    assert.ok(clearIdx < resumeCheckIdx, "the swap must finish before the !c.running check runs");
    assert.ok(resumeCheckIdx < resumeCallIdx, "resumeAgent is inside the !c.running branch, not before it");
  });

  test("re-reads c from the store after stopConsole, rather than reusing the pre-stop reference", () => {
    // stopConsole replaces the console's array entry via `set()`; the old
    // `before` object is stale the instant it runs. `c` must come from a
    // fresh lookup when (and only when) a swap happened.
    assert.match(
      fn,
      /const c = swapping \? get\(\)\.myConsoles\.find\(\(x\) => x\.key === key\)! : before;/,
    );
  });
});

describe("the posture lives in the composer, not on the rail's rows", () => {
  const controlsSrc = readFileSync(path.join(ROOT, "board", "src", "components", "composercontrols.tsx"), "utf8");

  test("an agent row carries no posture control", () => {
    // A red posture label on every row squeezed titles to "You …".
    assert.ok(!peopleSrc.includes("agent-row-mode"));
    assert.ok(!peopleSrc.includes("setConsoleMode"));
  });

  test("the composer's picker shows where the console is headed and parks the pick on it", () => {
    assert.match(controlsSrc, /value=\{activeKey && !isChat \?/);
    assert.match(controlsSrc, /if \(!isChat && activeKey && setConsoleMode\) setConsoleMode\(activeKey, v\);/);
  });
});
