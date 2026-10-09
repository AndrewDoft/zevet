// "claude · claude-sonnet-5.5" says claude twice. One helper builds the label everywhere an agent is listed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const { agentModelLabel, friendlyModel } = await import(pathToFileURL(path.join(ROOT, "board", "src", "lib", "models.mjs")).href);

test("a Claude model drops the redundant agent name and reads as a name", () => {
  assert.equal(agentModelLabel("claude", "claude-sonnet-5.5"), "Sonnet 5.5");
  assert.equal(agentModelLabel("claude", "claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(agentModelLabel("claude", "claude-opus-5"), "Opus 5");
  assert.equal(agentModelLabel("claude", "claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(agentModelLabel("claude", "sonnet"), "Sonnet");
  assert.equal(agentModelLabel("claude", "claude-sonnet-9-1-20991231"), "Sonnet 9.1", "an id the catalogue has not met yet");
});

test("the same rule for Codex / GPT", () => {
  assert.equal(agentModelLabel("codex", "gpt-5.6-sol"), "GPT-5.6-Sol");
  assert.equal(agentModelLabel("codex", "gpt-6-astra"), "GPT-6-Astra");
});

test("a model that does not name the CLI keeps the CLI's name", () => {
  assert.equal(agentModelLabel("opencode", "opencode/some-model"), "opencode · some-model");
  assert.equal(agentModelLabel("claude", "glm-5"), "claude · glm-5", "a claude run on a non-Claude model says so");
});

test("no model is just the agent; the separator is the caller's", () => {
  assert.equal(agentModelLabel("claude", ""), "claude");
  assert.equal(agentModelLabel("claude", undefined), "claude");
  assert.equal(agentModelLabel("opencode", "x/y", " — "), "opencode — y");
});

test("friendlyModel leaves what it does not know alone", () => {
  assert.equal(friendlyModel("mystery-9"), "mystery-9");
  assert.equal(friendlyModel(""), "");
});

test("every list that shows an agent and its model goes through the helper", () => {
  for (const f of ["people.tsx", "findviews.tsx", "palette.tsx"]) {
    const src = readFileSync(path.join(ROOT, "board", "src", "components", f), "utf8");
    assert.match(src, /agentModelLabel\(/, `${f} builds its own agent+model label`);
    assert.doesNotMatch(src, /\$\{c\.agent\} [·—] \$\{c\.model\}/, `${f} still prefixes the agent`);
  }
});
