// @-mentions: the picker's data, the directive text, and what goes to the agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mentionCategories, splitMentions, mentionsOf, plainMentions, agentName } from "../board/src/lib/mentions.mjs";

const src = (p) => readFileSync(new URL("../board/src/" + p, import.meta.url), "utf8");

const roster = [{ actor: "andrew", idle: false }, { actor: "Mina", idle: true }, { actor: "Bob", idle: false }];
const agents = [
  { key: "a1", actor: "andrew", agent: "claude-code" },
  { key: "m1", actor: "Mina", agent: "claude-code", mission: "fix retry" },
  { key: "b1", actor: "Bob", agent: "codex" },
  { key: "b0", actor: "Bob", agent: "codex", ended: true },
];

test("picker: Teammates and Agents, never me, never a finished agent", () => {
  const cats = mentionCategories({ roster, agents, myActor: "andrew" });
  assert.deepEqual(cats.map((c) => c.label), ["Teammates", "Agents"]);
  assert.deepEqual(cats[0].items.map((i) => i.label), ["Mina", "Bob"]);
  assert.deepEqual(cats[1].items.map((i) => [i.label, i.id, i.type]), [
    ["Mina · Claude", "m1", "agent"],
    ["Bob · Codex", "b1", "agent"],
  ]);
});

test("picker: an empty category is left out, and directive-breaking characters are cleaned", () => {
  const cats = mentionCategories({ roster: [{ actor: "a]b}" }], agents: [], myActor: null });
  assert.equal(cats.length, 1);
  assert.equal(cats[0].items[0].label, "a b");
});

test("directive text round-trips: the default :type[label]{name=id} form", () => {
  const text = "ask :user[Mina]{name=mina} and :agent[Bob · Codex]{name=b1} about :user[Mina]{name=mina}";
  assert.deepEqual(splitMentions(text).filter((s) => s.kind === "mention").map((s) => [s.type, s.label, s.id]), [
    ["user", "Mina", "mina"],
    ["agent", "Bob · Codex", "b1"],
    ["user", "Mina", "mina"],
  ]);
  assert.deepEqual(mentionsOf(text), [
    { type: "user", id: "mina" },
    { type: "agent", id: "b1" },
  ]);
  // The agent reads plain words.
  assert.equal(plainMentions(text), "ask @Mina and @Bob · Codex about @Mina");
});

test("a directive with no {name=} uses the label as the id; text with none is untouched", () => {
  assert.deepEqual(mentionsOf(":user[kai]"), [{ type: "user", id: "kai" }]);
  assert.deepEqual(mentionsOf("no mentions, 12:30[ok]"), []);
  assert.equal(plainMentions("plain /compact text"), "plain /compact text");
});

test("agentName", () => {
  assert.equal(agentName("claude-code"), "Claude");
  assert.equal(agentName("whatever"), "whatever");
});

test("wiring: sendPrompt flattens for the agent and passes mentions along only when there are some", () => {
  const board = src("lib/board.ts");
  assert.match(board, /const mentions = mentionsOf\(text\)/);
  assert.match(board, /mentions\.length\s*\?/);
  assert.match(board, /send\(c\.id\)/);
});

test("wiring: the @ popover sits in the code composer beside the / menu, and sent messages draw chips", () => {
  const thread = src("components/assistant-ui/elements/thread.aui.tsx");
  assert.ok(thread.includes("<SlashMenu />") && thread.includes("<MentionRoot>") && thread.includes("</MentionRoot>"));
  const menu = src("components/mentionmenu.tsx");
  assert.ok(menu.includes("unstable_useMentionAdapter") && menu.includes("Unstable_TriggerPopoverRoot") && menu.includes('char="@"'));
  assert.ok(menu.includes("ChatSurface"), "Chat has nobody to mention");
  assert.ok(src("components/slashtext.tsx").includes("mention-chip"));
});

test("Settings page: tabs, Collaboration renders the steer policy control, Team and Repos are their own panels", () => {
  const settings = src("components/settings.tsx");
  for (const t of ["account", "repos", "team", "collab", "agents", "integrations", "appearance"]) assert.ok(settings.includes(`["${t}",`), t);
  assert.ok(settings.includes("<SteerPolicyControl />") && settings.includes('from "./steerpolicy"'));
  assert.ok(settings.includes("<TeamPanel />") && settings.includes("<ReposPanel />"));
  assert.ok(src("components/steerpolicy.tsx").includes("export function SteerPolicyControl"));
});

test("every display-name path shows Claude, never Claude Code, for claude-code", async () => {
  const P = await import("../board/src/lib/presence.mjs");
  assert.equal(agentName("claude-code"), "Claude");
  assert.equal(agentName("claude"), "Claude");
  assert.equal(P.agentLabel("Mina", "claude-code"), "Mina · Claude");
});
