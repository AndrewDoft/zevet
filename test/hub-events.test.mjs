// The board survives a restart.
//
// The hub used to keep events in memory alone: every deploy and every crash
// forgot the whole board. Now each event is appended to var/events.jsonl and
// the tail is replayed at boot. These tests hand one file to two hubs in a row
// through ZEVET_EVENTS — the only callers that share a log on purpose.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHub, post, state, TOKEN } from "./helpers.mjs";

function eventLog(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-events-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "events.jsonl");
}

const evt = (tool) => ({ kind: "tool", tool, actor: "t", repo: "r", agent: "claude-code" });

describe("event persistence", () => {
  test("a restart replays the log instead of starting empty", async (t) => {
    const file = eventLog(t);
    const one = await startHub({ ZEVET_EVENTS: file });
    try {
      assert.equal((await post(one.base, evt("Read"))).status, 200);
      assert.equal((await post(one.base, evt("Bash"))).status, 200);
    } finally {
      await one.stop();
    }

    const two = await startHub({ ZEVET_EVENTS: file });
    try {
      const s = await state(two.base, TOKEN);
      assert.deepEqual(
        s.body.events.map((e) => e.tool),
        ["Read", "Bash"],
        "the second hub did not replay the first hub's board",
      );
    } finally {
      await two.stop();
    }
  });

  test("a corrupt line does not take the rest of the log with it", async (t) => {
    const file = eventLog(t);
    writeFileSync(file, '{"kind":"tool","tool":"Read"}\nthis is not json\n{"kind":"tool","tool":"Bash"}\n');
    const hub = await startHub({ ZEVET_EVENTS: file });
    try {
      const s = await state(hub.base, TOKEN);
      assert.deepEqual(s.body.events.map((e) => e.tool), ["Read", "Bash"]);
    } finally {
      await hub.stop();
    }
  });

  test("the in-memory window stays capped while the log keeps everything", async (t) => {
    const file = eventLog(t);
    const hub = await startHub({ ZEVET_EVENTS: file, ZEVET_MAX_EVENTS: "5" });
    try {
      for (let i = 0; i < 8; i++) {
        assert.equal((await post(hub.base, evt(`tool-${i}`))).status, 200);
      }
      const s = await state(hub.base, TOKEN);
      assert.deepEqual(
        s.body.events.map((e) => e.tool),
        ["tool-3", "tool-4", "tool-5", "tool-6", "tool-7"],
        "the live window is not the newest MAX_EVENTS",
      );
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      assert.equal(lines.length, 8, "the log must keep what memory drops");
    } finally {
      await hub.stop();
    }
  });
});
