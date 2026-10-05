import test from "node:test";
import assert from "node:assert/strict";
import { authorChangeTokens } from "../board/src/lib/change-colors.mjs";

const roster = [{ actor: "andrew" }, { actor: "priya" }];

test("known author additions resolve to that member's hue", () => {
  const tokens = authorChangeTokens("priya", roster, "added");
  assert.equal(tokens["--change-fg"], "var(--who-1)");
  assert.match(tokens["--change-bg"], /var\(--who-1\)/);
});

test("known author removals keep the same hue and use a muted variant", () => {
  const tokens = authorChangeTokens("priya", roster, "removed");
  assert.equal(tokens["--change-fg"], "var(--who-1)");
  assert.match(tokens["--change-bg"], /18%/);
});

test("unknown authors use the legacy accessible fallbacks", () => {
  assert.equal(authorChangeTokens("nobody", roster, "added")["--change-fg"], "#15803d");
  assert.equal(authorChangeTokens("nobody", roster, "removed")["--change-fg"], "#b91c1c");
});
