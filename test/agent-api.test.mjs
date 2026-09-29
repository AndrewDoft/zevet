// The local control API (desktop/agent-api.js). Real HTTP against a real
// loopback server, same rig ask-server's own suite uses (test/computer-use.
// test.mjs § "ask-server — the loopback gate itself") -- everything main.js
// would normally supply (startAgentCore etc.) is a small in-memory fake, so
// this never touches Electron or spawns a real agent.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const agentApi = require(path.join(ROOT, "desktop", "agent-api.js"));
const { summarize, lastToolFrom, resultTextFrom } = agentApi._internals;

function fakeBackend() {
  const entries = new Map();
  let seq = 0;
  return {
    entries,
    startAgentCore: async ({ agent, cwd, opts, trusted }) => {
      if (trusted && cwd === "/does/not/exist") return { ok: false, error: "cwd does not exist" };
      const id = `c${++seq}`;
      entries.set(id, {
        id,
        agent,
        root: cwd,
        model: (opts && opts.model) || "",
        mode: (opts && opts.mode) || "auto",
        engine: opts && opts.engine,
        label: opts && opts.label,
        running: true,
        startedAt: Date.now(),
        events: [],
      });
      return { ok: true, id, agent, cwd, engine: opts && opts.engine };
    },
    sendToAgentCore: (id, text) => {
      const e = entries.get(id);
      if (!e) return { ok: false, error: "no such console" };
      e.events.push({ type: "prompt", text });
      return { ok: true };
    },
    stopAgentCore: (id) => {
      const e = entries.get(id);
      if (!e) return { ok: false, error: "no such console" };
      e.running = false;
      return { ok: true };
    },
    getConsole: (id) => entries.get(id),
    listConsoles: () => [...entries.values()],
  };
}

async function startApi(overrides = {}) {
  const backend = fakeBackend();
  const api = await agentApi.start({ ...backend, ...overrides });
  return { ...api, backend };
}

function authed(token, init) {
  return { ...init, headers: { ...(init && init.headers), authorization: `Bearer ${token}` } };
}

describe("auth and transport", () => {
  test("rejects a missing token", async (t) => {
    const { url, close } = await startApi();
    t.after(close);
    const res = await fetch(`${url}/list`);
    assert.equal(res.status, 401);
  });

  test("rejects a wrong token", async (t) => {
    const { url, close } = await startApi();
    t.after(close);
    const res = await fetch(`${url}/list`, { headers: { authorization: "Bearer nope" } });
    assert.equal(res.status, 401);
  });

  test("an unknown route is 404", async (t) => {
    const { url, token, close } = await startApi();
    t.after(close);
    const res = await fetch(`${url}/nonsense`, authed(token));
    assert.equal(res.status, 404);
  });

  test("start() requires every dependency", async () => {
    await assert.rejects(() => agentApi.start({}), /startAgentCore/);
  });
});

describe("POST /spawn", () => {
  test("starts an agent in a trusted (not necessarily opened) directory", async (t) => {
    const { url, token, close, backend } = await startApi();
    t.after(close);
    const res = await fetch(
      `${url}/spawn`,
      authed(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: "/some/repo", model: "opus", engine: "engine2", label: "orchestrator-worker-1" }),
      }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.engine, "engine2");
    const entry = backend.entries.get(body.id);
    assert.equal(entry.root, "/some/repo");
    assert.equal(entry.label, "orchestrator-worker-1");
  });

  test("a prompt is delivered via sendToAgentCore right after starting", async (t) => {
    const { url, token, close, backend } = await startApi();
    t.after(close);
    const res = await fetch(
      `${url}/spawn`,
      authed(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: "/some/repo", prompt: "fix the parser" }),
      }),
    );
    const body = await res.json();
    const entry = backend.entries.get(body.id);
    assert.deepEqual(entry.events, [{ type: "prompt", text: "fix the parser" }]);
  });

  test("a cwd startAgentCore refuses is a 400, not a 200 with ok:false buried in it", async (t) => {
    const { url, token, close } = await startApi();
    t.after(close);
    const res = await fetch(
      `${url}/spawn`,
      authed(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: "/does/not/exist" }),
      }),
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
  });

  test("invalid JSON body is a 400", async (t) => {
    const { url, token, close } = await startApi();
    t.after(close);
    const res = await fetch(url + "/spawn", authed(token, { method: "POST", body: "{not json" }));
    assert.equal(res.status, 400);
  });
});

describe("GET /status, /output, /list", () => {
  async function spawned(url, token, extra = {}) {
    const res = await fetch(
      `${url}/spawn`,
      authed(token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/r", ...extra }) }),
    );
    return (await res.json()).id;
  }

  test("status reports the last tool call from the claude-shaped event stream", async (t) => {
    const { url, token, close, backend } = await startApi();
    t.after(close);
    const id = await spawned(url, token);
    backend.entries.get(id).events.push(
      { type: "agent", payload: { message: { content: [{ type: "tool_use", name: "Bash" }] } } },
      { type: "agent", payload: { message: { content: [{ type: "tool_use", name: "Edit" }] } } },
    );
    const res = await fetch(`${url}/status?id=${id}`, authed(token));
    const body = await res.json();
    assert.equal(body.lastTool, "Edit");
    assert.equal(body.running, true);
    assert.ok(body.elapsedMs >= 0);
  });

  test("status for an unknown id is 404", async (t) => {
    const { url, token, close } = await startApi();
    t.after(close);
    const res = await fetch(`${url}/status?id=nope`, authed(token));
    assert.equal(res.status, 404);
  });

  test("output tails the event list", async (t) => {
    const { url, token, close, backend } = await startApi();
    t.after(close);
    const id = await spawned(url, token);
    for (let i = 0; i < 5; i++) backend.entries.get(id).events.push({ type: "agent", payload: { n: i } });
    const res = await fetch(`${url}/output?id=${id}&tail=2`, authed(token));
    const body = await res.json();
    assert.deepEqual(
      body.events.map((e) => e.payload.n),
      [3, 4],
    );
  });

  test("list shows every console", async (t) => {
    const { url, token, close } = await startApi();
    t.after(close);
    await spawned(url, token, { label: "a" });
    await spawned(url, token, { label: "b" });
    const res = await fetch(`${url}/list`, authed(token));
    const body = await res.json();
    assert.equal(body.consoles.length, 2);
    assert.deepEqual(
      body.consoles.map((c) => c.label).sort(),
      ["a", "b"],
    );
  });
});

describe("POST /stop", () => {
  test("stops a running console", async (t) => {
    const { url, token, close, backend } = await startApi();
    t.after(close);
    const res0 = await fetch(`${url}/spawn`, authed(token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/r" }) }));
    const id = (await res0.json()).id;
    const res = await fetch(`${url}/stop?id=${id}`, authed(token, { method: "POST" }));
    assert.equal(res.status, 200);
    assert.equal(backend.entries.get(id).running, false);
  });

  test("stopping an unknown id is a 404", async (t) => {
    const { url, token, close } = await startApi();
    t.after(close);
    const res = await fetch(`${url}/stop?id=nope`, authed(token, { method: "POST" }));
    assert.equal(res.status, 404);
  });
});

describe("POST /wait", () => {
  test("blocks until the console stops running, then reports the result text", async (t) => {
    const { url, token, close, backend } = await startApi();
    t.after(close);
    const res0 = await fetch(`${url}/spawn`, authed(token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/r" }) }));
    const id = (await res0.json()).id;
    setTimeout(() => {
      const e = backend.entries.get(id);
      e.events.push({ type: "agent", payload: { type: "result", result: "done: parser fixed" } });
      e.running = false;
    }, 350);
    const started = Date.now();
    const res = await fetch(`${url}/wait?id=${id}`, authed(token, { method: "POST" }));
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.running, false);
    assert.equal(body.resultText, "done: parser fixed");
    assert.ok(Date.now() - started >= 300, "wait must not return before the console actually stopped");
  });

  test("times out rather than blocking forever on a console that never finishes", async (t) => {
    const { url, token, close } = await startApi();
    t.after(close);
    const res0 = await fetch(`${url}/spawn`, authed(token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/r" }) }));
    const id = (await res0.json()).id;
    const res = await fetch(`${url}/wait?id=${id}&timeoutMs=50`, authed(token, { method: "POST" }));
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /timed out/);
  });

  test("waiting on an unknown id is a 404", async (t) => {
    const { url, token, close } = await startApi();
    t.after(close);
    const res = await fetch(`${url}/wait?id=nope`, authed(token, { method: "POST" }));
    assert.equal(res.status, 404);
  });
});

describe("pure helpers", () => {
  test("lastToolFrom reads claude's tool_use content parts, most recent event wins", () => {
    const events = [
      { type: "agent", payload: { message: { content: [{ type: "tool_use", name: "Bash" }] } } },
      { type: "stdout-line", line: "noise" },
      { type: "agent", payload: { message: { content: [{ type: "text", text: "thinking" }, { type: "tool_use", name: "Edit" }] } } },
    ];
    assert.equal(lastToolFrom(events), "Edit");
  });

  test("lastToolFrom picks the last tool_use WITHIN one event's content too, not the first", () => {
    const events = [
      {
        type: "agent",
        payload: { message: { content: [{ type: "tool_use", name: "Read" }, { type: "text", text: "..." }, { type: "tool_use", name: "Grep" }] } },
      },
    ];
    assert.equal(lastToolFrom(events), "Grep");
  });

  test("lastToolFrom is null when nothing looks like a tool call", () => {
    assert.equal(lastToolFrom([{ type: "agent", payload: { message: { content: [{ type: "text", text: "hi" }] } } }]), null);
    assert.equal(lastToolFrom([]), null);
  });

  test("resultTextFrom prefers claude's own result line", () => {
    const events = [
      { type: "agent", payload: { message: { content: [{ type: "text", text: "partial" }] } } },
      { type: "agent", payload: { type: "result", result: "final answer" } },
    ];
    assert.equal(resultTextFrom(events), "final answer");
  });

  test("resultTextFrom falls back to the last assistant message's text", () => {
    const events = [{ type: "agent", payload: { message: { content: [{ type: "text", text: "the " }, { type: "text", text: "answer" }] } } }];
    assert.equal(resultTextFrom(events), "the answer");
  });

  test("resultTextFrom is empty, not null, when nothing usable is found", () => {
    assert.equal(resultTextFrom([]), "");
  });

  test("summarize is null for a missing entry", () => {
    assert.equal(summarize(undefined), null);
  });
});

describe("turn state: /wait, /send, --once", () => {
  const post = (url, token, path, body) =>
    fetch(url + path, authed(token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }));
  const spawnId = async (url, token) => (await (await post(url, token, "/spawn", { cwd: "/r" })).json()).id;

  test("summarize exposes state, turns, lastResult, cost, usage", () => {
    const s = summarize({ id: "c", running: true, state: "idle", turns: 2, lastResult: "hi", costUsd: 0.5, usage: { output_tokens: 3 }, startedAt: Date.now(), events: [] });
    assert.equal(s.state, "idle");
    assert.equal(s.turns, 2);
    assert.equal(s.lastResult, "hi");
    assert.equal(s.costUsd, 0.5);
    assert.deepEqual(s.usage, { output_tokens: 3 });
  });

  test("an entry without a tracked state falls back to running-or-exited", () => {
    assert.equal(summarize({ running: true, startedAt: 0, events: [] }).state, "working");
    assert.equal(summarize({ running: false, startedAt: 0, events: [] }).state, "exited");
  });

  test("wait returns on the turn's result while the process is STILL running", async () => {
    const { url, token, close, backend } = await startApi();
    const id = await spawnId(url, token);
    const e = backend.entries.get(id);
    e.state = "working";
    setTimeout(() => Object.assign(e, { state: "idle", turns: 1, lastResult: "ZEVET-OK" }), 100);
    const body = await (await post(url, token, `/wait?id=${id}&timeoutMs=5000`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.running, true);
    assert.equal(body.state, "idle");
    assert.equal(body.resultText, "ZEVET-OK");
    await close();
  });

  test("wait times out while the turn is still working", async () => {
    const { url, token, close, backend } = await startApi();
    const id = await spawnId(url, token);
    backend.entries.get(id).state = "working";
    const body = await (await post(url, token, `/wait?id=${id}&timeoutMs=400`)).json();
    assert.equal(body.ok, false);
    assert.match(body.error, /timed out/);
    await close();
  });

  test("wait on an exited agent falls back to the transcript's text", async () => {
    const { url, token, close, backend } = await startApi();
    const id = await spawnId(url, token);
    const e = backend.entries.get(id);
    e.running = false;
    e.events.push({ type: "agent", payload: { message: { content: [{ type: "text", text: "codex says hi" }] } } });
    const body = await (await post(url, token, `/wait?id=${id}&timeoutMs=1000`)).json();
    assert.equal(body.state, "exited");
    assert.equal(body.resultText, "codex says hi");
    await close();
  });

  test("/send forwards a follow-up prompt; refuses empty, unknown and exited", async () => {
    const { url, token, close, backend } = await startApi();
    const id = await spawnId(url, token);
    assert.equal((await post(url, token, `/send?id=${id}`, { prompt: "next" })).status, 200);
    assert.deepEqual(backend.entries.get(id).events.at(-1), { type: "prompt", text: "next" });
    assert.equal((await post(url, token, `/send?id=${id}`, {})).status, 400);
    assert.equal((await post(url, token, "/send?id=nope", { prompt: "x" })).status, 404);
    backend.entries.get(id).running = false;
    assert.equal((await post(url, token, `/send?id=${id}`, { prompt: "x" })).status, 409);
    await close();
  });

  test("spawn once:true marks the console; without it nothing is marked", async () => {
    const marked = [];
    const { url, token, close } = await startApi({ setOnce: (id) => marked.push(id) });
    const { id } = await (await post(url, token, "/spawn", { cwd: "/r", prompt: "go", once: true })).json();
    assert.deepEqual(marked, [id]);
    await post(url, token, "/spawn", { cwd: "/r", prompt: "go" });
    assert.deepEqual(marked, [id]);
    await close();
  });
});
