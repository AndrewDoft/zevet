// Three cheap, clearly-right P2s from the views.md audit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const read = (rel) => readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");

test("WebFetch result past 4000 chars says so instead of reading as complete", () => {
  const src = read("board/src/components/moreviews.tsx");
  assert.match(src, /text\.length > 4000 \? <span className="text-foreground\/40">\{"\u2026truncated"\}<\/span> : null/);
});

test("DocumentReference omits 'through L...' when no line number was actually observed", () => {
  const el = read("board/src/components/assistant-ui/elements/document-reference.tsx");
  assert.match(el, /pages: number \| null;/);
  assert.match(el, /pages != null \? ` \u00b7 through L\$\{pages\}` : ""/);
  const kn = read("board/src/components/knowledge.tsx");
  assert.ok(kn.includes("const observed = reads.map((r) => maxLineNumberIn(r.text)).filter"));
  assert.ok(!/r\.offset \+ r\.limit - 1\)\);$/m.test(kn), "no more offset+limit-1 guess feeding pages");
});

test("RecommendationCard has no hard-coded confidence-bar meter", () => {
  const el = read("board/src/components/assistant-ui/elements/recommendation-card.tsx");
  assert.ok(!el.includes("CONFIDENCE_BARS"), "the fixed meter is gone");
  assert.match(el, /\{confidenceLabel\}/, "the label itself is kept");
});
