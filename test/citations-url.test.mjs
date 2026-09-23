// Citations stripped the URL out of a search result line and never stored
// it (Source had domain/title/snippet, no url), so the numbered chips
// opened a preview with no way to reach the actual source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const read = (rel) => readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");

test("Source carries a url, and the popup opens it via window.open", () => {
  const el = read("board/src/components/assistant-ui/elements/inline-citation.tsx");
  assert.match(el, /export interface Source \{[^}]*url\?: string;/s);
  assert.match(el, /window\.open\(source\.url, "_blank", "noopener,noreferrer"\)/);
});

test("knowledge.tsx keeps the matched URL when building a Source", () => {
  const kn = read("board/src/components/knowledge.tsx");
  const fn = kn.slice(kn.indexOf("function searchCalls"), kn.indexOf("function searchCalls") + 800);
  assert.ok(fn.includes("const match = l.match("), "matches the URL out of the line");
  assert.match(fn, /url: match \? match\[0\] : undefined,/);
});
