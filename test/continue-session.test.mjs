// Continuing a RECORDED session as a LIVE console — Andrew: "the new version
// should not erase past chat history. i need to be able to resume this chat
// with opus in zevet."
//
// board/src/lib/board.ts and board/src/components/sessions.tsx are
// TypeScript/TSX, which this suite does not execute — same reasoning
// asks.test.mjs and board-theme.test.mjs give: node --test has no
// transpiler, so the contract is pinned against the source text instead.
//
// Drafted by muse (opencode/muse-spark-1.3-contributor-free) from the real
// board.ts/sessions.tsx/sessions.d.mts/agent-console.js contents, then
// corrected here — see the report for what changed and why. The regexes
// below match the CORRECTED code, not muse's first draft.
//
// Three things matter enough to break silently otherwise:
//   1. claude and codex do NOT resume by the same field (`resumeIdForSession`)
//      — desktop/agent-console.js:373-400 measured `claude --resume
//      <session-id>` against `codex exec resume <session-id>`, and codex's
//      resume id lives on `SessionSummary.sessionId`, not `.id`.
//   2. a session with no resumable id must not be OFFERED the control —
//      not offered-and-fail.
//   3. a console already resumed against a session id is focused, never
//      duplicated into a second process against the same file.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const board = readFileSync(path.join(ROOT, "board", "src", "lib", "board.ts"), "utf8");
const sessionsUi = readFileSync(path.join(ROOT, "board", "src", "components", "sessions.tsx"), "utf8");

describe("resumeIdForSession — the right id per source", () => {
  test("codex resumes by sessionId (session_meta's own id), claude by id (the file name)", () => {
    assert.match(
      board,
      /export function resumeIdForSession\(s: SessionSummary\): string \| null \{\s*if \(s\.source === "codex"\) return s\.sessionId \? s\.sessionId : null;\s*return s\.id \? s\.id : null;\s*\}/,
    );
    // The comment cites the measured invocations so the next reader knows why.
    assert.match(board, /codex exec resume <session-id>/);
    assert.match(board, /claude --resume <session-id>/);
  });

  test("the banner asks the SAME function rather than re-deriving the split", () => {
    // A second, independently-written claude/codex branch in the UI is how
    // this drifts out of sync with the store's — sessions.tsx must import
    // and call board.ts's helper, not reimplement the ternary.
    assert.match(sessionsUi, /import \{ useBoard, resumeIdForSession \} from "\.\.\/lib\/board";/);
    assert.match(sessionsUi, /const resumeId = resumeIdForSession\(open\);/);
    assert.doesNotMatch(sessionsUi, /open\.source === "codex" \? open\.sessionId/);
  });
});

describe("continueSession — no id, not offered", () => {
  test("the store guards on resumeIdForSession before doing anything else", () => {
    assert.match(
      board,
      /continueSession: \(s\) => \{[\s\S]{0,800}const resumeId = resumeIdForSession\(s\);\s*if \(!resumeId\) return;/,
    );
  });

  test("the banner only renders Continue when resumeId is truthy and bridge.local.resumeAgent exists", () => {
    assert.match(
      sessionsUi,
      /const canContinue =\s*Boolean\(resumeId\) && Boolean\(bridge\.local\) && typeof bridge\.local\?\.resumeAgent === "function";/,
    );
    assert.match(sessionsUi, /\{canContinue \? \([\s\S]{0,120}onClick=\{\(\) => continueSession\(open\)\}/);
  });
});

describe("continueSession — no duplicate console", () => {
  test("an existing console for this agent + session id is focused, not started again", () => {
    assert.match(
      board,
      /const existing = get\(\)\.myConsoles\.find\(\s*\(x\) => x\.agent === s\.source && x\.sessionId === resumeId,\s*\);\s*if \(existing\) \{\s*set\(\(g\) => \(\{\s*activeConsole: existing\.key,/,
    );
    // The dupe branch must return before a `ConsoleEntry` is ever built or
    // pushed — the ONLY `myConsoles: [...` push in this action comes after it.
    const action = board.slice(board.indexOf("continueSession: (s) => {"));
    const dupeIdx = action.indexOf("if (existing) {");
    const pushIdx = action.indexOf("myConsoles: [...g.myConsoles, c]");
    assert.ok(dupeIdx > -1 && pushIdx > -1 && dupeIdx < pushIdx, "the dupe check must run before a second console is pushed");
  });
});

describe("continueSession — history carried, not lost", () => {
  test("the new console starts from the recorded transcript, and a truncated READ is not treated as lost history", () => {
    assert.match(board, /transcript: base,/);
    assert.match(board, /st\.sessions\.openTranscript\s*$/m);
    // `openTruncated` means the READ was head+tail-trimmed for the pane, not
    // that the on-disk session (which --resume/exec resume re-reads in full)
    // lost anything.
    assert.match(board, /`openTruncated` is head\+tail trimming done for DISPLAY only/);
    // Same bridge call sendPrompt's own resume-on-exit path uses — no second
    // resume code path was written for this feature.
    assert.match(board, /br\.resumeAgent\(c\.agent, c\.root, resumeId, \{ model: c\.model, mode: c\.mode \}\)/);
  });
});
