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

test("composer gate sends normally or waits for explicit cancel/send-anyway", async () => {
  const { composerGate } = await import("../desktop/overlap-check.js");
  const hit = [{ actor: "Kai", session: "s", label: "overlapping" }];
  assert.deepEqual(composerGate(hit, "cancel"), { action: "cancel" });
  assert.deepEqual(composerGate(hit, "send"), { action: "send" });
  assert.deepEqual(composerGate([], undefined), { action: "send" });
});
