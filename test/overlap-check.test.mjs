import test from "node:test";
import assert from "node:assert/strict";
import { classifyOverlap, OVERLAP_THRESHOLDS } from "../desktop/overlap-check.js";

test("classifies same path or branch as overlapping and similarity as adjacent/overlapping", async () => {
  const embed = async (texts) => texts.map((text) => text.includes("database") ? [1, 0] : [0, 1]);
  const hits = await classifyOverlap({
    task: "update the database retry path",
    branch: "feat/other",
    openPaths: ["src/db.ts"],
    plannedPaths: [],
    active: [
      { actor: "Kai", session: "s-kai", branch: "feat/other", openPaths: ["src/queue.ts"], plannedPaths: [], task: "update database indexes" },
      { actor: "Mina", session: "s-mina", branch: "feat/mina", openPaths: ["src/db.ts"], plannedPaths: [], task: "unrelated" },
    ],
    embed,
  });
  assert.equal(hits[0].label, "overlapping");
  assert.equal(hits[0].actor, "Kai");
  assert.equal(hits[1].label, "overlapping");
  assert.equal(hits[1].actor, "Mina");
  assert.ok(OVERLAP_THRESHOLDS.textOverlap > OVERLAP_THRESHOLDS.textAdjacent);
});

test("an agent with no task text (a claim) is never scored on text", async () => {
  // "" embeds like everything else; it must not be called "similar" to the prompt.
  const embed = async (texts) => texts.map(() => [1, 0]);
  const hits = await classifyOverlap({ task: "anything", plannedPaths: [], active: [{ actor: "Kai", session: "s", task: "", openPaths: ["a/b.ts"] }], embed });
  assert.deepEqual(hits, []);
});

test("files at the repo root are not 'the same folder'", async () => {
  const hits = await classifyOverlap({ task: "x", plannedPaths: ["a.ts"], active: [{ actor: "Kai", session: "s", openPaths: ["b.ts"] }] });
  assert.deepEqual(hits, []);
});
