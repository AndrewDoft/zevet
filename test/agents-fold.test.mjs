import { test } from "node:test";
import assert from "node:assert/strict";
import { agentsOf, foldAgent, withState } from "../board/src/lib/agents.mjs";

const ev = (o) => ({ actor: "kai", machine: "m", repo: "r", branch: "b", agent: "claude-code", ...o });

test("two sessions of one person are two agents; the same session is one", () => {
  const rows = agentsOf([ev({ ts: 1, kind: "prompt", detail: "a", session: "s1" }), ev({ ts: 2, kind: "prompt", detail: "b", session: "s2" }), ev({ ts: 3, kind: "tool", tool: "Edit", target: "x.ts", session: "s1" })], 4);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.session === "s1").current, "Edit  x.ts");
});

test("a late-arriving older event does not rewind the agent", () => {
  const m = new Map();
  foldAgent(m, ev({ ts: 10, kind: "tool", tool: "Bash", detail: "ls", session: "s" }));
  foldAgent(m, ev({ ts: 5, kind: "prompt", detail: "old", session: "s" }));
  assert.equal([...m.values()][0].current, "Bash  ls");
  assert.equal([...m.values()][0].mission, "old", "but it fills a mission the agent lacked");
  foldAgent(m, ev({ ts: 4, kind: "prompt", detail: "older still", session: "s" }));
  assert.equal([...m.values()][0].mission, "old", "and never overwrites one it has");
});

test("state: working, then idle after the window, finished after turn_end; 12h old agents vanish", () => {
  const base = { ...ev({ session: "s" }), firstTs: 0, mission: "", current: "", ended: false };
  const [w] = withState([{ ...base, key: "w", lastTs: 1000 }], 2000, 90000);
  const [i] = withState([{ ...base, key: "i", lastTs: 1000 }], 200000, 90000);
  const [f] = withState([{ ...base, key: "f", lastTs: 1000, ended: true }], 2000, 90000);
  assert.deepEqual([w.state, i.state, f.state], ["working", "idle", "finished"]);
  assert.equal(withState([{ ...base, key: "o", lastTs: 1000 }], 13 * 3600 * 1000, 90000).length, 0);
});
