import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { commandsFor, matchSlash, parseLocal, slashLead } from "../board/src/lib/slash.mjs";
import { appendUserText, appendAgentPayload, emptyTranscript } from "../board/src/lib/transcript.mjs";

describe("a command that registered", () => {
  // ⚠️ THE POINT IS CONFIRMATION. The board draws this in the sender's colour
  // so you can see the command took — Andrew: "highlight slash commands in the
  // user color and bold them, that way we can be sure they are registered" —
  // which only means something if an unknown name stays plain.
  const cmds = commandsFor("claude", ["compact", "loop"]);

  test("a known command leads, with its argument left alone", () => {
    assert.deepEqual(slashLead("/loop", cmds), { name: "loop", rest: "" });
    assert.deepEqual(slashLead("/loop 5m /foo", cmds), { name: "loop", rest: " 5m /foo" });
    // zevet's own commands count too; they are in the same list.
    assert.equal(slashLead("/stop", cmds).name, "stop");
  });

  test("anything the agent does not offer stays plain text", () => {
    assert.equal(slashLead("/nope", cmds), null);
    assert.equal(slashLead("/deploy now", cmds), null);
    // Not a first token, so not a command.
    assert.equal(slashLead("see /docs here", cmds), null);
    assert.equal(slashLead("", cmds), null);
    assert.equal(slashLead("/loop", []), null);
  });

  test("the case you type is kept, the case you match is not", () => {
    assert.deepEqual(slashLead("/LOOP", cmds), { name: "LOOP", rest: "" });
  });
});

test("claude's menu is what claude announced, plus zevet's own", () => {
  const cmds = commandsFor("claude", ["zzz-skill", "compact", "clear"]);
  const names = cmds.map((c) => c.name);
  assert.deepEqual(names, ["stop", "new", "model", "clear", "compact", "zzz-skill"]);
  assert.equal(cmds.find((c) => c.name === "clear").local, false, "claude runs /clear itself");
});

test("codex gets only what zevet implements", () => {
  assert.deepEqual(commandsFor("codex", []).map((c) => c.name), ["stop", "new", "model", "clear"]);
});

test("a menu opens only while the composer is one slash token", () => {
  const cmds = commandsFor("claude", ["compact", "context", "cost"]);
  assert.deepEqual(matchSlash("/co", cmds).map((c) => c.name), ["compact", "context", "cost"]);
  assert.deepEqual(matchSlash("/", cmds).length, cmds.length);
  assert.deepEqual(matchSlash("/compact focus", cmds), []);
  assert.deepEqual(matchSlash("hello /co", cmds), []);
});

test("/model is a local command for every agent", () => {
  const claudeCmds = commandsFor("claude", []);
  const codexCmds = commandsFor("codex", []);
  const opencodeCmds = commandsFor("opencode", []);
  assert.ok(claudeCmds.some((c) => c.name === "model" && c.local), "claude gets /model");
  assert.ok(codexCmds.some((c) => c.name === "model" && c.local), "codex gets /model");
  assert.ok(opencodeCmds.some((c) => c.name === "model" && c.local), "opencode gets /model");
  assert.deepEqual(matchSlash("/mo", claudeCmds).map((c) => c.name), ["model"]);
  assert.deepEqual(matchSlash("/mo", codexCmds).map((c) => c.name), ["model"]);
});

test("/clear is local for codex and passthrough for claude", () => {
  assert.equal(parseLocal("/clear", "codex"), "clear");
  assert.equal(parseLocal("/clear", "claude"), null);
  assert.equal(parseLocal("/stop", "claude"), "stop");
  assert.equal(parseLocal("/compact", "codex"), null);
});

test("conversation_reset empties the transcript", () => {
  let s = appendUserText(emptyTranscript(), "/clear");
  s = appendAgentPayload(s, { type: "conversation_reset" }, { agent: "claude" });
  assert.equal(s.messages.length, 0);
});
