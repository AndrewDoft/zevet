// The composer has to be able to send.
//
// ⚠️ THIS SHIPPED BROKEN IN 0.2.10, and nothing here noticed.
//
// The vendored ComposerAction renders Send only when `!thread.isRunning`, and
// Cancel when `isRunning`. runtime.tsx set `isRunning` from `active.running` —
// the PROCESS, true from spawn until exit — with a comment arguing that the
// composer and the stop button should agree with the process rather than with
// the prose. That reasoning is wrong about what assistant-ui means by the
// field: `isRunning` is a TURN in flight. The consequence was that every
// console showed "Stop generating" from the moment it spawned, there was no
// Send button at all, Enter only inserted a newline, and a one-prompt agent
// sat on an open stdin until it was killed.
//
// The gate was 950 tests green over that. Every one of them tested a part; the
// thing that was broken was the relationship between two files.
//
// So this pins the relationship, by reading both sides. It cannot run the UI —
// that needs a browser — but it can assert that the field the composer gates on
// is still fed from a turn and not from a process, which is the exact mistake.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const BOARD = path.join(ROOT, "board", "src");
const runtime = readFileSync(path.join(BOARD, "lib", "runtime.tsx"), "utf8");
const thread = readFileSync(
  path.join(BOARD, "components", "assistant-ui", "elements", "thread.aui.tsx"),
  "utf8",
);

describe("the composer's Send button can appear", () => {
  test("Send is still gated on !isRunning, which is the premise of the rest", () => {
    // If upstream changes this, the assertions below stop meaning anything —
    // so the premise is checked rather than assumed.
    assert.match(
      thread,
      /condition=\{\(s\) => !s\.thread\.isRunning/,
      "ComposerAction no longer gates Send on !isRunning; re-check runtime.tsx against the new gate",
    );
  });

  test("isRunning is fed from a turn in flight, not from the process", () => {
    const line = /isRunning:\s*(.+)/.exec(runtime);
    assert.ok(line, "runtime.tsx no longer sets isRunning");
    const value = line[1];
    assert.ok(
      !/\brunning\b/.test(value),
      `isRunning is set from \`${value.trim()}\` — that is the process, and it hides the Send button for the whole life of the console`,
    );
  });

  test("the turn signal comes from the transcript's open message", () => {
    // transcript.mjs owns openIndex: >= 0 means an assistant message is being
    // streamed into, and closeTranscript clears it on `result`, `step_finish`,
    // `turn.completed` and on process exit.
    assert.match(runtime, /openIndex \?\? -1\) >= 0/);
  });

  test("stopping the process is still offered somewhere", () => {
    // Moving isRunning off the process is only safe because the console row
    // keeps its own Stop. If that goes, a running agent becomes unkillable
    // from the UI.
    const rail = readFileSync(path.join(BOARD, "components", "consoles.tsx"), "utf8");
    assert.match(rail, /c\.running \? "Stop" : "Close"/);
    assert.match(rail, /closeConsole\(c\.key\)/);
  });
});

describe("sending is refused only where it would go nowhere", () => {
  const value = /isSendDisabled:\s*([\s\S]*?),\n\n/.exec(runtime)?.[1] ?? "";

  test("a dead process refuses", () => {
    // ⚠️ THE SPELLING MOVED, THE RULE DID NOT. This read `!active?.running`
    // when a console was the only thing the composer could talk to. It is a
    // ternary now, because with NO console the composer starts one — so the
    // process check lives in the branch where there is a process. Assert the
    // rule inside that branch rather than the old one-liner.
    assert.match(value, /active\s*\?[\s\S]*!active\.running/);
  });

  test("with nothing running, Send starts the run instead of refusing", () => {
    // Andrew's words on the screen this replaces: "there is no way to start
    // right now". The old agent view swapped the whole column for a sentence
    // telling you to pick an agent, and the launcher under it rendered nothing
    // at all when no folder was open. A composer that cannot be typed into
    // until you have found a button elsewhere is not a chat window.
    assert.match(value, /:\s*!canStart/);
    // And it still refuses when there is genuinely nowhere to run: an agent to
    // spawn and a folder to spawn it in are both required.
    assert.match(runtime, /const canStart = Boolean\(launchAgent && localRoot\)/);
    assert.match(runtime, /if \(canStart\) startAgent\(launchAgent, \{ prompt: text \}\)/);
  });

  test("a turn in flight refuses", () => {
    assert.match(value, /streaming/);
  });

  test("a one-shot agent refuses the SECOND prompt, not the first", () => {
    // codex and opencode close stdin after one prompt (agent-console.js
    // § send, facts 4 and 5). Refusing from the start would be the same bug
    // again, in a narrower form: the first prompt is the one that works.
    //
    // `sent > 0` now sits inside the one-shot branch rather than beside it,
    // because a multi-turn agent gets a queue and no longer refuses mid-turn.
    assert.match(value, /oneShot && \(streaming \|\| sent > 0\)/);
  });

  test("a turn in flight only refuses where there is no queue to catch it", () => {
    // The queue is the whole point: the composer used to make you wait with a
    // thought you had already had.
    const runtime = readFileSync(path.join(BOARD, "lib", "runtime.tsx"), "utf8");
    assert.match(runtime, /queue: oneShot \? undefined : queue\.adapter/);
  });

  test("MULTI_TURN is the one place that knows which agents keep talking", () => {
    const constants = readFileSync(path.join(BOARD, "lib", "constants.ts"), "utf8");
    assert.match(constants, /export const MULTI_TURN/);
    assert.match(runtime, /MULTI_TURN\.has\(/);
    // A second hard-coded list is how the two drift apart.
    const launcher = readFileSync(path.join(BOARD, "components", "launcher.tsx"), "utf8");
    assert.ok(
      !/new Set\(\["claude"\]\)/.test(launcher),
      "launcher.tsx has its own copy of MULTI_TURN again",
    );
  });
});

describe("the fixture can exercise a second prompt", () => {
  // The dev fixture used to emit `exit` after every scripted turn, including
  // claude's. The composer is correctly disabled against a dead process, so a
  // fixture that always died could never show a second prompt being sent —
  // which is precisely the path that was broken.
  const fixture = readFileSync(path.join(BOARD, "lib", "fixture.ts"), "utf8");

  test("only the one-shot agents exit when their script ends", () => {
    assert.match(fixture, /if \(!MULTI_TURN\.has\(agent\)\) \{[\s\S]{0,160}type: "exit"/);
  });
});
