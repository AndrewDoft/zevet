// The `ask_user` tool: an agent asking the person to choose, and blocking.
//
// Andrew: "needs something so it can ask me multiple choice questions like you
// do in terminal ... rather than needing me to write out responses in chat all
// the time."
//
// Two things are worth pinning and both are about the TRUST BOUNDARY rather
// than about the feature working:
//
//   1. Asking is not behind the computer-use gate, and the mouse still is.
//      Giving every agent a question box must not have given every agent the
//      cursor as a side effect.
//   2. The question is the agent's own text. It is bounded before a person is
//      ever shown it, so the board is never handed a shape it has to defend
//      against.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const mcp = require(path.join(ROOT, "desktop", "zevet-mcp.js"));
const SERVER = path.join(ROOT, "desktop", "zevet-mcp.js");

/** tools/list over the real stdio protocol, not the exported table — this is
 *  what the CLI actually sees, and the two could drift. */
function announced(env) {
  const out = execFileSync(process.execPath, [SERVER], {
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
  const line = out.trim().split("\n").find((l) => l.includes("tools"));
  return JSON.parse(line).result.tools.map((t) => t.name);
}

describe("which tools an agent is given", () => {
  test("every agent may ask; only computer-use runs get the mouse", () => {
    const plain = announced({ ZEVET_MCP_COMPUTER: "" });
    assert.deepEqual(plain, ["ask_user"], "a plain run must offer asking and nothing else");
    const full = announced({ ZEVET_MCP_COMPUTER: "1" });
    assert.ok(full.includes("ask_user"), "asking must survive the capability being on");
    for (const t of ["screenshot", "click", "type_text", "press_key", "permission_prompt"]) {
      assert.ok(full.includes(t), `${t} is missing when computer use is on`);
      assert.ok(!plain.includes(t), `${t} leaked into a run without computer use`);
    }
  });

  test("a tool left out of the list is also refused when called anyway", async () => {
    // tools/list is discovery, not enforcement: a model that remembers `click`
    // from another run must still be refused by the handler.
    delete process.env.ZEVET_MCP_COMPUTER;
    const r = await mcp.callTool("click", { x: 1, y: 1 });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /not available in this run/);
  });
});

describe("the question itself", () => {
  const clean = mcp.cleanQuestion;

  test("a usable question comes back bounded and normalised", () => {
    const r = clean({
      question: "  Ship   it?\n",
      header: "Release",
      multi: true,
      options: [{ label: "Yes", description: "go now" }, { label: "No" }],
    });
    assert.equal(r.question, "Ship it?");
    assert.equal(r.header, "Release");
    assert.equal(r.multi, true);
    assert.deepEqual(r.options, [
      { label: "Yes", description: "go now" },
      { label: "No", description: "" },
    ]);
  });

  test("it refuses what a person could not answer", () => {
    assert.ok(clean({ options: [{ label: "a" }, { label: "b" }] }).error, "a question with no text");
    assert.ok(clean({ question: "Pick?", options: [{ label: "a" }] }).error, "one option is not a choice");
    assert.ok(clean({ question: "Pick?" }).error, "no options at all");
    assert.ok(clean({ question: "Pick?", options: [{ label: "" }, { label: " " }] }).error, "blank labels");
  });

  test("duplicate labels collapse, because the answer IS the label", () => {
    const r = clean({ question: "Pick?", options: [{ label: "a" }, { label: "a" }, { label: "b" }] });
    assert.deepEqual(r.options.map((o) => o.label), ["a", "b"]);
  });

  test("it is bounded, because the card blocks until it is answered", () => {
    const r = clean({
      question: "q".repeat(900),
      header: "h".repeat(90),
      options: Array.from({ length: 9 }, (_, i) => ({ label: `l${i}`.padEnd(200, "x"), description: "d".repeat(400) })),
    });
    assert.equal(r.question.length, 400);
    assert.equal(r.header.length, 24);
    assert.equal(r.options.length, 4, "at most four options reach a person");
    assert.equal(r.options[0].label.length, 60);
    assert.equal(r.options[0].description.length, 160);
  });
});

describe("the gate that carries it", () => {
  test("the ask route is refused when the main process offers no handler", async () => {
    const askServer = require(path.join(ROOT, "desktop", "ask-server.js"));
    // ⚠️ An older main process paired with a newer server must 404 the route,
    // not throw inside a handler on the port the permit gate depends on.
    const gate = await askServer.start({ onPermit: () => ({ ok: false }) });
    try {
      const res = await fetch(`${gate.url}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${gate.token}` },
        body: JSON.stringify({ question: "Pick?", options: [{ label: "a" }, { label: "b" }] }),
      });
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.match(body.reason, /not found/);
    } finally {
      await gate.close();
    }
  });

  test("an answer comes back as the labels that were chosen", async () => {
    const askServer = require(path.join(ROOT, "desktop", "ask-server.js"));
    const gate = await askServer.start({
      onPermit: () => ({ ok: false }),
      onAsk: (q) => ({ ok: true, picked: [q.options[1].label] }),
    });
    try {
      const res = await fetch(`${gate.url}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${gate.token}` },
        body: JSON.stringify({ question: "Pick?", options: [{ label: "a" }, { label: "b" }] }),
      });
      assert.deepEqual(await res.json(), { ok: true, picked: ["b"] });
    } finally {
      await gate.close();
    }
  });

  test("silence is an absent answer, not a tool failure", async () => {
    const askServer = require(path.join(ROOT, "desktop", "ask-server.js"));
    const gate = await askServer.start({
      onPermit: () => ({ ok: false }),
      onAsk: () => new Promise(() => {}),
      timeoutMs: 40,
    });
    try {
      const res = await fetch(`${gate.url}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${gate.token}` },
        body: JSON.stringify({ question: "Pick?", options: [{ label: "a" }, { label: "b" }] }),
      });
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.deepEqual(body.picked, []);
      assert.match(body.reason, /nobody answered/);
    } finally {
      await gate.close();
    }
  });
});

describe("the desktop side actually wires the gate up", () => {
  // ask-server.js has always accepted an `onAsk` option (tested above) and
  // board.ts/bridge.ts/fixture.ts have always declared onAskRequest/askAnswer
  // (they are a demo-bridge-only capability without this) — but until now
  // desktop/main.js's ensureAskServer() passed only `onPermit`, so `/ask`
  // 404'd on every real desktop build and AskPrompt could never render.
  // Source assertions for the same reason test/desktop-bridges.test.mjs uses
  // them: importing main.js outside Electron throws on require("electron").
  const main = readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8");
  const preload = readFileSync(path.join(ROOT, "desktop", "preload.js"), "utf8");

  test("ensureAskServer passes an onAsk handler to the gate", () => {
    const start = main.indexOf("askServer.start(");
    assert.ok(start >= 0, "main.js never calls askServer.start");
    const end = main.indexOf("ipcMain.handle(", start);
    const body = main.slice(start, end < 0 ? start + 1000 : end);
    assert.match(body, /onPermit:/, "sanity: onPermit should still be in this slice");
    assert.match(body, /onAsk:/, "askServer.start is missing onAsk — /ask stays 404 forever");
  });

  test("local:askAnswer is handled, and answers with the picked labels", () => {
    assert.match(main, /ipcMain\.handle\("local:askAnswer"/);
  });

  test("preload exposes onAskRequest and askAnswer on window.zevetLocal", () => {
    assert.match(preload, /onAskRequest:/);
    assert.match(preload, /askAnswer:\s*\(id,\s*picked\)\s*=>\s*ipcRenderer\.invoke\("local:askAnswer"/);
  });
});
