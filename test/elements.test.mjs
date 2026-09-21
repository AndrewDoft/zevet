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
const UNRENDERED = {
  /* --- the panel that hosted them was deleted --------------------------- */
  "read-aloud.tsx":
    "removed with: its host, the read-aloud shelf under the composer, was one of five collapsed rows that each pushed the chat box up when opened. It was the body of that shelf. Andrew, 2026-09-21: \"delete what it did, find, and read aloud\". Speaking the transcript aloud was browser speech synthesis over text already on screen, so nothing zevet measures is lost with it.",
  "speaker-identity.tsx":
    "removed with: the same host as read-aloud. It labelled which turn of a read-aloud was being spoken, so without the reading there is no speaker to identify. It is the only element here whose data was produced by another element rather than by an agent.",

  /* --- no data ---------------------------------------------------------- */
  "approval-card.tsx":
    "not the shape: it models ONE command awaiting approval — one state, one command string, one button row, with nowhere to put a second. zevet's permits arrive as a queue, so permission-grant shows the oldest and permits.tsx counts the rest. Rendering this card N times would just be that panel again, duplicated.",
  "elicitation-form.tsx":
    "no data: MCP elicitation, where a server asks the person a question mid-run. zevet now HAS an MCP server, so this is the closest of the unbuilt ones — what is missing is a reason for that server to ask anything. Its four tools take coordinates and text from the agent, not from the person. The day one of them needs an answer, the form is ready and the loopback gate already carries questions to the board.",
  "image-generation.tsx":
    "no data: no agent CLI here generates images. Reading a PNG off disk is not generating one, and the card says 'generating'.",
  "map-answer.tsx":
    "no data: pins need coordinates. Nothing zevet records is a place.",
  "reviewable-diff.tsx":
    "no data: it offers accept/reject per hunk. zevet does not apply the agent's edits — the agent writes files itself — so both buttons would be decorations.",
  "feedback-dialog.tsx":
    "no data: thumbs up or down, sent where? zevet has no feedback endpoint and no model provider to send one to. A submit button with nowhere to submit is the ToolError Retry mistake again.",
  "voice-conversation.tsx":
    "no data: a live two-way voice session with turn-taking. zevet's voice is Web Speech dictation in and, with read-aloud, speech out — neither is a connected session, and drawing one would claim a channel that does not exist.",

  /* --- not the shape ---------------------------------------------------- */
  "launcher-bubble.tsx":
    "not the shape: a floating bubble for embedding a chat on somebody's website. zevet is the window.",
  "mobile-composer.tsx":
    "not the shape: the board reaches a phone through the hub, but the composer needs the desktop bridge to reach an agent, so on a phone there is nothing to compose to.",
  "shared-conversation.tsx":
    "not the shape: the hub relays events between teammates, not transcripts. There is no other person's thread to show.",
  "canvas-split.tsx":
    "not the shape: zevet already splits, with panes that remember their sizes (PANE_KEY). A second splitter would be a second answer to a solved question.",
  "chat-panel.tsx":
    "not the shape: a wrapper around a thread. conversation.tsx is zevet's, and it carries the launcher, the postures and the three CLIs that the wrapper knows nothing about.",
  "onboarding.tsx":
    "not the shape: zevet's first run is the desktop app's setup window (desktop/setup.html) — sign in, pick a repo, install hooks. It happens before the board exists.",
  "agent-card.tsx":
    "not the shape: tried, reverted. In the 180px rail it overlapped its own text and pushed two of three teammates off screen. consoles.tsx uses agent-status instead, which fits.",

  /* --- superseded ------------------------------------------------------- */
  "syntax-highlighter.tsx":
    "superseded: it is Prism via react-syntax-highlighter — 2.3 MB of source, two complete engines, in a board that already ships its own highlighter as a side bundle. components/highlight.tsx is the same contract with zevet's engine behind it.",
  "shiki-highlighter.tsx":
    "superseded: same reason as syntax-highlighter, a third engine.",
  "generative-ui.tsx":
    "no data: a renderer for a model that emits a UI tree. The three CLIs emit text, tool calls and JSONL — nothing that this could render.",
  "model-picker.tsx":
    "superseded: it was here, and Andrew's words were that the 'one prompt' line under every model made no sense — it is a fact about the agent, repeated eleven times as if it described the model. model-selector groups, searches, and carries reasoning effort.",
  "reasoning-effort.tsx":
    "superseded: model-selector has the effort control built in, and only shows it for a model that declares support (codex).",
  "message-queue.tsx":
    "superseded: the queue is real but it lives in the runtime — createMessageQueue in lib/runtime.tsx, offered only to multi-turn agents. The composer renders its own queue UI.",
  "heat-graph.tsx":
    "superseded: activity-graph already wraps the heat-graph package. This is the standalone wrapper for drawing one without it.",

  /* --- the Thread builds its own ---------------------------------------- *
   * thread.aui.tsx composes a transcript out of assistant-ui primitives and
   * the handful of elements it imports by name. Each of these is the
   * standalone variant of a part it builds inline — useful when you are
   * assembling a thread by hand, redundant when you are not. Rendering both
   * would put two of the same thing on the screen. */
  "composer.tsx":
    "superseded: the Thread composes its own composer, with zevet's dictation, queue and attachment adapters attached to it by lib/runtime.tsx.",
  "message-pair.tsx":
    "superseded: the Thread lays out its own user/assistant pairs.",
  "message-actions.tsx":
    "superseded: the Thread renders its own action row under a message.",
  "scroll-anchor.tsx":
    "superseded: the Thread's viewport owns its own scroll anchoring.",
  "day-separator.tsx":
    "superseded: the Thread separates its own messages, and a console is one session — a day boundary inside one is rare enough that the element would almost never appear.",
  "streaming-text.tsx":
    "superseded: the Thread streams its own text parts as the transcript appends to them.",
  "typing-indicator.tsx":
    "superseded: thinking-indicator is the one zevet shows, because the gap worth reporting is before the first token rather than between them — see conversation.tsx.",
  "loading-state.tsx":
    "superseded: empty-state and thinking-indicator cover the two waits the board actually has.",
  "tool-group.tsx":
    "superseded: the Thread imports tool-group.aui, the runtime-bound variant of the same thing.",
  "tool-timeline.tsx":
    "superseded: trace-waterfall carries the same per-call timings, with durations, in turndetail (which lives in the detail column now, not under the chat box).",
  "reasoning-panel.tsx":
    "superseded: the Thread imports reasoning.aui, which reads the reasoning parts transcript.mjs records.",
  "sources.aui.tsx":
    "superseded: it lists sources under a message from the runtime's own store, which zevet's external store does not populate. inline-citation carries the real WebSearch results instead.",
  "thread-list.tsx":
    "superseded: consoles.tsx is zevet's own list, because a console row has to carry a posture, a stop button and an agent state that a generic thread row knows nothing about.",

  /* --- runtime-bound variants ------------------------------------------- *
   * A `.aui` file reads assistant-ui's own store. zevet's runtime is an
   * external store over three CLIs, so the ones below are bound to state
   * nothing here fills. The plain-props sibling is used instead wherever
   * zevet has the fact. */
  "thread-list.aui.tsx":
    "runtime-bound: threads in the assistant-ui store. zevet's threads are OS processes; see consoles.tsx.",
  "threadlist-sidebar.aui.tsx":
    "runtime-bound: the same list in a sidebar. zevet's rail is its own, and it carries teammates as well as consoles.",
  "assistant-modal.aui.tsx":
    "not the shape: a chat popped over somebody else's page. zevet is the page.",
  "assistant-sidebar.aui.tsx":
    "not the shape: a chat docked beside somebody else's app, for the same reason.",
  "model-selector.aui.tsx":
    "runtime-bound: it picks a model out of the runtime's model list. zevet's models come from three CLIs and a generated free-model catalogue, so model-choice.tsx drives the plain model-selector with those.",
  "context-display.aui.tsx":
    "runtime-bound: reads usage off the runtime. zevet's usage is recorded per console from each agent's own payloads, so mapviews.tsx drives the plain one with those.",
  "shiki-highlighter.aui.tsx":
    "superseded: a third highlighting engine, bound to the runtime. See syntax-highlighter above.",
  "mcp-config.aui.tsx":
    "not the shape: editing MCP config through the runtime. zevet shows what claude announces and changes nobody else's settings.",
  "voice.aui.tsx":
    "no data: it binds to a live voice SESSION — connect, mute, disconnect. zevet's voice is Web Speech dictation into the composer, which is a different thing; brand.tsx drives the pure orb off that instead, and calling it a connection would be a lie about what is running.",
  "quote.aui.tsx":
    "runtime-bound: quoting through the runtime's own composer state.",
  "directive-text.tsx":
    "no data: it renders slash-command directives a model emits. The three CLIs emit text, tool calls and JSONL; none of them emits a directive.",
  "directive-text.aui.tsx":
    "no data: the runtime-bound form of the same thing — it reads directives out of the store, and nothing puts any there.",
  "composer-trigger-popover.aui.tsx":
    "runtime-bound: a popover that fires a runtime directive from the composer. Same missing vocabulary as directive-text.",
};

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
