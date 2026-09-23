// Zevet Chat: the argv the chat process runs with, what a turn puts on stdin,
// how chats persist, the C1 `zevet_chat` record, its separate outbox, and the
// board's streaming reducer.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import zlib from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const { readMode, writeMode, readLastChat, writeLastChat } = await import(pathToFileURL(path.join(ROOT, "board", "src", "lib", "mode.mjs")).href);
const { mirroredStorage, hydratePrefsMirror } = await import(pathToFileURL(path.join(ROOT, "board", "src", "lib", "prefs-mirror.mjs")).href);

const ID = "6f0c2b8e-1d3a-4c5b-9e7f-0a1b2c3d4e5f";

describe("chatArgs: the claude invocation for a chat", () => {
  test("first turn names the session, later turns resume it", () => {
    const first = chats.chatArgs({ sessionId: ID, started: false });
    const later = chats.chatArgs({ sessionId: ID, started: true });
    assert.deepEqual(first.slice(first.indexOf("--session-id"), first.indexOf("--session-id") + 2), ["--session-id", ID]);
    assert.ok(!first.includes("--resume"));
    assert.deepEqual(later.slice(later.indexOf("--resume"), later.indexOf("--resume") + 2), ["--resume", ID]);
    assert.ok(!later.includes("--session-id"));
  });

  test("no built-in tools, no MCP servers but Masora's, headless stream-json both ways", () => {
    const a = chats.chatArgs({ sessionId: ID, started: false });
    assert.deepEqual(a.slice(a.indexOf("--tools"), a.indexOf("--tools") + 2), ["--tools", ""]);
    assert.ok(a.includes("--strict-mcp-config"));
    for (const f of ["-p", "--verbose", "--include-partial-messages"]) assert.ok(a.includes(f), f);
    assert.equal(a[a.indexOf("--input-format") + 1], "stream-json");
    assert.equal(a[a.indexOf("--output-format") + 1], "stream-json");
    assert.ok(!a.includes("--mcp-config") && !a.includes("--allowedTools"), "unpaired: no MCP at all");
    const paired = chats.chatArgs({ sessionId: ID, started: true, mcpConfig: "/tmp/m.json" });
    assert.equal(paired[paired.indexOf("--mcp-config") + 1], "/tmp/m.json");
    assert.equal(paired[paired.indexOf("--allowedTools") + 1], "mcp__masora");
  });

  test("survives the .cmd shim guard: nothing on argv cmd.exe would re-parse", () => {
    const a = chats.chatArgs({ sessionId: ID, started: true, mcpConfig: "C:/t/m.json", model: "sonnet" });
    assert.deepEqual(_internals.unsafeForCmd(a), []);
  });

  test("includes --permission-mode plan when mode is plan", () => {
    const a = chats.chatArgs({ sessionId: ID, started: false, mode: "plan" });
    assert.deepEqual(a.slice(a.indexOf("--permission-mode"), a.indexOf("--permission-mode") + 2), ["--permission-mode", "plan"]);
  });

  test("includes --permission-mode manual when mode is ask", () => {
    const a = chats.chatArgs({ sessionId: ID, started: false, mode: "ask" });
    assert.deepEqual(a.slice(a.indexOf("--permission-mode"), a.indexOf("--permission-mode") + 2), ["--permission-mode", "manual"]);
  });

  test("includes --permission-mode acceptEdits when mode is auto", () => {
    const a = chats.chatArgs({ sessionId: ID, started: false, mode: "auto" });
    assert.deepEqual(a.slice(a.indexOf("--permission-mode"), a.indexOf("--permission-mode") + 2), ["--permission-mode", "acceptEdits"]);
  });

  test("includes --dangerously-skip-permissions when mode is dangerous", () => {
    const a = chats.chatArgs({ sessionId: ID, started: false, mode: "dangerous" });
    assert.ok(a.includes("--dangerously-skip-permissions"));
    assert.ok(!a.includes("--permission-mode"));
  });

  test("includes --model when model is given", () => {
    const a = chats.chatArgs({ sessionId: ID, started: false, model: "opus-5" });
    assert.deepEqual(a.slice(a.indexOf("--model"), a.indexOf("--model") + 2), ["--model", "opus-5"]);
  });

  test("permission-mode and model together", () => {
    const a = chats.chatArgs({ sessionId: ID, started: false, mode: "plan", model: "sonnet" });
    assert.deepEqual(a.slice(a.indexOf("--permission-mode"), a.indexOf("--permission-mode") + 2), ["--permission-mode", "plan"]);
    assert.deepEqual(a.slice(a.indexOf("--model"), a.indexOf("--model") + 2), ["--model", "sonnet"]);
  });
});

describe("composeTurn: what a turn writes to stdin", () => {
  test("the brief, fenced, before the words; nothing extra without one", () => {
    assert.equal(chats.composeTurn("hi", null), "hi");
    assert.equal(chats.composeTurn("hi", "- a cited fact"), "<masora-context>\n- a cited fact\n</masora-context>\n\nhi");
  });

  test("a slash command reaches claude unwrapped; normal text still wraps", () => {
    const prior = [{ role: "user", author: "andrew", text: "earlier" }];
    // claude only RUNS a command the line it sees starts with it.
    assert.equal(chats.composeTurn("/compact", "- a cited fact", prior), "/compact");
    assert.equal(chats.composeTurn("/clear", null, prior), "/clear");
    assert.equal(chats.composeTurn("/cost", "- a cited fact"), "/cost");
    // Prose that does not START with a slash still wraps.
    assert.equal(chats.composeTurn("see /docs for this", "- brief", prior),
      "<prior-conversation>\n[andrew]: earlier\n</prior-conversation>\n\n<masora-context>\n- brief\n</masora-context>\n\nsee /docs for this");
  });
});

describe("persistence under ~/.zevet/chats", () => {
  test("create, turn, rename, search, remove", () => {
    const c = chats.create("andrew");
    assert.ok(chats.isId(c.id));
    assert.deepEqual(chats.read(c.id).messages, []);
    assert.equal(c.owner, "andrew");
    assert.deepEqual(c.participants, ["andrew"]);
    const after = chats.addTurn(c.id, "What is a kumquat?\nsecond line", "A small citrus fruit.", "claude-x", "andrew");
    assert.equal(after.title, "What is a kumquat?", "untitled chat takes the first line");
    assert.deepEqual(after.messages.map((m) => [m.role, m.author, m.text]), [
      ["user", "andrew", "What is a kumquat?\nsecond line"],
      ["assistant", "assistant", "A small citrus fruit."],
    ]);
    chats.addTurn(c.id, "and you?", "fine", "", "kai");
    assert.deepEqual(chats.read(c.id).participants, ["andrew", "kai"], "whoever speaks joins");
    assert.equal(chats.rename(c.id, "Fruit").title, "Fruit");
    assert.deepEqual(chats.list("citrus").map((x) => x.id), [c.id], "search reaches message text");
    assert.deepEqual(chats.list("nothing-like-this"), []);
    const dir = chats.dirOf(c.id);
    assert.ok(existsSync(dir));
    assert.equal(chats.remove(c.id), true);
    assert.equal(chats.read(c.id), null);
    assert.ok(!existsSync(dir), "the chat's working folder goes with it");
  });

  test("a slash command never titles an untitled chat", () => {
    const c = chats.create("andrew");
    chats.addTurn(c.id, "/compact", "Compacted.", "claude-x", "andrew");
    assert.equal(chats.read(c.id).title, "", "a command is plumbing, not a topic");
    chats.addTurn(c.id, "What is a kumquat?", "A small citrus fruit.", "claude-x", "andrew");
    assert.equal(chats.read(c.id).title, "What is a kumquat?", "the first real message still names it");
    chats.remove(c.id);
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

  test("the init line's slash_commands land on the thread for the menu", () => {
    let t = stream.emptyChatThread();
    assert.equal(t.slashCommands, null, "before any run: fallback list");
    t = stream.chatEvent(t, {
      type: "agent",
      payload: { type: "system", subtype: "init", model: "claude-x", slash_commands: ["compact", "clear", 7] },
    });
    assert.deepEqual(t.slashCommands, ["compact", "clear"], "non-strings dropped, like Code");
  });

  test("conversation_reset empties the thread and any draft with it", () => {
    let t = stream.sendUser(stream.emptyChatThread(), "/clear");
    t = stream.chatEvent(t, delta("leftover"));
    assert.ok(t.draft);
    t = stream.chatEvent(t, { type: "agent", payload: { type: "conversation_reset" } });
    assert.equal(t.transcript.messages.length, 0, "screen matches claude");
    assert.equal(t.draft, "", "old tokens go too");
  });

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

  test("usage is recorded from assistant message payload and available on thread", () => {
    let t = stream.sendUser(stream.emptyChatThread(), "hi");
    t = stream.chatEvent(t, {
      type: "agent",
      payload: {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello" }],
          usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 },
          model: "claude-opus-5",
        },
      },
    });
    t = stream.chatEvent(t, { type: "agent", payload: { type: "result", is_error: false } });
    assert.ok(t.usage, "usage should be present on thread");
    assert.equal(t.usage.context, 150, "context = input + cache_read");
    assert.equal(t.usage.cacheHit, 33.33333333333333, "cacheHit = cache_read / context * 100");
    assert.equal(t.usage.model, "claude-opus-5", "model from message");
    assert.equal(t.usage.input, 100);
    assert.equal(t.usage.cachedInput, 50);
    assert.equal(t.usage.output, 20);
  });

  test("usage from result payload is ignored (running totals, not context)", () => {
    let t = stream.sendUser(stream.emptyChatThread(), "hi");
    t = stream.chatEvent(t, block("Hello"));
    t = stream.chatEvent(t, {
      type: "agent",
      payload: {
        type: "result",
        usage: { input_tokens: 500, output_tokens: 100 }, // running total, not this turn
        is_error: false,
      },
    });
    // The result payload is ignored, and the assistant message had no usage, so usage stays null
    assert.equal(t.usage, null, "result payload does not create usage");
    // This test shows result payloads don't create usage
  });

  test("usage parsing handles codex-style cached_input_tokens", () => {
    let t = stream.sendUser(stream.emptyChatThread(), "hi");
    t = stream.chatEvent(t, {
      type: "agent",
      payload: {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello" }],
          usage: { input_tokens: 17039, cached_input_tokens: 9984, output_tokens: 500 },
          model: "gpt-5",
        },
      },
    });
    t = stream.chatEvent(t, { type: "agent", payload: { type: "result", is_error: false } });
    assert.ok(t.usage);
    assert.equal(t.usage.context, 17039 + 0, "codex: context = input_tokens (cached is subset)");
    assert.equal(t.usage.cacheHit, (9984 / 17039) * 100); // ~58.595%
    assert.equal(t.usage.input, 17039 - 9984);
    assert.equal(t.usage.cachedInput, 9984);
    assert.equal(t.usage.output, 500);
  });
});

describe("a chat's claude session never shows up in Code", () => {
  test("agent-sessions.list skips sessions whose folder is a chat's", () => {
    const sessions = require(path.join(ROOT, "desktop", "agent-sessions.js"));
    const fake = tempDir("zevet-chat-claude-");
    const was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = process.env.USERPROFILE = fake.dir;
    try {
      const slug = (p) => path.resolve(p).replace(/[^A-Za-z0-9]/g, "-");
      const line = JSON.stringify({ type: "user", timestamp: "2026-09-22T00:00:00.000Z", message: { role: "user", content: "hi" } });
      for (const dir of [path.join(chats.CHATS, ID), path.join(fake.dir, "some-repo")]) {
        const d = path.join(fake.dir, ".claude", "projects", slug(dir));
        mkdirSync(d, { recursive: true });
        writeFileSync(path.join(d, "11111111-2222-3333-4444-555555555555.jsonl"), line + "\n");
      }
      const got = sessions.list({}).sessions.map((s) => s.slug);
      assert.deepEqual(got, [slug(path.join(fake.dir, "some-repo"))]);
    } finally {
      process.env.HOME = was.HOME;
      process.env.USERPROFILE = was.USERPROFILE;
    }
  });
});

describe("one reply, one message id", () => {
  test("the id a reply streams under is the id it ends with", () => {
    let t = stream.sendUser(stream.emptyChatThread(), "hi");
    const during = (tt) => stream.visibleMessages(tt).at(-1).id;
    t = stream.chatEvent(t, { type: "agent", payload: { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "He" } } } });
    const first = during(t);
    t = stream.chatEvent(t, { type: "agent", payload: { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } } });
    t = stream.chatEvent(t, { type: "agent", payload: { type: "result", is_error: false } });
    assert.equal(during(t), first);
    assert.equal(stream.visibleMessages(t).length, 2);
  });
});

describe("a relaunch comes back to the mode and chat it closed on", () => {
  const fakeLocal = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null };
  };
  // What desktop/main.js keeps in ~/.zevet/prefs.json (local:prefs / local:setPref).
  const disk = {};
  const desktop = {
    prefs: async () => ({ ...disk }),
    setPref: async (k, v) => { if (v == null) delete disk[k]; else disk[k] = String(v); },
    setPrefs: async (e) => Object.assign(disk, e),
  };

  test("Chat, and its thread, survive a restart with localStorage wiped", async () => {
    const before = mirroredStorage(fakeLocal(), () => desktop);
    writeMode(before, "chat");
    writeLastChat(before, ID);
    await new Promise((r) => setImmediate(r));

    const wiped = fakeLocal(); // a new origin, a cleared profile, a crash
    await hydratePrefsMirror(wiped, desktop);
    const after = mirroredStorage(wiped, () => desktop);
    assert.equal(readMode(after, true), "chat");
    assert.equal(readLastChat(after), ID);
    assert.equal(readMode(after, false), "code", "a desktop without Chat opens Code");

    writeMode(after, "code");
    await new Promise((r) => setImmediate(r));
    const again = fakeLocal();
    await hydratePrefsMirror(again, desktop);
    assert.equal(readMode(mirroredStorage(again, () => desktop), true), "code");
  });
});

describe("the transcript travels; the claude session stays on this machine", () => {
  test("session binding lives beside the chat, never inside it", () => {
    const c = chats.create("andrew");
    const s = chats.session(c.id);
    assert.ok(chats.isId(s.sessionId));
    assert.notEqual(s.sessionId, c.id, "a handed-over chat gets its own session");
    assert.equal(s.started, false);
    chats.markStarted(c.id);
    assert.deepEqual(chats.session(c.id), { sessionId: s.sessionId, started: true });
    const record = JSON.parse(readFileSync(path.join(chats.CHATS, `${c.id}.json`), "utf8"));
    assert.deepEqual(Object.keys(record).sort(), ["created", "id", "messages", "owner", "participants", "title", "updated"]);
    chats.remove(c.id);
  });

  test("a machine with no session for a chat replays its history on the first turn", () => {
    const prior = [
      { role: "user", author: "andrew", text: "What is a kumquat?" },
      { role: "assistant", author: "assistant", text: "A small citrus fruit." },
    ];
    assert.equal(
      chats.composeTurn("how do I eat one?", null, prior),
      "<prior-conversation>\n[andrew]: What is a kumquat?\n\n[assistant]: A small citrus fruit.\n</prior-conversation>\n\nhow do I eat one?",
    );
  });

  test("the Masora record names its participants, from which its audience is derived", () => {
    const r = chats.toRecord({ id: ID, owner: "andrew", participants: ["andrew", "kai"], messages: [] });
    assert.equal(r.owner, "andrew");
    assert.deepEqual(r.participants, ["andrew", "kai"]);
  });
});

describe("sessions on macOS and Linux", () => {
  test("a project folder slug that starts with '-' (every POSIX path) is listed", () => {
    const sessions = require(path.join(ROOT, "desktop", "agent-sessions.js"));
    const fake = tempDir("zevet-posix-slug-");
    const was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = process.env.USERPROFILE = fake.dir;
    try {
      const d = path.join(fake.dir, ".claude", "projects", "-Users-kai-repo");
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, "11111111-2222-3333-4444-555555555555.jsonl"),
        JSON.stringify({ type: "user", timestamp: "2026-09-22T00:00:00.000Z", message: { role: "user", content: "hi" } }) + "\n");
      assert.deepEqual(sessions.list({}).sessions.map((s) => s.slug), ["-Users-kai-repo"]);
    } finally {
      process.env.HOME = was.HOME;
      process.env.USERPROFILE = was.USERPROFILE;
    }
  });
});

describe("the provider seam", () => {
  const { createClaudeCli } = require(path.join(ROOT, "desktop", "chat-claude.js"));

  test("claude-cli: fresh session replays history once, then resumes; model and provider land on the reply", () => {
    const c = chats.create("andrew");
    chats.addTurn(c.id, "earlier", "answer", "model-a", "andrew", "claude-cli");
    const spawned = [];
    const writes = [];
    const provider = createClaudeCli({
      startConsole: (opts) => {
        spawned.push(opts.args);
        return { ok: true, send: (t) => (writes.push(t), { ok: true }), stop: () => ({ ok: true }) };
      },
    });
    assert.equal(provider.id, "claude-cli");
    assert.equal(provider.trainsOnPrompts, false, "the brief step stays on for it");
    const run = provider.open({ chat: chats.read(c.id), mcpConfig: null, onEvent: () => {} });
    run.send("next", { brief: null, prior: chats.read(c.id).messages });
    run.send("again", { brief: null, prior: chats.read(c.id).messages });
    assert.ok(spawned[0].includes("--session-id"));
    assert.match(writes[0], /^<prior-conversation>/);
    assert.equal(writes[1], "again", "history goes once per session, not every turn");
    const reply = chats.read(c.id).messages[1];
    assert.equal(reply.provider, "claude-cli");
    assert.equal(reply.model, "model-a");
    chats.remove(c.id);
  });
});
