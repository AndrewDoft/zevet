// `via: "board"` on the loopback agent API: /spawn and /send go through the
// board's own actions (board.ts startAgent / sendPrompt) instead of straight
// into main.js, so what breaks for a person's Send breaks for terminal agents
// too. Real HTTP + the real board-ask.js + the real board-requests.mjs; only the
// board window's store is a fake (board.ts itself needs React and a DOM).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const agentApi = require(path.join(ROOT, "desktop", "agent-api.js"));
const { createBoardAsk } = require(path.join(ROOT, "desktop", "board-ask.js"));
const { answerBoardRequest, pickerModel } = await import(pathToFileURL(path.join(ROOT, "board", "src", "lib", "board-requests.mjs")).href);

const { CLAUDE_MODELS } = await import(pathToFileURL(path.join(ROOT, "board", "src", "lib", "agent-models.generated.mjs")).href);
const AGENTS = [{ name: "claude", models: [{ id: "claude-opus-5-5" }, { id: "claude-sonnet-5" }] }];

/** The main-process half (board-ask + a direct backend) wired to a fake board window. */
async function rig({ window = true, answers = true, timeoutMs = 2000, consoles = [], reply } = {}) {
  const log = { direct: [], directSends: [], asked: [], launches: [], prompts: [] };
  const state = { activeConsole: 7, consoles: [...consoles] };
  const board = {
    startAgent: async (name, launch) => {
      log.launches.push({ name, launch });
      // What board.ts does: a background start never touches activeConsole.
      if (!launch.background) state.activeConsole = 99;
      state.consoles.push({ key: 50, id: "board-1", running: true });
      return { ok: true, id: "board-1", engine: launch.engine };
    },
    sendPrompt: (key, text) => log.prompts.push({ key, text }),
    findConsole: (id) => state.consoles.find((c) => c.id === id),
    agents: () => AGENTS,
  };
  const ask = createBoardAsk({
    timeoutMs,
    send: (reqId, kind, payload) => {
      if (!window) return false;
      log.asked.push({ kind, ...payload });
      if (reply) queueMicrotask(() => ask.reply(reqId, reply));
      else if (answers) void answerBoardRequest({ reqId, kind, ...payload }, board).then((r) => ask.reply(reqId, r));
      return true;
    },
  });
  const entries = new Map(consoles.map((c) => [c.id, { id: c.id, running: c.running !== false, events: [] }]));
  const api = await agentApi.start({
    askBoard: (kind, payload) => ask.ask(kind, payload),
    startAgentCore: async ({ agent, cwd, opts }) => {
      log.direct.push({ agent, cwd, opts });
      entries.set("d1", { id: "d1", running: true, events: [] });
      return { ok: true, id: "d1", agent, cwd };
    },
    sendToAgentCore: (id, text) => {
      log.directSends.push({ id, text });
      return { ok: true };
    },
    stopAgentCore: () => ({ ok: true }),
    getConsole: (id) => entries.get(id),
    listConsoles: () => [...entries.values()],
  });
  const post = async (route, body) => {
    const res = await fetch(`${api.url}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { api, post, log, state };
}

describe("POST /spawn via board", () => {
  test("API -> IPC -> board action -> id round trip, with the composer's option shape", async (t) => {
    const { api, post, log } = await rig();
    t.after(api.close);
    const r = await post("/spawn", { via: "board", agent: "claude", cwd: "/repo", prompt: "do it", model: "sonnet", mode: "dangerous", engine: "engine2", label: "w1" });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.ok, r.body.id, r.body.via, r.body.engine], [true, "board-1", "board", "engine2"]);
    assert.equal(log.direct.length, 0, "the direct path must not also start one");
    assert.deepEqual(log.launches[0], {
      name: "claude",
      launch: { background: true, root: "/repo", prompt: "do it", model: "claude-sonnet-5", mode: "dangerous", engine: "engine2", label: "w1" },
    });
  });

  test("does not steal focus or switch the thread the person is looking at", async (t) => {
    const { api, post, state } = await rig();
    t.after(api.close);
    await post("/spawn", { via: "board", cwd: "/repo", prompt: "x" });
    assert.equal(state.activeConsole, 7);
  });

  test("no board window -> direct, and says so", async (t) => {
    const { api, post, log } = await rig({ window: false });
    t.after(api.close);
    const r = await post("/spawn", { via: "board", cwd: "/repo", prompt: "x" });
    assert.equal(r.body.via, "direct");
    assert.equal(r.body.id, "d1");
    assert.equal(log.direct.length, 1);
    assert.deepEqual(log.directSends, [{ id: "d1", text: "x" }]);
  });

  test("no answer within the timeout -> direct, and says so", async (t) => {
    const { api, post, log } = await rig({ answers: false, timeoutMs: 40 });
    t.after(api.close);
    const r = await post("/spawn", { via: "board", cwd: "/repo", prompt: "x" });
    assert.equal(r.body.via, "direct");
    assert.equal(log.direct.length, 1);
  });

  test("a board that answers with an error is a 400, not a second start", async (t) => {
    const { api, post, log } = await rig({ reply: { ok: false, error: "nope" } });
    t.after(api.close);
    const r = await post("/spawn", { via: "board", cwd: "/repo" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "nope");
    assert.equal(log.direct.length, 0);
  });

  test("without via, /spawn is the old direct path and asks the board nothing", async (t) => {
    const { api, post, log } = await rig();
    t.after(api.close);
    const r = await post("/spawn", { cwd: "/repo" });
    assert.equal(r.body.via, undefined);
    assert.equal(log.asked.length, 0);
  });
});

describe("POST /send via board", () => {
  const consoles = [
    { key: 3, id: "c1", running: true },
    { key: 4, id: "gone", running: false },
  ];

  test("goes through the board's sendPrompt", async (t) => {
    const { api, post, log } = await rig({ consoles });
    t.after(api.close);
    const r = await post("/send?id=c1", { via: "board", prompt: "more" });
    assert.deepEqual([r.status, r.body.via], [200, "board"]);
    assert.deepEqual(log.prompts, [{ key: 3, text: "more" }]);
    assert.equal(log.directSends.length, 0);
  });

  test("a finished console is the board's to resume, not a 409", async (t) => {
    const { api, post, log } = await rig({ consoles });
    t.after(api.close);
    const r = await post("/send?id=gone", { via: "board", prompt: "again" });
    assert.equal(r.status, 200);
    assert.equal(log.prompts[0].key, 4);
  });

  test("a console the board does not hold (started direct) falls back to direct", async (t) => {
    const { api, post, log } = await rig();
    t.after(api.close);
    const r = await post("/spawn", { cwd: "/repo" }); // direct d1, unknown to the board
    const s = await post(`/send?id=${r.body.id}`, { via: "board", prompt: "hi" });
    assert.deepEqual([s.status, s.body.via], [200, "direct"]);
    assert.deepEqual(log.directSends, [{ id: "d1", text: "hi" }]);
  });

  test("no board window -> direct", async (t) => {
    const { api, post, log } = await rig({ window: false, consoles });
    t.after(api.close);
    const r = await post("/send?id=c1", { via: "board", prompt: "more" });
    assert.equal(r.body.via, "direct");
    assert.equal(log.directSends.length, 1);
  });
});

describe("pieces", () => {
  test("pickerModel turns an alias into the picker's id and leaves the rest alone", () => {
    assert.equal(pickerModel("claude", "sonnet", AGENTS), "claude-sonnet-5");
    assert.equal(pickerModel("claude", "claude-opus-5-5", AGENTS), "claude-opus-5-5");
    assert.equal(pickerModel("codex", "gpt-5", AGENTS), "gpt-5");
    assert.equal(pickerModel("claude", "", AGENTS), "");
  });

  test("the haiku and sonnet aliases keep meaning 4.5 and 5; the 5.5 ids pass through whole", () => {
    // Haiku 5.5 / Sonnet 5.5 are picked by full id. The alias must not drift to them: they sit after the older ones.
    assert.equal(pickerModel("claude", "haiku", [{ name: "claude", models: CLAUDE_MODELS }]), "claude-haiku-4-5-20251001");
    assert.equal(pickerModel("claude", "sonnet", [{ name: "claude", models: CLAUDE_MODELS }]), "claude-sonnet-5");
    assert.equal(pickerModel("claude", "claude-haiku-5-5", [{ name: "claude", models: CLAUDE_MODELS }]), "claude-haiku-5-5");
    assert.equal(pickerModel("claude", "claude-sonnet-5-5", [{ name: "claude", models: CLAUDE_MODELS }]), "claude-sonnet-5-5");
  });

  test("a reply nobody is waiting for is refused", () => {
    assert.equal(createBoardAsk({ send: () => true }).reply("nope", { ok: true }), false);
  });
});

describe("wiring (board.ts and main.js cannot run here, so their contract is read)", () => {
  const board = readFileSync(path.join(ROOT, "board", "src", "lib", "board.ts"), "utf8");
  const main = readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8");

  test("board.ts: a background start does not take activeConsole or the launcher's own picks", () => {
    assert.match(board, /\.\.\.\(background \? \{\} : \{ activeConsole: c\.key, launching: false, \.\.\.showConversation\(\) \}\)/);
    assert.match(board, /const claude = name === "claude" && !background;/);
  });

  test("board.ts answers main's request through boardReply", () => {
    assert.match(board, /onBoardRequest\(\(req\) =>[\s\S]*?answerBoardRequest\(req,[\s\S]*?boardReply!\(req\.reqId, r\)/);
  });

  test("main.js: only a root the API itself asked about is trusted through the board's start", () => {
    assert.match(main, /trusted: apiRoots\.has\(path\.resolve/);
    assert.match(main, /apiRoots\.add\(dir\);[\s\S]*?finally \{\s*apiRoots\.delete\(dir\);/);
  });
});

describe("a slow board start is never doubled", () => {
  const { createBoardAsk } = require(path.join(ROOT, "desktop", "board-ask.js"));
  const board = readFileSync(path.join(ROOT, "board", "src", "lib", "board.ts"), "utf8");

  test("an accepted request waits past the fallback window for the real answer", async () => {
    let id;
    const ask = createBoardAsk({ send: (reqId) => { id = reqId; return true; }, timeoutMs: 20, finishMs: 500 });
    const p = ask.ask("start", {});
    ask.reply(id, { accepted: true });
    setTimeout(() => ask.reply(id, { ok: true, id: "c1" }), 60); // well past the 20 ms fallback window
    assert.deepEqual(await p, { ok: true, id: "c1" });
  });

  test("accepted but never finished is an error, not a fallback (a fallback would start it twice)", async () => {
    let id;
    const ask = createBoardAsk({ send: (reqId) => { id = reqId; return true; }, timeoutMs: 20, finishMs: 40 });
    const p = ask.ask("start", {});
    ask.reply(id, { accepted: true });
    const r = await p;
    assert.notEqual(r, null);
    assert.equal(r.ok, false);
  });

  test("nobody accepting falls back (null)", async () => {
    const ask = createBoardAsk({ send: () => true, timeoutMs: 20 });
    assert.equal(await ask.ask("start", {}), null);
  });

  test("the board accepts before any await", () => {
    assert.match(board, /onBoardRequest\(\(req\) => \{\s*(\/\/[^\n]*\n\s*)*void asked\.boardReply!\(req\.reqId, \{ accepted: true \}\);/);
  });
});
