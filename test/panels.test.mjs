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
  for (const [file, label] of [
    ["turndetail.tsx", "What it did"],
    ["promptshelf.tsx", "Prompts"],
    ["runmeters.tsx", "Context, cost and timing"],
  ]) {
    test(`${label} starts collapsed`, () => {
      const src = read("components", file);
      assert.match(src, /useState\(false\)/, `${file} does not default to closed`);
      assert.match(src, /aria-expanded=\{open\}/, `${file} does not report its state`);
    });
  }

  test("the conversation mounts them under the thread, not inside it", () => {
    // Inside the Thread they would scroll with the transcript and take its
    // height; the column is a flex column so they sit beneath it.
    const c = read("components", "conversation.tsx");
    const body = c.indexOf("chat-thread-body");
    assert.ok(body > 0);
    for (const tag of ["<TurnDetail />", "<PromptShelf />", "<RunMeters />"]) {
      assert.ok(c.includes(tag), `${tag} is not mounted`);
      assert.ok(c.indexOf(tag) > body, `${tag} is inside the thread body`);
    }
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

  test("the background inbox is absent when nothing finished unseen", () => {
    assert.match(read("components", "inbox.tsx"), /return null/);
  });
});

describe("nothing is invented", () => {
  test("checkpoint history is deliberately not built", () => {
    // elements-checkpoint-history requires `files: number` per commit. The
    // status poll that records a moved sha has no file count and there is no
    // per-commit diff to recover one from, so any number there would read as
    // real and be fabricated. Recorded here so the absence is a decision
    // rather than an oversight — if a files-changed count is ever added to
    // `checkpoints`, this test is the note saying it can now be built.
    const src = existsSync(path.join(BOARD, "components", "inbox.tsx"))
      ? read("components", "inbox.tsx")
      : "";
    assert.ok(
      !/CheckpointHistory[^a-zA-Z]/.test(src),
      "CheckpointHistory is rendered, but zevet has no per-commit file count to give it",
    );
  });

  test("the schedule card is deliberately not built", () => {
    // zevet runs nothing on a schedule. A schedule card would be a prop.
    const all = ["turndetail.tsx", "inbox.tsx", "conversation.tsx", "promptshelf.tsx"]
      .filter((f) => existsSync(path.join(BOARD, "components", f)))
      .map((f) => read("components", f))
      .join("\n");
    assert.ok(!/ScheduleCard/.test(all));
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

  test("every localStorage touch is guarded", () => {
    // Private mode and cleared site data both throw on access, and a throw
    // here would take the panel down with it.
    const touches = (src.match(/localStorage/g) || []).length;
    const guards = (src.match(/try\s*\{/g) || []).length;
    assert.ok(touches > 0, "the library does not persist at all");
    assert.ok(guards >= 2, `${touches} localStorage uses and only ${guards} try blocks`);
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
    assert.match(runtime, /const dictation = useMemo\(\(\) => new WebSpeechDictationAdapter\(\), \[\]\)/);
  });

  test("only multi-turn agents get a queue", () => {
    // codex and opencode close stdin after one prompt, so a queued second
    // prompt would be accepted by the UI and delivered to a closed pipe.
    assert.match(runtime, /queue: oneShot \? undefined : queue\.adapter/);
  });

  test("the queue is driven from the run's edges", () => {
    assert.match(runtime, /notifyBusy\(\)/);
    assert.match(runtime, /notifyIdle\(\)/);
  });
});
