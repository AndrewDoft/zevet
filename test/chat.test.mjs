// Zevet Chat: the argv the chat process runs with, what a turn puts on stdin,
// how chats persist, the C1 `zevet_chat` record, its separate outbox, and the
// board's streaming reducer.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import zlib from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { tempDir, ROOT } from "./helpers.mjs";

const home = tempDir("zevet-chat-");
process.env.ZEVET_HOME = home.dir;

const require = createRequire(import.meta.url);
const chats = require(path.join(ROOT, "desktop", "chat.js"));
const push = require(path.join(ROOT, "desktop", "masora-push.js"));
const masora = require(path.join(ROOT, "desktop", "masora.js"));
const { _internals } = require(path.join(ROOT, "desktop", "agent-console.js"));
const stream = await import(pathToFileURL(path.join(ROOT, "board", "src", "lib", "chat-stream.mjs")).href);

const ID = "6f0c2b8e-1d3a-4c5b-9e7f-0a1b2c3d4e5f";

describe("chatArgs: the claude invocation for a chat", () => {
  test("first turn names the session, later turns resume it", () => {
    const first = chats.chatArgs({ id: ID, started: false });
    const later = chats.chatArgs({ id: ID, started: true });
    assert.deepEqual(first.slice(first.indexOf("--session-id"), first.indexOf("--session-id") + 2), ["--session-id", ID]);
    assert.ok(!first.includes("--resume"));
    assert.deepEqual(later.slice(later.indexOf("--resume"), later.indexOf("--resume") + 2), ["--resume", ID]);
    assert.ok(!later.includes("--session-id"));
  });

  test("no built-in tools, no MCP servers but Masora's, headless stream-json both ways", () => {
    const a = chats.chatArgs({ id: ID, started: false });
    assert.deepEqual(a.slice(a.indexOf("--tools"), a.indexOf("--tools") + 2), ["--tools", ""]);
    assert.ok(a.includes("--strict-mcp-config"));
    for (const f of ["-p", "--verbose", "--include-partial-messages"]) assert.ok(a.includes(f), f);
    assert.equal(a[a.indexOf("--input-format") + 1], "stream-json");
    assert.equal(a[a.indexOf("--output-format") + 1], "stream-json");
    assert.ok(!a.includes("--mcp-config") && !a.includes("--allowedTools"), "unpaired: no MCP at all");
    const paired = chats.chatArgs({ id: ID, started: true, mcpConfig: "/tmp/m.json" });
    assert.equal(paired[paired.indexOf("--mcp-config") + 1], "/tmp/m.json");
    assert.equal(paired[paired.indexOf("--allowedTools") + 1], "mcp__masora");
  });

  test("survives the .cmd shim guard: nothing on argv cmd.exe would re-parse", () => {
    const a = chats.chatArgs({ id: ID, started: true, mcpConfig: "C:/t/m.json", model: "sonnet" });
    assert.deepEqual(_internals.unsafeForCmd(a), []);
  });
});

describe("composeTurn: what a turn writes to stdin", () => {
  test("the brief, fenced, before the words; nothing extra without one", () => {
    assert.equal(chats.composeTurn("hi", null), "hi");
    assert.equal(chats.composeTurn("hi", "- a cited fact"), "<masora-context>\n- a cited fact\n</masora-context>\n\nhi");
  });
});

describe("persistence under ~/.zevet/chats", () => {
  test("create, turn, rename, search, remove", () => {
    const c = chats.create();
    assert.ok(chats.isId(c.id));
    assert.deepEqual(chats.read(c.id).messages, []);
    chats.markStarted(c.id);
    const after = chats.addTurn(c.id, "What is a kumquat?\nsecond line", "A small citrus fruit.", "claude-x");
    assert.equal(after.title, "What is a kumquat?", "untitled chat takes the first line");
    assert.equal(after.started, true);
    assert.deepEqual(after.messages.map((m) => [m.role, m.text]), [
      ["user", "What is a kumquat?\nsecond line"],
      ["assistant", "A small citrus fruit."],
    ]);
    assert.equal(chats.rename(c.id, "Fruit").title, "Fruit");
    assert.deepEqual(chats.list("citrus").map((x) => x.id), [c.id], "search reaches message text");
    assert.deepEqual(chats.list("nothing-like-this"), []);
    const dir = chats.dirOf(c.id);
    assert.ok(existsSync(dir));
    assert.equal(chats.remove(c.id), true);
    assert.equal(chats.read(c.id), null);
    assert.ok(!existsSync(dir), "the chat's working folder goes with it");
  });

  test("an id that is not a uuid never becomes a path", () => {
    assert.equal(chats.read("../../etc/passwd"), null);
    assert.throws(() => chats.dirOf("../x"));
    assert.equal(chats.remove("../x"), false);
  });
});

describe("toRecord: the C1 zevet_chat record", () => {
  test("no repository, chat id as external_id, transcript as content_text", () => {
    const r = chats.toRecord({
      id: ID, title: "Fruit", created: 0, updated: 1000, model: "m",
      messages: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }],
    });
    assert.equal(r.surface, "zevet_chat");
    assert.equal(r.external_id, `zevet:chat:${ID}`);
    assert.ok(!("repository" in r));
    assert.equal(r.content_text, "[HUMAN]: hi\n[ASSISTANT]: hello");
    assert.equal(r.updated_at, new Date(1000).toISOString());
  });

  test("content_text is capped at 200 KB like a session's", () => {
    const r = chats.toRecord({ id: ID, messages: [{ role: "user", text: "x".repeat(300_000) }] });
    assert.ok(Buffer.byteLength(r.content_text, "utf8") <= 200_000);
  });
});

describe("the chat outbox is not the session outbox", () => {
  test("a chat record queues and flushes on its own file", async () => {
    push.appendOutbox([chats.toRecord({ id: ID, messages: [] })], push.CHAT_OUTBOX_PATH);
    assert.equal(push.readOutbox().length, 0, "session outbox untouched");
    assert.equal(push.readOutbox(push.CHAT_OUTBOX_PATH).length, 1);
    const bodies = [];
    const { sent } = await push.flushOutbox({
      baseUrl: "https://m.test", token: "t", file: push.CHAT_OUTBOX_PATH,
      fetchImpl: async (url, init) => {
        bodies.push({ url, lines: zlib.gunzipSync(init.body).toString().split("\n").map((l) => JSON.parse(l)) });
        return { status: 202 };
      },
    });
    assert.equal(sent, 1);
    assert.equal(bodies[0].url, "https://m.test/api/connector/ingest");
    assert.equal(bodies[0].lines[0].surface, "zevet_chat");
    assert.equal(push.readOutbox(push.CHAT_OUTBOX_PATH).length, 0);
  });

  test("a server that 400s chat lines leaves sessions free to go", async () => {
    push.appendOutbox([chats.toRecord({ id: ID, messages: [] })], push.CHAT_OUTBOX_PATH);
    const r = await push.flushOutbox({ baseUrl: "https://m.test", token: "t", file: push.CHAT_OUTBOX_PATH, fetchImpl: async () => ({ status: 400 }) });
    assert.equal(r.sent, 0);
    assert.equal(push.readOutbox(push.CHAT_OUTBOX_PATH).length, 1, "kept for a newer server");
    assert.equal(push.readOutbox().length, 0);
    push.removeFromOutbox(1, push.CHAT_OUTBOX_PATH);
  });
});

describe("masora.json: Chat push consent", () => {
  test("off unless turned on", () => {
    assert.equal(masora.readConfig().chat, false);
    assert.equal(masora.setChatPush(true).chat, true);
    assert.equal(JSON.parse(readFileSync(masora.CONFIG_PATH, "utf8")).chat, true);
    assert.equal(masora.setChatPush(false).chat, false);
  });
});

describe("chat-stream: token streaming over transcript.mjs", () => {
  const delta = (text) => ({ type: "agent", payload: { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } } });
  const block = (text) => ({ type: "agent", payload: { type: "assistant", message: { content: [{ type: "text", text }] } } });

  test("deltas show as they arrive, the finished block replaces them once", () => {
    let t = stream.sendUser(stream.emptyChatThread(), "hi");
    assert.equal(t.busy, true);
    t = stream.chatEvent(t, delta("Hel"));
    t = stream.chatEvent(t, delta("lo"));
    let shown = stream.visibleMessages(t);
    assert.equal(shown.length, 2);
    assert.equal(shown[1].content[0].text, "Hello");
    t = stream.chatEvent(t, block("Hello"));
    assert.equal(t.draft, "");
    shown = stream.visibleMessages(t);
    assert.equal(shown[1].content.filter((p) => p.type === "text").map((p) => p.text).join(""), "Hello", "not doubled");
    t = stream.chatEvent(t, { type: "agent", payload: { type: "result", is_error: false } });
    assert.equal(t.busy, false);
    assert.equal(stream.visibleMessages(t)[1].status.type, "complete");
  });

  test("a stored chat opens closed, in order", () => {
    const t = stream.fromStored([{ role: "user", text: "a" }, { role: "assistant", text: "b" }]);
    const m = stream.visibleMessages(t);
    assert.deepEqual(m.map((x) => x.role), ["user", "assistant"]);
    assert.equal(t.busy, false);
  });

  test("an exit mid-turn ends it; a refused send says why", () => {
    let t = stream.sendUser(stream.emptyChatThread(), "hi");
    t = stream.chatEvent(t, { type: "exit", code: 1 });
    assert.equal(t.busy, false);
    assert.equal(stream.visibleMessages(t)[1].status.type, "incomplete");
    const f = stream.failTurn(stream.sendUser(stream.emptyChatThread(), "x"), "Still answering.");
    assert.equal(stream.visibleMessages(f)[1].status.error, "Still answering.");
  });
});
