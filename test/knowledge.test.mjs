// Bugs found running the board, and refusals made on purpose, pinned so
// neither regresses silently. Each test names the bug or the decision it
// pins in a comment above it. Companion to panels.test.mjs (the 0.2.14
// panel rules) and elements.test.mjs (the installed-element ledger) — this
// file does not repeat what either already checks.
//
// The gate runs `node --test` against source and cannot import TypeScript,
// so every assertion here scans source text rather than importing it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const BOARD = path.join(ROOT, "board", "src");
const read = (...p) => readFileSync(path.join(BOARD, ...p), "utf8");

describe("usage is attributed per console, not globally", () => {
  // Bug: strip.live is ONE set of numbers and three agents can run at once,
  // so whichever spoke last owned the rail AND the meters under whichever
  // thread you were reading. board.ts now resolves the reporting console
  // from the event id and only lets it drive the strip when it is the one
  // in front.
  const board = read("lib", "board.ts");

  test("ConsoleEntry carries its own usage", () => {
    const types = readFileSync(path.join(BOARD, "lib", "types.ts"), "utf8");
    const entry = types.slice(types.indexOf("interface ConsoleEntry"), types.indexOf("interface ConsoleUsage"));
    assert.match(entry, /usage:\s*ConsoleUsage;/);
    assert.match(types, /interface ConsoleUsage \{/);
  });

  test("the strip update is gated on the reporting console being the front one", () => {
    assert.match(board, /const cu = consoleById\(evt\.id\)/);
    assert.match(board, /if \(cu\) recordUsage\(cu, u, cost\)/);
    assert.match(board, /const front = selectActiveConsole\(useBoard\.getState\(\)\)/);
    assert.match(board, /if \(!cu \|\| !front \|\| front\.key === cu\.key\)/);
  });
});

// The context series only records a reading that moved. claude repeats the
// same usage block across several payloads of one turn, and a flat run of
// identical points draws a line that says the context stalled.
test("the usage series only appends when the reading changed", () => {
  const board = read("lib", "board.ts");
  const fn = board.slice(board.indexOf("function recordUsage("), board.indexOf("function usageOf("));
  assert.match(fn, /if \(prev\.series\[prev\.series\.length - 1\] !== u\.context\)/);
});

// The raw parts are kept, not recovered from a percentage. usageOf returns
// input, cachedInput and output; ConsoleUsage declares them — so a panel
// that prints "cached" prints the number the agent reported rather than a
// share back-computed from a rounded cacheHit.
test("usage keeps input, cachedInput and output as their own fields", () => {
  const board = read("lib", "board.ts");
  const usageOf = board.slice(board.indexOf("function usageOf("));
  assert.match(usageOf, /input:/);
  assert.match(usageOf, /cachedInput:/);
  assert.match(usageOf, /output:/);
  const types = readFileSync(path.join(BOARD, "lib", "types.ts"), "utf8");
  const cu = types.slice(types.indexOf("interface ConsoleUsage"), types.indexOf("interface UsableAgent"));
  assert.match(cu, /input: number \| null;/);
  assert.match(cu, /cachedInput: number \| null;/);
  assert.match(cu, /output: number \| null;/);
});

// The checkpoint list is sliced. repoCommits is fetched 200 deep (board.ts
// asks for 200) so the activity graph can cover weeks, and Checkpoints
// shipped one release rendering all of them — a wall of 200 commits in a
// pane that answers "where am I".
test("Checkpoints slices repoCommits rather than rendering all 200", () => {
  const board = read("lib", "board.ts");
  assert.match(board, /commits\(root, 200\)/);
  const repoviews = read("components", "repoviews.tsx");
  assert.match(repoviews, /commits\.slice\(0, 8\)/);
});

// Read-aloud speaks prose, not markup. The bug, heard: the synthesiser said
// "backtick backtick backtick mermaid flowchart L R A open square bracket
// agent stdout". speakable strips fenced code blocks before the text is
// split into words, and wordsOf goes through it.
test("read-aloud strips fenced code before splitting into words", () => {
  const speech = read("components", "speech.tsx");
  assert.match(speech, /const speakable = \(text: string\): string =>/);
  assert.match(speech, /\.replace\(\/```\[\\s\\S\]\*\?```\/g, " "\)/);
  assert.match(speech, /const wordsOf = /);
  assert.match(speech, /speakable\(textOf\(content\)\)/);
});

// The find shelf counts text, not messages. The first gate was
// messages.length < 2 and the row never appeared against a real run,
// because transcript.mjs keeps ONE assistant message open across a whole
// turn and appends parts to it.
test("the find shelf gates on character count, not message count", () => {
  const src = read("components", "findshelf.tsx");
  assert.match(src, /words < 80/);
  assert.ok(!/messages\.length < 2/.test(src), "the find shelf still gates on message count");
});

// Panels in a collapsed row may not be crushed. The bug: those bodies are
// flex columns with a max-height, so a panel whose height comes from a
// min-height further inside it — the Diagram's canvas — shrank to a 1px
// line with its contents spilling out.
test("collapsed-row panel bodies carry flex: none on their children", () => {
  const css = readFileSync(path.join(BOARD, "styles", "masora.css"), "utf8");
  assert.match(
    css,
    /\.turn-detail-body > \*, \.prompt-shelf-body > \*, \.find-shelf-body > \*, \.listen-shelf-body > \* \{\s*\n\s*max-width: none; width: 100%; flex: none;/,
  );
});

// The mermaid SVG is fitted to its card. The emitted SVG is ~932px wide at
// its natural size and hung out of both sides of the transcript column with
// the end nodes clipped.
test("the mermaid SVG is constrained to its card's width", () => {
  const src = read("components", "mermaid.tsx");
  assert.match(src, /\[&>svg\]:h-auto \[&>svg\]:max-w-full/);
});

// Nothing offers to forget a memory. runspec.tsx renders MemoryChips with no
// onForget, and desktop/main.js's local:memories handler contains no
// delete/unlink/rm call — it only reads. Comments are stripped before
// scanning for the absent name: twice now a test has failed by matching the
// word inside the comment that explained why the thing was absent (see
// test/panels.test.mjs and test/layout.test.mjs).
test("nothing offers to forget a memory", () => {
  const runspec = read("components", "runspec.tsx");
  const runspecCode = runspec.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/onForget/.test(runspecCode), "runspec.tsx offers a forget it cannot perform");

  const main = readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8");
  const start = main.indexOf('ipcMain.handle("local:memories"');
  assert.ok(start > 0, "local:memories handler not found");
  const end = main.indexOf("ipcMain.handle(", start + 1);
  const handler = main.slice(start, end > 0 ? end : undefined)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const dangerous of ["unlink", "rmSync", "rm(", "delete "]) {
    assert.ok(!handler.includes(dangerous), `local:memories handler can ${dangerous}`);
  }
});

// The registry's demo prose is patched out of inline-citation. sync-registry
// COPY replaces the element's hardcoded sentence and its two fixed citation
// slots with {children} and a map over all sources. The element shipped as
// a demo, so a caller handing it real search results would have had
// somebody else's prose attributed to them.
test("inline-citation's demo sentence is patched out by sync-registry and gone from the installed file", () => {
  const sync = readFileSync(path.join(ROOT, "board", "scripts", "sync-registry.mjs"), "utf8");
  assert.match(sync, /Optimistic updates keep the thread responsive while the server confirms/);
  assert.match(sync, /to: `      \{children\}\n {6}\{sources\.map\(\(source, index\) => \(/);

  const installed = read("components", "assistant-ui", "elements", "inline-citation.tsx");
  assert.ok(
    !installed.includes("Optimistic updates keep the thread responsive"),
    "the installed inline-citation.tsx still carries the demo sentence",
  );
  assert.match(installed, /\{children\}/);
  assert.match(installed, /sources\.map\(\(source, index\) =>/);
});

// document-reference counts lines, not pages. The element was written for
// PDFs, zevet's documents are source files, and "p. 412" of a file is a
// page that does not exist.
test("document-reference cites lines, not pages", () => {
  const sync = readFileSync(path.join(ROOT, "board", "scripts", "sync-registry.mjs"), "utf8");
  assert.match(sync, /from: "p\. \{anchor\.page\}"/);
  assert.match(sync, /to: "L\{anchor\.page\}"/);

  const installed = read("components", "assistant-ui", "elements", "document-reference.tsx");
  assert.match(installed, /L\{anchor\.page\}/);
  assert.ok(!installed.includes("p. {anchor.page}"), "document-reference.tsx still prints a page number");
});

// The prompt library writes to the real composer. The bug: the old bridge
// (noteComposing/composingState) was a module-level string left over from
// the old textarea composer, so Insert wrote to a variable nobody displayed
// and Save draft read back whatever Insert last wrote rather than what you
// had typed. Both buttons did nothing. promptlib.tsx now goes through
// assistant-ui's own composer, and the dead bridge is gone from board.ts.
test("the prompt library drives assistant-ui's composer, not a dead string bridge", () => {
  const promptlib = read("components", "promptlib.tsx");
  assert.match(promptlib, /useAui/);
  assert.match(promptlib, /aui\.composer\.setText\(/);

  const board = read("lib", "board.ts");
  assert.ok(!/noteComposing/.test(board), "board.ts still has noteComposing");
  assert.ok(!/composingState/.test(board), "board.ts still has composingState");
});
