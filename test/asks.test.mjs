// board/src/lib/board.ts and board/src/components/asks.tsx are TypeScript/TSX,
// which this suite does not execute — same reasoning as board-theme.test.mjs
// gives for board.ts's theme actions: node --test has no transpiler, so the
// contract is pinned against the source text instead, the same way every
// other TS-only behaviour in this repo is tested.
//
// Two things matter enough to break the build silently otherwise:
//   1. the store pushes an ask on request and removes it BY ID on answer
//      (mirrors permits' onPermitRequest/answerPermit pair one-for-one);
//   2. the card answers with the option's LABEL, never its index — the wire
//      contract (local:askAnswer's `picked: string[]`) is defined against
//      labels, and a renumbered `options` array would silently answer the
//      wrong thing if this ever regressed to sending indices.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const board = readFileSync(path.join(ROOT, "board", "src", "lib", "board.ts"), "utf8");
const bridge = readFileSync(path.join(ROOT, "board", "src", "lib", "bridge.ts"), "utf8");
const asksCard = readFileSync(path.join(ROOT, "board", "src", "components", "asks.tsx"), "utf8");
const conversation = readFileSync(path.join(ROOT, "board", "src", "components", "conversation.tsx"), "utf8");

describe("the wire contract", () => {
  test("AskRequest and the two LocalBridge members are declared", () => {
    assert.match(bridge, /interface AskRequest \{[\s\S]*?id: string;[\s\S]*?question: string;[\s\S]*?header: string;[\s\S]*?multi: boolean;[\s\S]*?options: Array<\{ label: string; description: string \}>;/);
    assert.match(bridge, /onAskRequest\?:\s*\(cb: \(req: AskRequest\) => void\) => \(\) => void;/);
    assert.match(bridge, /askAnswer\?:\s*\(id: string, picked: string\[\]\) => Promise<\{ ok: boolean; error\?: string \}>;/);
  });
});

describe("the store", () => {
  test("asks is in state, seeded empty", () => {
    assert.match(board, /asks: AskRequest\[\];/);
    assert.match(board, /^\s*asks: \[\],\s*$/m);
  });

  test("onAskRequest pushes the request onto asks, guarded by a string id", () => {
    assert.match(
      board,
      /bridge\.local\.onAskRequest\(\(req\) => \{\s*if \(!req \|\| typeof req\.id !== "string"\) return;\s*useBoard\.setState\(\(g\) => \(\{ asks: \[\.\.\.g\.asks, req\] \}\)\);/,
    );
  });

  test("answerAsk removes the question BY ID, the same shape as answerPermit", () => {
    assert.match(
      board,
      /export async function answerAsk\(id: string, picked: string\[\]\): Promise<void> \{\s*const br = bridge\.local;\s*useBoard\.setState\(\(g\) => \(\{ asks: g\.asks\.filter\(\(a\) => a\.id !== id\) \}\)\);/,
    );
    // Answers go through the SAME optional member the bridge declares —
    // a typo here would type-check against an `any` but never fire on a
    // real desktop build.
    assert.match(board, /typeof br\.askAnswer !== "function"/);
    assert.match(board, /await br\.askAnswer\(id, picked\)/);
  });
});

describe("the card", () => {
  test("both prompt and queue are mounted next to the permit card", () => {
    assert.match(conversation, /import \{ AskPrompt, AskQueue \} from "\.\/asks";/);
    assert.match(conversation, /<AskPrompt \/>/);
    assert.match(conversation, /<AskQueue \/>/);
  });

  test("single-select answers with the clicked LABEL, not an index", () => {
    // choose(label) is what onClick wires to every option button. Pull its
    // own body out (not just "grep the file") so a regression that keeps
    // `[label]` somewhere else — the keyboard handler below — cannot hide a
    // broken click path.
    const body = /const choose = \(label: string\) => \{([\s\S]*?)\n  \};/.exec(asksCard);
    assert.ok(body, "choose() not found");
    assert.match(body[1], /void answerAsk\(ask\.id, \[label\]\);/);
    assert.ok(!/indexOf|options\[.*i.*\]/.test(body[1]), "choose() must answer with the label, not a derived index");
    // The number-key path resolves the digit to a label BEFORE it touches
    // answerAsk or the picked set — `n` itself is never passed onward.
    assert.match(asksCard, /const label = ask\.options\[n - 1\]\.label;/);
    assert.ok(!/answerAsk\(ask\.id, \[n\]\)/.test(asksCard), "a number key must resolve to a label before answering");
  });

  test("multi-select requires a non-empty pick, and confirms with the whole set", () => {
    assert.match(asksCard, /disabled=\{!picked\.length\}/);
    assert.match(asksCard, /onClick=\{\(\) => void answerAsk\(ask\.id, picked\)\}/);
  });

  test("it says out loud that this is blocking the agent", () => {
    assert.match(asksCard, /blocked until answered/);
  });
});
