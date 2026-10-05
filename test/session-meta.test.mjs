import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSessionMeta } from "../desktop/session-meta.js";

test("Codex session metadata prefers rollout provenance over launch fallback", () => {
  assert.deepEqual(resolveSessionMeta("codex", {
    rollout: { type: "session_meta", payload: { provenance: { model: "gpt-5.6-codex", reasoning_effort: "high", account: "pro" } } },
    launch: { model: "wrong-model", effort: "low" },
    config: { model: "older-model" },
  }), { model: "gpt-5.6-codex", effort: "high", account: "pro" });
});

test("Codex falls back through launch and config without inventing a model", () => {
  assert.deepEqual(resolveSessionMeta("codex", { launch: { model: "gpt-5.6-codex", effort: "medium" }, config: { model: "old" } }), { model: "gpt-5.6-codex", effort: "medium" });
  assert.deepEqual(resolveSessionMeta("codex", { launch: {}, config: {} }), {});
});

test("opencode reports the provider-qualified model from its event", () => {
  assert.deepEqual(resolveSessionMeta("opencode", { events: [{ type: "step_start", providerID: "openrouter", modelID: "openai/gpt-5" }], launch: { model: "fallback" } }), { model: "openrouter/openai/gpt-5" });
});
