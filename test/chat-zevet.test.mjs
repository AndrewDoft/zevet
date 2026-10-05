// Chat on the "Zevet" model: chat turns go through the same router as Code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { emptyChatThread, sendUser, chatEvent } from "../board/src/lib/chat-stream.mjs";

const require = createRequire(import.meta.url);
const { createZevetChat, turnsOf } = require("../desktop/chat-zevet.js");

const HAIKU = { id: "claude:haiku", agent: "claude", model: "haiku", label: "Haiku", wideKey: "claude", family: "claude", roles: ["haiku"], trains: false };
const LUNA = { id: "codex:luna", agent: "codex", model: "luna", label: "Luna", wideKey: "codex", family: "codex", roles: ["codex-cheap"], trains: false };
const RUNGS = { rungs: [HAIKU] };
const BOTH = { rungs: [HAIKU, LUNA] };

/** Stand-ins for chat-claude.js / chat-cli.js: same open() contract, scripted replies. */
function fakeInner(log, limited = new Set()) {
  const claude = {
    replyOf: (p) => (p && p.type === "assistant" ? p.message.content.map((b) => b.text).join("") : ""),
    endsTurn: (p) => Boolean(p && p.type === "result"),
    open(o) {
      log.push({ agent: "claude", model: o.model, mcpConfig: o.mcpConfig, effort: o.effort, mode: o.mode });
      return {
        ok: true,
        send(text, extra) {
          log.push({ sent: "claude", text, extra });
          setImmediate(() =>
            o.onEvent(
              limited.has("claude")
                ? { type: "agent", payload: { type: "result", is_error: true, result: "usage limit reached", subtype: "error" } }
                : { type: "agent", payload: { type: "assistant", message: { content: [{ type: "text", text: "from claude" }] } } },
            ),
          );
          if (!limited.has("claude")) setImmediate(() => o.onEvent({ type: "agent", payload: { type: "result", result: "from claude" } }));
          return { ok: true };
        },
        stop: () => ({ ok: true }),
      };
    },
  };
  const codex = {
    replyOf: (p) => (p && p.type === "item.completed" && p.item.type === "agent_message" ? p.item.text : ""),
    endsTurn: () => false,
    open(o) {
      log.push({ agent: "codex", model: o.model, mcpConfig: o.mcpConfig });
      return {
        ok: true,
        send(text, extra) {
          log.push({ sent: "codex", text, extra });
          setImmediate(() => o.onEvent({ type: "agent", payload: { type: "item.completed", item: { type: "agent_message", text: "from codex" } } }));
          setImmediate(() => o.onEvent({ type: "exit", code: 0 }));
          return { ok: true };
        },
        stop: () => ({ ok: true }),
      };
    },
  };
  return { claude, codex };
}

const settle = async (events, pred) => {
  for (let i = 0; i < 200 && !events.some(pred); i++) await new Promise((r) => setImmediate(r));
};

test("turnsOf pairs a saved chat into handoff turns and skips a dangling message", () => {
  const t = turnsOf([
    { role: "user", text: "a" },
    { role: "assistant", text: "b" },
    { role: "user", text: "c" },
  ]);
  assert.deepEqual(t, [{ user: "a", answer: "b" }]);
});

test("a chat turn on Zevet runs the first rung, tags its events, and ends on claude's result", async () => {
  const log = [];
  const z = createZevetChat({ inner: fakeInner(log), ladder: () => RUNGS });
  const events = [];
  const o = z.open({ chat: { id: "c1", messages: [] }, mcpConfig: "mcp.json", mode: "auto", effort: "high", folder: "", env: {}, onEvent: (e) => events.push(e) });
  assert.equal(o.ok, true);
  o.send("hi", { brief: "BRIEF", prior: [{ role: "user", text: "ignored" }] });
  await settle(events, (e) => e.payload && e.payload.type === "result");
  assert.deepEqual(log[0], { agent: "claude", model: "haiku", mcpConfig: "mcp.json", effort: "high", mode: "auto" });
  assert.deepEqual(log[1].extra, { brief: "BRIEF" }, "the Masora brief reaches the backend; chat's prior does not");
  assert.equal(events[0].payload.type, "zevet_route");
  const said = events.find((e) => e.payload && e.payload.type === "assistant");
  assert.equal(said.agent, "claude");
  assert.equal(z.replyOf(said.payload, said), "from claude");
  const result = events.find((e) => e.payload && e.payload.type === "result");
  assert.equal(z.endsTurn(result.payload, result), true);
});

test("a rate-limited rung falls to the next; only claude gets the MCP config; codex's turn ends with turn_end", async () => {
  const log = [];
  const z = createZevetChat({ inner: fakeInner(log, new Set(["claude"])), ladder: () => BOTH });
  const events = [];
  const o = z.open({ chat: { id: "c2", messages: [] }, mcpConfig: "mcp.json", mode: "auto", folder: "", env: {}, onEvent: (e) => events.push(e) });
  o.send("hi");
  await settle(events, (e) => e.type === "turn_end");
  const codexOpen = log.find((l) => l.agent === "codex");
  assert.equal(codexOpen.model, "luna");
  assert.equal(codexOpen.mcpConfig, null);
  const route = events.filter((e) => e.payload && e.payload.type === "zevet_route").map((e) => e.payload.agent);
  assert.deepEqual(route, ["codex"]);
  const said = events.find((e) => e.payload && e.payload.type === "item.completed");
  assert.equal(z.replyOf(said.payload, said), "from codex");
});

test("a respawned chat hands its saved history to the rung that answers", async () => {
  const log = [];
  const z = createZevetChat({ inner: fakeInner(log), ladder: () => RUNGS });
  const events = [];
  const o = z.open({
    chat: { id: "c3", messages: [{ role: "user", text: "my name is Kai" }, { role: "assistant", text: "Hello Kai" }] },
    mode: "auto", folder: "", env: {}, onEvent: (e) => events.push(e),
  });
  o.send("what is my name?");
  await settle(events, (e) => e.payload && e.payload.type === "result");
  const sent = log.find((l) => l.sent).text;
  assert.match(sent, /my name is Kai/);
  assert.match(sent, /what is my name\?/);
});

test("the board: a routed thread reads each event in the CLI that produced it, and turn_end closes it", () => {
  let t = sendUser(emptyChatThread(), "hi", "auto", "zevet");
  t = chatEvent(t, { type: "agent", agent: "zevet", payload: { type: "zevet_route", agent: "codex", model: "luna", label: "Luna" } });
  assert.equal(t.route, "Luna");
  t = chatEvent(t, { type: "agent", agent: "codex", model: "luna", payload: { type: "item.completed", item: { type: "agent_message", text: "hello" } } });
  const text = JSON.stringify(t.transcript.messages.at(-1).content);
  assert.match(text, /hello/, "codex's dialect is read, not claude's");
  assert.equal(t.busy, true);
  t = chatEvent(t, { type: "turn_end", result: "hello" });
  assert.equal(t.busy, false);
});

test("wiring: main.js registers the zevet provider, reads its replies with the evt, and ends on turn_end", () => {
  const m = readFileSync(new URL("../desktop/main.js", import.meta.url), "utf8");
  assert.match(m, /chatProviders\.zevet = createZevetChat\(\{ inner: chatProviders, ladder: zevetLadder, isPrivate: repoPrivacy\.isPrivate \}\)/);
  assert.match(m, /provider\.replyOf\(p, evt\)/);
  assert.match(m, /evt\.type === "turn_end" && run\.turn/);
  const c = readFileSync(new URL("../board/src/lib/chat.ts", import.meta.url), "utf8");
  assert.match(c, /CHAT_AGENTS = \["claude", "codex", "opencode", "zevet"\]/);
  assert.match(c, /prev\.agent !== "zevet"/);
});

test("Chat's composer effort reaches claude, and the slash menu follows the picked agent (both were dead/claude-only)", () => {
  const { chatArgs } = require("../desktop/chat.js");
  const a = chatArgs({ sessionId: "s", started: false, effort: "high" });
  assert.deepEqual(a.slice(a.indexOf("--effort"), a.indexOf("--effort") + 2), ["--effort", "high"]);
  assert.ok(!chatArgs({ sessionId: "s", started: false }).includes("--effort"));
  const menu = readFileSync(new URL("../board/src/components/slashmenu.tsx", import.meta.url), "utf8");
  assert.match(menu, /isChat \? launchAgent \|\| "claude"/);
  const m = readFileSync(new URL("../desktop/main.js", import.meta.url), "utf8");
  assert.match(m, /effort: agentConsole\.extrasFrom\(opts\)\.effort/);
});
