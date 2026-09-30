// The Zevet pick in the model selector, and how a routed turn is labelled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ZEVET_MODEL, defaultPick, withZevet } from "../board/src/lib/zevet-model.mjs";
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
  const zevet = src.indexOf("<ModelSelectorItem model={zevet} />");
  const groups = src.indexOf("groups.map(");
  assert.ok(zevet > 0 && groups > 0 && zevet < groups, "Zevet's row must precede groups.map");
  assert.match(src, /withZevet\(groups\.flatMap/);
  assert.ok(!/inChat \? rest/.test(src), "Chat must not drop the Zevet row");
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

const aliasOf = (id) => id.slice(id.indexOf(":") + 1);
const picker = [ZEVET_MODEL, { id: "opencode:mimo", verified: true }, { id: "claude:sonnet", verified: true }, { id: "codex:gpt-6", verified: true, disabled: true }];

test("the picker starts on the last model used", () => {
  assert.equal(defaultPick(picker, "sonnet", aliasOf), "claude:sonnet");
  assert.equal(defaultPick(picker, "auto", aliasOf), "zevet:auto");
});

test("with nothing used, or the last one unusable, it starts on Zevet — never the first free model", () => {
  assert.equal(defaultPick(picker, "", aliasOf), "zevet:auto");
  assert.equal(defaultPick(picker, "gpt-6", aliasOf), "zevet:auto", "rate limited");
  assert.equal(defaultPick(picker, "retired-model", aliasOf), "zevet:auto", "gone from the catalogue");
});

test("without Zevet (Chat) it falls to the first verified model that can run", () => {
  assert.equal(defaultPick(picker.slice(1), "gpt-6", aliasOf), "opencode:mimo");
  assert.equal(defaultPick([{ id: "codex:x" }], "", aliasOf), "", "nothing verified: the CLI's own default");
});

test("Zevet's logo is the ∴ PNG, in the picker and on agent rows", () => {
  const png = readFileSync(new URL("../board/src/components/icons/zevet-mark.png", import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  const brand = readFileSync(new URL("../board/src/components/brand.tsx", import.meta.url), "utf8");
  assert.match(brand, /import zevetMark from "\.\/icons\/zevet-mark\.png\?inline"/);
  assert.match(brand, /if \(a === "zevet"\) \{\s*return <img src=\{zevetMark\}/);
  const picker = readFileSync(new URL("../board/src/components/model-choice.tsx", import.meta.url), "utf8");
  assert.match(picker, /icon: <AgentLogo agent="zevet"/);
});
