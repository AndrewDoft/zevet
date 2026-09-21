import test from "node:test";
import assert from "node:assert/strict";
import { commandsFor, matchSlash, parseLocal } from "../board/src/lib/slash.mjs";
import { appendUserText, appendAgentPayload, emptyTranscript } from "../board/src/lib/transcript.mjs";

test("claude's menu is what claude announced, plus zevet's own", () => {
  const cmds = commandsFor("claude", ["zzz-skill", "compact", "clear"]);
  const names = cmds.map((c) => c.name);
  assert.deepEqual(names, ["stop", "new", "clear", "compact", "zzz-skill"]);
  assert.equal(cmds.find((c) => c.name === "clear").local, false, "claude runs /clear itself");
});

test("codex gets only what zevet implements", () => {
  assert.deepEqual(commandsFor("codex", []).map((c) => c.name), ["stop", "new", "clear"]);
});

test("a menu opens only while the composer is one slash token", () => {
  const cmds = commandsFor("claude", ["compact", "context", "cost"]);
  assert.deepEqual(matchSlash("/co", cmds).map((c) => c.name), ["compact", "context", "cost"]);
  assert.deepEqual(matchSlash("/", cmds).length, cmds.length);
  assert.deepEqual(matchSlash("/compact focus", cmds), []);
  assert.deepEqual(matchSlash("hello /co", cmds), []);
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
