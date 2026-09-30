// The Zevet pick in the model selector, and how a routed turn is labelled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ZEVET_MODEL, withZevet } from "../board/src/lib/zevet-model.mjs";
import { appendAgentPayload, appendUserText, emptyTranscript } from "../board/src/lib/transcript.mjs";

const rows = [{ id: "claude:opus" }, { id: "claude:haiku" }, { id: "codex:gpt-6-luna" }];

test("Zevet is the FIRST entry, above every agent's models", () => {
  const all = withZevet(rows, [{ ok: true }]);
  assert.equal(all[0].id, "zevet:auto");
  assert.equal(all[0].name, "Zevet");
  assert.deepEqual(all.slice(1), rows);
});

test("Zevet is not offered when nothing here can run", () => {
  assert.deepEqual(withZevet(rows, [{ ok: false }]), rows);
});

test("the selector renders Zevet's group before the agents' groups", () => {
  const src = readFileSync(new URL("../board/src/components/model-choice.tsx", import.meta.url), "utf8");
  const zevet = src.indexOf("<ModelSelectorItem model={ZEVET_MODEL} />");
  const groups = src.indexOf("groups.map(");
  assert.ok(zevet > 0 && groups > 0 && zevet < groups, "Zevet's row must precede groups.map");
  assert.match(src, /withZevet\(rest, agents\)/);
  assert.match(src, /\{zevetFirst && \(\s*<ModelSelectorGroup key="zevet">/, "and it is not hidden");
});

test("a routed turn keeps the model that answered on its message", () => {
  let s = appendUserText(emptyTranscript(), "hi");
  s = appendAgentPayload(s, { type: "zevet_route", agent: "codex", model: "gpt-6-luna", label: "GPT-6-Luna" }, { agent: "zevet" });
  s = appendAgentPayload(s, { type: "item.completed", item: { type: "agent_message", text: "hello" } }, { agent: "codex" });
  const m = s.messages.at(-1);
  assert.equal(m.metadata.custom.via, "GPT-6-Luna");
  assert.equal(m.content[0].text, "hello");
  assert.equal(s.messages.filter((x) => x.role === "assistant").length, 1, "the label opens the turn, it is not a second message");
});

test("the launcher treats zevet as multi-turn (its process stays open)", () => {
  const src = readFileSync(new URL("../board/src/lib/constants.ts", import.meta.url), "utf8");
  assert.match(src, /MULTI_TURN[^\n]*\["claude", "zevet"\]/);
});
