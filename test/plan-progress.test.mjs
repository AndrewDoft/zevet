import test from "node:test";
import assert from "node:assert/strict";
import { latestPlan, planFromToolCall } from "../board/src/lib/plan-progress.mjs";
import { readFileSync } from "node:fs";

test("parses Claude TodoWrite, Codex update_plan, and OpenCode todo fixtures", () => {
  assert.deepEqual(planFromToolCall("TodoWrite", { todos: [{ content: "read", status: "completed" }, { content: "edit", status: "in_progress" }] }), [
    { text: "read", status: "completed" }, { text: "edit", status: "in_progress" },
  ]);
  assert.deepEqual(planFromToolCall("update_plan", { plan: [{ step: "test", status: "pending" }] }), [{ text: "test", status: "pending" }]);
  assert.deepEqual(planFromToolCall("todo", { items: [{ title: "ship", status: "done" }] }), [{ text: "ship", status: "completed" }]);
});

test("the latest todo list replaces the earlier list and exposes progress", () => {
  const result = latestPlan([{ content: [
    { type: "tool-call", toolName: "TodoWrite", args: { todos: [{ content: "old", status: "completed" }] } },
  ] }, { content: [
    { type: "tool-call", toolName: "TodoWrite", args: { todos: [{ content: "new one", status: "completed" }, { content: "new two", status: "in_progress" }, { content: "new three", status: "pending" }] } },
  ] }]);
  assert.equal(result.done, 1);
  assert.equal(result.total, 3);
  assert.equal(result.current, "new two");
  assert.deepEqual(result.steps.map((step) => step.text), ["new one", "new two", "new three"]);
});

test("agent cards render compact progress and expandable steps for local and teammate agents", () => {
  const people = readFileSync(new URL("../board/src/components/people.tsx", import.meta.url), "utf8");
  const plan = readFileSync(new URL("../board/src/components/assistant-ui/elements/agent-plan.tsx", import.meta.url), "utf8");
  assert.match(people, /<AgentPlan steps=\{c\.plan\.steps\.map/);
  assert.match(people, /<AgentPlan steps=\{plan\.map/);
  assert.match(plan, /\{completed\}\/\{total\}/);
  assert.match(plan, /<details open=\{false\}>/);
  assert.match(plan, /\{current \|\| "Plan"\}/);
  assert.match(plan, /<ul/);
});
