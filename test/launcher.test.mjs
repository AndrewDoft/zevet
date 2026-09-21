// Choosing a model, and knowing the agent has been asked.
//
// ⚠️ REPORTED BY ANDREW: "this one prompt thing under signed in on each model
// makes no sense." It did not. The launcher used ModelPicker, a flat list, and
// every row carried "signed in" and "one prompt" — both facts about the AGENT.
// "one prompt" therefore appeared under all four codex models and all ten
// opencode ones, saying the same thing eleven times and reading as if it
// described the model.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const BOARD = path.join(ROOT, "board", "src");
const read = (...p) => readFileSync(path.join(BOARD, ...p), "utf8");
const choice = read("components", "model-choice.tsx");
const launcher = read("components", "launcher.tsx");
const conversation = read("components", "conversation.tsx");

describe("the model selector states agent facts once", () => {
  test("the per-agent note is built for a group, not for a row", () => {
    // agentNote takes the AGENT. If it ever takes a model, the facts are back
    // on every row.
    assert.match(choice, /function agentNote\(a: UsableAgent\): string/);
    const body = choice.slice(choice.indexOf("function agentNote"), choice.indexOf("export function ModelChoice"));
    assert.match(body, /one prompt per run/);
    assert.match(body, /keeps talking/);
    assert.match(body, /signed in/);
  });

  test("a model's own fields carry nothing about the agent", () => {
    const rows = choice.slice(choice.indexOf("const groups = useMemo"), choice.indexOf("const all = useMemo"));
    for (const leak of ["signed in", "no account", "one prompt", "keeps talking"]) {
      assert.ok(!rows.includes(leak), `"${leak}" is a fact about the agent and it is on the model row again`);
    }
  });

  test("it is the searchable selector, not the flat picker", () => {
    // Ten free opencode ids with provider-qualified names is a list you search.
    assert.match(choice, /ModelSelectorSearch/);
    assert.ok(!launcher.includes("ModelPicker"), "the launcher went back to the flat picker");
  });

  test("search matches the raw id, not just the label", () => {
    // The label is the model name; someone looking for `inkling` is typing a
    // fragment of `openrouter/thinkingmachines/inkling:free`. There is no ""
    // row left to fall back for (constants.ts MODELS dropped it, so alias is
    // always a real id here) — just the id and the agent name, unconditionally.
    assert.match(choice, /keywords: \[alias, a\.name\]/);
  });

  test("reasoning effort is offered only where a CLI takes the flag", () => {
    assert.match(choice, /const HAS_EFFORT = new Set\(\["codex"\]\)/);
    assert.match(choice, /efforts: HAS_EFFORT\.has\(a\.name\) && alias \? true : undefined/);
  });
});

describe("the wait before the first token is visible", () => {
  // ⚠️ MEASURED, and the first version never rendered once. It asked for "a
  // turn is open and has said nothing", but transcript.mjs opens an assistant
  // message on the agent's FIRST payload, and that payload always carries
  // something — so that state does not exist. The silence worth reporting is
  // the other side of it: the prompt has gone and nothing has come back.
  test("it keys off the turn NOT being open yet", () => {
    const body = conversation.slice(conversation.indexOf("function Thinking()"), conversation.indexOf("export function Conversation"));
    assert.match(body, /openIndex \?\? -1\) < 0/);
    assert.match(body, /last\.role === "user"/);
    assert.match(body, /Boolean\(active\?\.running\)/);
  });

  test("the elapsed clock cannot read negative", () => {
    // `now` was seeded at mount and `since` only when the wait began, so the
    // first frame rendered "-1s".
    const body = conversation.slice(conversation.indexOf("function Thinking()"), conversation.indexOf("export function Conversation"));
    assert.match(body, /Math\.max\(0, Math\.floor/);
    assert.match(body, /setNow\(started\)/);
  });
});

describe("attachments reach the agent", () => {
  const runtime = read("lib", "runtime.tsx");

  test("the composer has an adapter at all", () => {
    assert.match(runtime, /attachments: new CompositeAttachmentAdapter/);
  });

  test("text only, because the CLIs read a prompt on stdin", () => {
    assert.match(runtime, /SimpleTextAttachmentAdapter/);
    assert.ok(
      !runtime.includes("SimpleImageAttachmentAdapter"),
      "an image attachment contributes nothing to a CLI that reads text, and silently",
    );
  });

  test("attached text is folded into the prompt, not dropped", () => {
    // An agent CLI reads one thing. An attachment that stays out of the prompt
    // never reaches the agent, which is worse than refusing it.
    const fn = runtime.slice(runtime.indexOf("function textOf"), runtime.indexOf("export function ConsoleRuntimeProvider"));
    assert.match(fn, /message\.attachments/);
  });
});
