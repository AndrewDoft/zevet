// The terminal client for the local control API (desktop/zevet-agent.mjs).
// Every function that touches the real world (fetch, the filesystem, stdin)
// takes an injected replacement, so this suite never starts a real
// agent-api server and never reads a real ~/.zevet/agent-api.json.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { parseArgs, loadDiscovery, request, fmtElapsed, fmtList, fmtEvent, fmtOutput, run } from "../desktop/zevet-agent.mjs";

describe("parseArgs", () => {
  test("a bare command with no flags", () => {
    assert.deepEqual(parseArgs(["list"]), { command: "list", opts: {} });
  });

  test("--flag value pairs", () => {
    assert.deepEqual(parseArgs(["spawn", "--cwd", "/repo", "--model", "opus"]), {
      command: "spawn",
      opts: { cwd: "/repo", model: "opus" },
    });
  });

  test("a flag with no following value (or followed by another flag) is boolean true", () => {
    assert.deepEqual(parseArgs(["status", "--id"]), { command: "status", opts: { id: true } });
    assert.deepEqual(parseArgs(["spawn", "--cwd", "/r", "--dangerous", "--model", "opus"]), {
      command: "spawn",
      opts: { cwd: "/r", dangerous: true, model: "opus" },
    });
  });

  test("no command at all", () => {
    assert.deepEqual(parseArgs([]), { command: "", opts: {} });
  });
});

describe("loadDiscovery", () => {
  test("parses url/token out of the discovery file", () => {
    const d = loadDiscovery({ file: "/x/agent-api.json", readFileSyncImpl: () => JSON.stringify({ url: "http://127.0.0.1:1234", token: "tok" }) });
    assert.deepEqual(d, { url: "http://127.0.0.1:1234", token: "tok" });
  });

  test("a missing file is reported as zevet not running, not a raw ENOENT", () => {
    const readFileSyncImpl = () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    assert.throws(() => loadDiscovery({ file: "/x/agent-api.json", readFileSyncImpl }), /zevet is not running/);
  });

  test("unparseable JSON is reported plainly", () => {
    assert.throws(() => loadDiscovery({ file: "/x/agent-api.json", readFileSyncImpl: () => "{not json" }), /not valid JSON/);
  });

  test("a file missing url or token is reported plainly", () => {
    assert.throws(() => loadDiscovery({ file: "/x/agent-api.json", readFileSyncImpl: () => JSON.stringify({ url: "http://x" }) }), /missing url\/token/);
  });
});

describe("request", () => {
  test("sends the bearer token and builds the query string", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init });
      return { status: 200, json: async () => ({ ok: true }) };
    };
    const r = await request({ url: "http://127.0.0.1:9", token: "tok" }, "GET", "/status", { query: { id: "c1", tail: undefined }, fetchImpl });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(calls[0].url, "http://127.0.0.1:9/status?id=c1");
    assert.equal(calls[0].init.headers.authorization, "Bearer tok");
  });

  test("a JSON body is sent with a content-type header", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(init);
      return { status: 200, json: async () => ({ ok: true }) };
    };
    await request({ url: "http://127.0.0.1:9", token: "tok" }, "POST", "/spawn", { body: { cwd: "/r" }, fetchImpl });
    assert.equal(calls[0].headers["content-type"], "application/json");
    assert.equal(calls[0].body, JSON.stringify({ cwd: "/r" }));
  });
});

describe("formatters", () => {
  test("fmtElapsed: seconds, minutes, hours", () => {
    assert.equal(fmtElapsed(5000), "5s");
    assert.equal(fmtElapsed(65_000), "1m5s");
    assert.equal(fmtElapsed(3_725_000), "1h2m");
  });

  test("fmtList: no agents", () => {
    assert.equal(fmtList([]), "(no agents)");
    assert.equal(fmtList(undefined), "(no agents)");
  });

  test("fmtList: a row per console, aligned columns, missing fields dashed", () => {
    const out = fmtList([
      { id: "c1", label: "worker-a", agent: "claude", engine: "engine2", model: "opus", running: true, elapsedMs: 5000, lastTool: "Bash" },
      { id: "c2", agent: "claude", running: false, elapsedMs: 0 },
    ]);
    const lines = out.split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^ID\s+LABEL\s+AGENT\s+ENGINE\s+MODEL\s+STATE\s+ELAPSED\s+LAST TOOL\s*$/);
    assert.match(lines[1], /^c1\s+worker-a\s+claude\s+engine2\s+opus\s+running\s+5s\s+Bash\s*$/);
    assert.match(lines[2], /^c2\s+-\s+claude\s+-\s+-\s+stopped\s+0s\s+-\s*$/);
  });

  test("fmtEvent: a prompt line", () => {
    assert.equal(fmtEvent({ type: "prompt", text: "fix the parser" }), "> fix the parser");
  });

  test("fmtEvent: claude's own result line wins over content parts", () => {
    assert.equal(fmtEvent({ type: "agent", payload: { type: "result", result: "done" } }), "done");
  });

  test("fmtEvent: text and tool_use content parts", () => {
    const evt = { type: "agent", payload: { message: { content: [{ type: "text", text: "looking" }, { type: "tool_use", name: "Grep" }] } } };
    assert.equal(fmtEvent(evt), "looking\n[tool] Grep");
  });

  test("fmtEvent: exit, gap, stderr, stdout-line", () => {
    assert.equal(fmtEvent({ type: "exit", code: 0, signal: null }), "[exit code=0]");
    assert.equal(fmtEvent({ type: "exit", code: null, signal: "SIGTERM" }), "[exit code=null signal=SIGTERM]");
    assert.equal(fmtEvent({ type: "gap", dropped: 12 }), "... 12 event(s) dropped ...");
    assert.equal(fmtEvent({ type: "stderr", text: "warning\n" }), "warning");
    assert.equal(fmtEvent({ type: "stdout-line", line: "hello" }), "hello");
  });

  test("fmtEvent: nothing usable is an empty string, not a crash", () => {
    assert.equal(fmtEvent({ type: "agent", payload: {} }), "");
    assert.equal(fmtEvent(null), "");
  });

  test("fmtOutput drops blank lines between events", () => {
    const events = [{ type: "prompt", text: "hi" }, { type: "agent", payload: {} }, { type: "exit", code: 0 }];
    assert.equal(fmtOutput(events), "> hi\n[exit code=0]");
  });
});

describe("run — command dispatch", () => {
  const disc = { url: "http://127.0.0.1:9", token: "tok" };

  test("spawn sends cwd/prompt/model/engine/mode/label and reports the id", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
      return { status: 200, json: async () => ({ ok: true, id: "c1", engine: "engine2" }) };
    };
    const r = await run(
      ["spawn", "--cwd", "/repo", "--prompt", "fix it", "--model", "opus", "--engine", "engine2", "--mode", "auto", "--label", "worker-1"],
      { disc, fetchImpl },
    );
    assert.equal(r.exitCode, 0);
    assert.deepEqual(JSON.parse(r.text), { ok: true, id: "c1", engine: "engine2" });
    assert.deepEqual(calls[0].body, { cwd: "/repo", prompt: "fix it", model: "opus", engine: "engine2", mode: "auto", label: "worker-1" });
  });

  test("spawn without --prompt reads the prompt from stdin", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(init.body ? JSON.parse(init.body) : undefined);
      return { status: 200, json: async () => ({ ok: true, id: "c1" }) };
    };
    const stdin = fakeStdin("read the docs\n");
    await run(["spawn", "--cwd", "/repo"], { disc, fetchImpl, stdin });
    assert.equal(calls[0].prompt, "read the docs\n");
  });

  test("spawn requires --cwd", async () => {
    await assert.rejects(() => run(["spawn"], { disc, fetchImpl: async () => ({}) }), /--cwd/);
  });

  test("a failed spawn (bad cwd) is a non-zero exit with the server's error", async () => {
    const fetchImpl = async () => ({ status: 400, json: async () => ({ ok: false, error: "cwd does not exist" }) });
    const r = await run(["spawn", "--cwd", "/nope"], { disc, fetchImpl, stdin: fakeStdin("") });
    assert.equal(r.exitCode, 1);
    assert.equal(r.text, "cwd does not exist");
  });

  test("wait prints the bare result text, not JSON", async () => {
    const fetchImpl = async () => ({ status: 200, json: async () => ({ ok: true, resultText: "the answer is 42" }) });
    const r = await run(["wait", "--id", "c1"], { disc, fetchImpl });
    assert.equal(r.exitCode, 0);
    assert.equal(r.text, "the answer is 42");
  });

  test("wait requires --id", async () => {
    await assert.rejects(() => run(["wait"], { disc, fetchImpl: async () => ({}) }), /--id/);
  });

  test("output formats the transcript tail", async () => {
    const fetchImpl = async () => ({ status: 200, json: async () => ({ ok: true, events: [{ type: "prompt", text: "hi" }] }) });
    const r = await run(["output", "--id", "c1", "--tail", "5"], { disc, fetchImpl });
    assert.equal(r.text, "> hi");
  });

  test("list formats the table", async () => {
    const fetchImpl = async () => ({ status: 200, json: async () => ({ ok: true, consoles: [] }) });
    const r = await run(["list"], { disc, fetchImpl });
    assert.equal(r.text, "(no agents)");
  });

  test("stop reports success plainly", async () => {
    const fetchImpl = async () => ({ status: 200, json: async () => ({ ok: true }) });
    const r = await run(["stop", "--id", "c1"], { disc, fetchImpl });
    assert.equal(r.exitCode, 0);
    assert.equal(r.text, "stopped");
  });

  test("an unknown command shows usage and fails", async () => {
    const r = await run(["nonsense"], { disc, fetchImpl: async () => ({}) });
    assert.equal(r.exitCode, 1);
    assert.match(r.text, /usage:/);
  });
});

function fakeStdin(data) {
  const s = new Readable({ read() {} });
  s.isTTY = false;
  process.nextTick(() => {
    s.push(data);
    s.push(null);
  });
  return s;
}
