// Three assistant-ui elements whose action button is always rendered and
// enabled, but whose only real call site never passes the handler it fires —
// so clicking did nothing. Found in the views.md audit, verified against the
// call sites before fixing. Source assertions: these are TSX components that
// import React/Tailwind class helpers and are not meant to be unit-rendered
// outside the app (no jsdom in this repo).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const src = (rel) => readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");

describe("CodeRunner's play button (moreviews.tsx's CommandRuns passes no onRun)", () => {
  test("disabled when no onRun is wired, same as diagram.tsx's onExpand guard", () => {
    const el = src("board/src/components/assistant-ui/elements/code-runner.tsx");
    assert.match(el, /disabled=\{!onRun \|\| state === "running"\}/);
  });
});

describe("WebPreview's reload button (moreviews.tsx's Pages passes no onReload)", () => {
  test("disabled when no onReload is wired", () => {
    const el = src("board/src/components/assistant-ui/elements/web-preview.tsx");
    assert.match(el, /disabled=\{!onReload\}/);
  });
});

describe("RecommendationCard's Alternatives button (moreviews.tsx's NextStep passes no onAlternatives)", () => {
  test("hidden entirely when no onAlternatives is wired", () => {
    const el = src("board/src/components/assistant-ui/elements/recommendation-card.tsx");
    assert.match(el, /\{onAlternatives \? \(/);
  });
});
