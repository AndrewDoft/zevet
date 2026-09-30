// "switched from X to Y": a quiet rule over the prompt that changed model
// (Andrew, 2026-09-30). Data only, computed as the prompt is appended.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appendUserText, emptyTranscript } from "../board/src/lib/transcript.mjs";

const sw = (m) => m.metadata?.custom?.switched;

test("a prompt on a different model than the last one carries the switch", () => {
  let t = appendUserText(emptyTranscript(), "one", "Zevet");
  assert.equal(sw(t.messages[0]), undefined, "the first prompt switched from nothing");
  t = appendUserText(t, "two", "Zevet");
  assert.equal(sw(t.messages[1]), undefined, "same model, no rule");
  t = appendUserText(t, "three", "Sonnet 5");
  assert.deepEqual(sw(t.messages[2]), { from: "Zevet", to: "Sonnet 5" });
  t = appendUserText(t, "four");
  assert.equal(sw(t.messages[3]), undefined, "no model given: no claim");
  t = appendUserText(t, "five", "Zevet");
  assert.deepEqual(sw(t.messages[4]), { from: "Sonnet 5", to: "Zevet" });
});

test("the thread draws it above the prompt, and Code applies a picked model on the next prompt", () => {
  const thread = readFileSync(new URL("../board/src/components/assistant-ui/elements/thread.aui.tsx", import.meta.url), "utf8");
  assert.match(thread, /data-role="user"\s*>\s*<ModelSwitch \/>/);
  assert.match(thread, /switched from \{sw\.from\} to \{sw\.to\}/);
  const board = readFileSync(new URL("../board/src/lib/board.ts", import.meta.url), "utf8");
  assert.match(board, /c\.transcript = appendUserText\(c\.transcript, text, consoleModelName\(c\)\);/);
  assert.match(board, /c\.model = c\.nextModel!;/);
});

test("Chat marks the switch too, and Code's picker applies a same-CLI pick to the thread in front", async () => {
  const { emptyChatThread, sendUser } = await import("../board/src/lib/chat-stream.mjs");
  let t = sendUser(emptyChatThread(), "hi", "auto", "zevet");
  t = { ...t, busy: false };
  t = sendUser(t, "again", "sonnet", "claude");
  const users = t.transcript.messages.filter((m) => m.role === "user");
  assert.equal(users[1].metadata.custom.switched.from, "Zevet");
  assert.ok(users[1].metadata.custom.switched.to);
  const picker = readFileSync(new URL("../board/src/components/model-choice.tsx", import.meta.url), "utf8");
  assert.match(picker, /id\.startsWith\(`\$\{active\.agent\}:`\)\) setConsoleModel\(active\.key, aliasOf\(id\)\)/);
});
