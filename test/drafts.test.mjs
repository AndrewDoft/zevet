// The composer's saved draft, and when it is offered back (lib/drafts.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const { draftChange } = await import(pathToFileURL(path.join(ROOT, "board", "src", "lib", "drafts.mjs")).href);

test("typing saves; sending (the text going empty) forgets", () => {
  assert.equal(draftChange({ key: "1", text: "" }, "1", "hel"), "save");
  assert.equal(draftChange({ key: "1", text: "hello" }, "1", ""), "forget");
});

test("a mount with an empty composer leaves the leftover draft alone", () => {
  assert.equal(draftChange(null, "1", ""), null);
});

test("switching threads files nothing under the new one", () => {
  // The composer is shared, so its text arrives with the switch.
  assert.equal(draftChange({ key: "1", text: "for A" }, "2", "for A"), null);
  assert.equal(draftChange({ key: "1", text: "for A" }, "2", ""), null);
});

test("no thread, no draft", () => {
  assert.equal(draftChange({ key: "1", text: "x" }, null, ""), null);
});
