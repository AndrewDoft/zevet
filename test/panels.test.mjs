// The panels added in 0.2.14, and the two rules they all have to follow.
//
// RULE ONE: closed by default. The run meters shipped as three cards always
// open under the transcript, and on a real window that took two thirds of the
// pane's height and left the conversation — the thing the view exists for — a
// strip at the top. 0.2.14 adds five more panels. Every one of them is behind
// a collapsed row.
//
// RULE TWO: nothing invented. An element whose props do not fit zevet's data
// is left unbuilt rather than fed a number that looks real.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const BOARD = path.join(ROOT, "board", "src");
const read = (...p) => readFileSync(path.join(BOARD, ...p), "utf8");

describe("every added panel is closed by default", () => {
  /* ⚠️ runmeters.tsx IS NO LONGER IN THIS LIST, and not because the rule was
     relaxed. It stopped being a collapsed row: it is the body of a card the
     composer opens over the transcript, absolutely positioned, so it has no
     open/closed height to default. layout.test.mjs pins that directly.
     turndetail.tsx is still a collapsed row and still starts closed — it just
     lives in the detail column now rather than under the chat box. */
  for (const [file, label] of [["turndetail.tsx", "What it did"]]) {
    test(`${label} starts collapsed`, () => {
      const src = read("components", file);
      assert.match(src, /useState\(false\)/, `${file} does not default to closed`);
      assert.match(src, /aria-expanded=\{open\}/, `${file} does not report its state`);
    });
  }

  test("the conversation mounts nothing under the thread any more", () => {
    /* ⚠️ THIS TEST USED TO REQUIRE THE OPPOSITE: that TurnDetail, PromptShelf
       and RunMeters were all mounted BELOW `chat-thread-body`, on the
       reasoning that inside the Thread they would scroll with the transcript
       and take its height. Below it they still took height — just at the
       bottom, where it pushed the chat box up every time one opened.

       Andrew, 2026-09-21: "all of those dropdowns pop up under the chatbox,
       which are all superfluous ... the chatbox (and all of the windows and
       stuff for that matter) should never change positions or resize
       autonomously." Two were deleted, TurnDetail moved to the detail column,
       and the two kept panels became cards anchored to buttons in the
       composer's own row. So the rule now is that NONE of them is here. */
    const c = read("components", "conversation.tsx");
    assert.ok(c.indexOf("chat-thread-body") > 0);
    for (const tag of ["<TurnDetail />", "<PromptShelf />", "<RunMeters />", "<FindShelf />", "<ListenShelf />"]) {
      assert.ok(!c.includes(tag), `${tag} is still mounted under the chat box`);
    }
    // The detail column is where the one that survived went.
    assert.match(read("components", "detail.tsx"), /<TurnDetail \/>/);
  });
});

describe("a panel with nothing to say says nothing", () => {
  test("the turn detail hides itself when no tool has run", () => {
    const src = read("components", "turndetail.tsx");
    assert.match(src, /if \(!tools\) return null/);
  });

  test("the agent views each bail out rather than render an empty card", () => {
    const src = read("components", "agentviews.tsx");
    const nulls = (src.match(/return null/g) || []).length;
    assert.ok(nulls >= 5, `only ${nulls} of the five views can return null`);
  });
});

describe("nothing is invented", () => {
  // 0.2.14 left checkpoint-history and schedule-card unbuilt because the
  // elements ask for facts zevet did not have. 0.2.15 built the facts rather
  // than the fiction; what these now check is that the facts are real.
  const repoviews = read("components", "repoviews.tsx");

  test("the checkpoint file count comes from git, not from the board", () => {
    // The status poll only ever knew the sha had MOVED. A count derived from
    // `stats.diff` would describe the working tree, not the commit, and would
    // read as a per-commit number while being something else entirely.
    assert.match(repoviews, /files: c\.files/);
    const rs = readFileSync(path.join(ROOT, "desktop", "repo-stats.js"), "utf8");
    assert.match(rs, /async function commits\(/);
    assert.match(rs, /--shortstat/);
    assert.match(rs, /files? changed/);
  });

  test("reading the history cannot write to it", () => {
    // zevet's contract is that it does not touch your git history. The
    // element offers a restore; there is no bridge call that could perform
    // one, and the UI does not pretend otherwise.
    // Comments name the thing they rule out, so they are stripped first —
    // otherwise the note explaining why there is no restore fails the test
    // for offering one. (Second time this pattern has bitten; see
    // layout.test.mjs.)
    const code = repoviews.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/onRestore/.test(code), "the checkpoint list offers a restore zevet cannot perform");
    const rs = readFileSync(path.join(ROOT, "desktop", "repo-stats.js"), "utf8");
    const fn = rs.slice(rs.indexOf("async function commits("), rs.indexOf("module.exports"));
    for (const dangerous of ["checkout", "reset", "restore", "revert"]) {
      assert.ok(!fn.includes(dangerous), `commits() runs git ${dangerous}`);
    }
  });

  test("a schedule's next run is not claimed while it is paused", () => {
    // A disabled schedule keeps a nextAt in its record; printing it would say
    // it is about to run when it is not.
    assert.match(repoviews, /s\.enabled \? whenText\(s\.nextAt\) : "paused"/);
  });
});

describe("the command palette", () => {
  const src = read("components", "palette.tsx");

  test("it is an overlay that renders nothing while closed", () => {
    assert.match(src, /if \(!open\) return null/);
    assert.match(src, /fixed inset-0/);
  });

  test("Ctrl and Cmd both open it, and Escape closes it", () => {
    assert.match(src, /metaKey \|\| event\.ctrlKey/);
    assert.match(src, /toLowerCase\(\) === "k"/);
    assert.match(src, /"Escape"/);
  });

  test("the listener is removed again", () => {
    // A palette that keeps listening after unmount reopens over a board that
    // is no longer there.
    assert.match(src, /removeEventListener\("keydown"/);
  });
});

describe("the prompt library survives a browser that refuses storage", () => {
  const src = read("components", "promptlib.tsx");

  test("storage goes through zStorage, which already guards private mode and cleared site data", () => {
    assert.match(src, /import \{ zStorage \} from "\.\.\/lib\/bridge";/);
    assert.match(src, /zStorage\.getItem\(STORAGE_KEY\)/);
    assert.match(src, /zStorage\.setItem\(STORAGE_KEY,/);
    assert.ok(!/\blocalStorage\.(get|set|remove)Item\(/.test(src), "a raw localStorage call reappeared");
    // Malformed JSON is a separate failure from storage throwing, and still
    // has to fall back to the starter set rather than take the panel down.
    assert.match(src, /try\s*\{\s*const raw = zStorage\.getItem\(STORAGE_KEY\);/);
  });

  test("it keys its own namespace", () => {
    assert.match(src, /zevet\.prompts\.v1/);
  });
});

describe("voice and queuing", () => {
  const runtime = read("lib", "runtime.tsx");

  test("the composer has a dictation adapter", () => {
    assert.match(runtime, /WebSpeechDictationAdapter/);
    assert.match(runtime, /dictation,/);
  });

  test("the adapter is built once, not per render", () => {
    // It holds a SpeechRecognition session; a new one each render drops the
    // one that is listening.
    // The mic runs Masora Voice now, not the browser's Web Speech API - which
    // in Electron has no backend at all (it logged `Dictation error:
    // network` and flashed an unstyled white box). See lib/voice.ts.
    assert.match(runtime, /new MasoraVoiceDictationAdapter\(/);
  });

  test("only multi-turn agents get a queue, and only while one is running", () => {
    // codex and opencode close stdin after one prompt, so a queued second
    // prompt would be accepted by the UI and delivered to a closed pipe.
    //
    // `!active` joined that condition after a shipped bug: the runtime checks
    // `queue` before `onNew` and returns, so with no console open the first
    // prompt went into a queue nothing would ever drain and no agent started.
    // See composer.test.mjs for the full account.
    //
    // `reading` joined it later for the same class of reason: a session read
    // off disk has no process to send to, so the queue must be absent there
    // too or Send would swallow a prompt into nothing.
    assert.match(runtime, /queue: reading \|\| !active \|\| oneShot \? undefined : queue\.adapter/);
  });

  test("the queue is driven from the run's edges", () => {
    assert.match(runtime, /notifyBusy\(\)/);
    assert.match(runtime, /notifyIdle\(\)/);
  });
});
