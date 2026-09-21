// The desktop half of computer use: the platform command builders
// (computer.js), the stdio MCP server that exposes them to an agent
// (zevet-mcp.js), and the loopback permission gate (ask-server.js).
//
// Same seam discipline as agent-console.test.mjs: nothing here spawns
// PowerShell, osascript or a real screen capture. computer.js's job is to
// BUILD a { command, args } pair without running it — that is the whole
// point of the split — so the builders are asserted directly. zevet-mcp.js
// IS spawned for real, over a real pipe, because the thing under test there
// (JSON-RPC framing, the permission gate) is only real once a process
// boundary exists between "wrote a message" and "read a message" — an
// in-process function call would not exercise the newline framing at all.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The modules under test are CommonJS (see desktop/agent-console.js's own
// note on this), same as agent-console.test.mjs.
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { captureCommand, screenSizeCommand, parseScreenSize, clickCommand, typeCommand, keyCommand } = require(
  path.join(ROOT, "desktop", "computer.js"),
);
const { start: startAskServer } = require(path.join(ROOT, "desktop", "ask-server.js"));

const MCP_PATH = path.join(ROOT, "desktop", "zevet-mcp.js");

// ---------------------------------------------------------------------------
// computer.js — command builders (per platform, without a screen)
// ---------------------------------------------------------------------------

describe("captureCommand", () => {
  test("win32: powershell with System.Drawing, saving to the given path", () => {
    const r = captureCommand({ outputPath: "C:\\tmp\\shot.png", platform: "win32" });
    assert.equal(r.ok, true);
    assert.equal(r.command, "powershell.exe");
    assert.match(r.args.join(" "), /CopyFromScreen/);
    assert.match(r.args.join(" "), /shot\.png/);
    assert.equal(r.outputPath, "C:\\tmp\\shot.png");
  });

  test("darwin: screencapture -x -t png <path>", () => {
    const r = captureCommand({ outputPath: "/tmp/shot.png", platform: "darwin" });
    assert.equal(r.ok, true);
    assert.deepEqual(r, {
      ok: true,
      command: "screencapture",
      args: ["-x", "-t", "png", "/tmp/shot.png"],
      outputPath: "/tmp/shot.png",
    });
  });

  test("linux: refuses rather than guessing a screenshot tool", () => {
    const r = captureCommand({ platform: "linux" });
    assert.equal(r.ok, false);
    assert.match(r.error, /Linux/);
    // Names the plausible candidates so a human can decide, without picking one.
    assert.match(r.error, /scrot|gnome-screenshot|grim|import/);
  });
});

describe("screenSizeCommand / parseScreenSize", () => {
  test("win32 round trip", () => {
    const cmd = screenSizeCommand({ platform: "win32" });
    assert.equal(cmd.ok, true);
    assert.equal(cmd.command, "powershell.exe");
    const parsed = parseScreenSize("1920x1080", { platform: "win32" });
    assert.deepEqual(parsed, { ok: true, width: 1920, height: 1080 });
  });

  test("darwin round trip", () => {
    const cmd = screenSizeCommand({ platform: "darwin" });
    assert.equal(cmd.ok, true);
    assert.equal(cmd.command, "osascript");
    const parsed = parseScreenSize("0, 0, 2560, 1440", { platform: "darwin" });
    assert.deepEqual(parsed, { ok: true, width: 2560, height: 1440 });
  });

  test("garbage output is refused, not guessed", () => {
    const parsed = parseScreenSize("not a size", { platform: "win32" });
    assert.equal(parsed.ok, false);
  });
});

describe("clickCommand", () => {
  test("win32: SetCursorPos + mouse_event with the right flags per button", () => {
    const left = clickCommand({ x: 100, y: 200, button: "left" }, { platform: "win32" });
    assert.equal(left.ok, true);
    assert.equal(left.command, "powershell.exe");
    assert.match(left.args.join(" "), /SetCursorPos\(100,200\)/);
    assert.match(left.args.join(" "), /mouse_event\(2,0,0,0/); // MOUSEEVENTF_LEFTDOWN
    assert.match(left.args.join(" "), /mouse_event\(4,0,0,0/); // MOUSEEVENTF_LEFTUP

    const right = clickCommand({ x: 5, y: 6, button: "right" }, { platform: "win32" });
    assert.match(right.args.join(" "), /mouse_event\(8,0,0,0/); // RIGHTDOWN
    assert.match(right.args.join(" "), /mouse_event\(16,0,0,0/); // RIGHTUP
  });

  test("darwin: left click via System Events", () => {
    const r = clickCommand({ x: 10, y: 20 }, { platform: "darwin" });
    assert.equal(r.ok, true);
    assert.equal(r.command, "osascript");
    assert.deepEqual(r.args, ["-e", "tell application \"System Events\" to click at {10, 20}"]);
  });

  test("darwin: right/middle click refused, not faked", () => {
    const r = clickCommand({ x: 1, y: 1, button: "right" }, { platform: "darwin" });
    assert.equal(r.ok, false);
    assert.match(r.error, /left/);
  });

  test("REFUSED rather than escaped: non-integer / out-of-range coordinates", () => {
    for (const bad of [{ x: "100; rm -rf /", y: 1 }, { x: NaN, y: 1 }, { x: 1.5, y: 1 }, { x: 1e9, y: 1 }]) {
      const r = clickCommand(bad, { platform: "win32" });
      assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(bad)}`);
    }
  });

  test("REFUSED rather than guessed: unknown button", () => {
    const r = clickCommand({ x: 1, y: 1, button: "scroll" }, { platform: "win32" });
    assert.equal(r.ok, false);
  });
});

describe("typeCommand", () => {
  test("win32: SendKeys metacharacters are escaped, not sent literally", () => {
    // This is the exact scenario the task calls out: a model asking to type
    // "%{F4}" must type those five characters, not close a window.
    const r = typeCommand({ text: "%{F4}" }, { platform: "win32" });
    assert.equal(r.ok, true);
    const script = r.args.join(" ");
    // Each metacharacter comes back wrapped in its own braces.
    assert.match(script, /\{%\}\{\{\}F4\{\}\}/);
    // And the raw, unescaped chord must not appear.
    assert.doesNotMatch(script, /SendWait\('%\{F4\}'\)/);
  });

  test("win32: full metacharacter set +^%~(){} all get escaped", () => {
    const r = typeCommand({ text: "+^%~(){}" }, { platform: "win32" });
    const script = r.args.join(" ");
    for (const c of ["+", "^", "%", "~", "(", ")"]) {
      assert.match(script, new RegExp(`\\{\\${c}\\}`), `expected ${c} escaped`);
    }
    assert.match(script, /\{\{\}/); // "{" -> "{{}"
    assert.match(script, /\{\}\}/); // "}" -> "{}}"
  });

  test("win32: embedded single quote is escaped for the PowerShell literal", () => {
    const r = typeCommand({ text: "it's fine" }, { platform: "win32" });
    assert.match(r.args.join(" "), /it''s fine/);
  });

  test("darwin: quotes and backslashes are escaped for the AppleScript literal", () => {
    const r = typeCommand({ text: 'say "hi" \\ done' }, { platform: "darwin" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.args, ["-e", 'tell application "System Events" to keystroke "say \\"hi\\" \\\\ done"']);
  });

  test("REFUSED rather than escaped: control characters", () => {
    for (const bad of ["\u0007", "line one\nline two", "\u0000"]) {
      const r = typeCommand({ text: bad }, { platform: "win32" });
      assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(bad)}`);
    }
  });
});

describe("keyCommand", () => {
  test("win32: named key maps to its SendKeys token", () => {
    const r = keyCommand({ key: "enter" }, { platform: "win32" });
    assert.equal(r.ok, true);
    assert.match(r.args.join(" "), /\{ENTER\}/);
  });

  test("win32: modifier combo builds a SendKeys chord", () => {
    const r = keyCommand({ key: "ctrl+shift+t" }, { platform: "win32" });
    assert.equal(r.ok, true);
    assert.match(r.args.join(" "), /\^\+\(t\)/);
  });

  test("win32: the Windows key is refused, not silently dropped", () => {
    const r = keyCommand({ key: "win+r" }, { platform: "win32" });
    assert.equal(r.ok, false);
    assert.match(r.error, /modifier/);
  });

  test("win32: unrecognized key name is refused", () => {
    const r = keyCommand({ key: "banana" }, { platform: "win32" });
    assert.equal(r.ok, false);
  });

  test("darwin: named key maps to a key code", () => {
    const r = keyCommand({ key: "escape" }, { platform: "darwin" });
    assert.equal(r.ok, true);
    assert.match(r.args.join(" "), /key code 53/);
  });

  test("darwin: modifier combo uses System Events 'using' clause", () => {
    const r = keyCommand({ key: "cmd+c" }, { platform: "darwin" });
    assert.equal(r.ok, true);
    assert.match(r.args.join(" "), /using \{command down\}/);
    assert.match(r.args.join(" "), /keystroke "c"/);
  });
});

// ---------------------------------------------------------------------------
// zevet-mcp.js — driven as a real child process over a real pipe
// ---------------------------------------------------------------------------

/** Spawn the MCP server and hand back send()/next() helpers plus cleanup. */
function mcpClient(t, { env = {} } = {}) {
  const child = spawn(process.execPath, [MCP_PATH], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = [];
  const waiters = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let cut;
    while ((cut = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else pending.push(msg);
    }
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => {
    stderr += c;
  });

  t.after(() => {
    child.kill();
  });

  return {
    child,
    send(msg) {
      child.stdin.write(JSON.stringify(msg) + "\n");
    },
    next(timeoutMs = 10_000) {
      if (pending.length) return Promise.resolve(pending.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no MCP response within ${timeoutMs}ms; stderr: ${stderr}`)), timeoutMs);
        waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
  };
}

describe("zevet-mcp.js over stdio", () => {
  test("initialize returns protocolVersion, capabilities and serverInfo", async (t) => {
    const c = mcpClient(t);
    c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const res = await c.next();
    assert.equal(res.id, 1);
    assert.equal(typeof res.result.protocolVersion, "string");
    assert.ok(res.result.capabilities && typeof res.result.capabilities === "object");
    assert.ok(res.result.capabilities.tools);
    assert.equal(typeof res.result.serverInfo.name, "string");
    assert.equal(typeof res.result.serverInfo.version, "string");
  });

  test("notifications/initialized gets no response", async (t) => {
    const c = mcpClient(t);
    c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    // Follow it with a real request; if the notification had (wrongly) sent
    // a reply, it would arrive first and this assertion would catch it.
    c.send({ jsonrpc: "2.0", id: 99, method: "tools/list" });
    const res = await c.next();
    assert.equal(res.id, 99);
  });

  test("a computer-use run names all six tools, with input schemas", async (t) => {
    // ⚠️ THE LIST DEPENDS ON THE CAPABILITY NOW. This server serves every
    // agent so that any of them can ask a question; only a repo with computer
    // use turned on gets the mouse, and main.js says which by setting
    // ZEVET_MCP_COMPUTER. test/ask-tool.test.mjs owns the other half of this
    // contract — that a plain run gets ask_user and nothing else.
    const c = mcpClient(t, { env: { ZEVET_MCP_COMPUTER: "1" } });
    c.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const res = await c.next();
    const names = res.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["ask_user", "click", "permission_prompt", "press_key", "screenshot", "type_text"]);
    for (const tool of res.result.tools) {
      assert.equal(typeof tool.description, "string");
      assert.equal(tool.inputSchema.type, "object");
    }
  });

  test("tools/call is refused with no permit env configured", async (t) => {
    // ZEVET_MCP_COMPUTER so the tool is on offer at all — the point of this
    // test is the missing GATE, not the missing capability, and without it the
    // refusal would come from the wrong check and prove nothing.
    const env = { ZEVET_MCP_URL: undefined, ZEVET_MCP_TOKEN: undefined, ZEVET_MCP_COMPUTER: "1" };
    const c = mcpClient(t, { env });
    c.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "type_text", arguments: { text: "hello" } },
    });
    const res = await c.next();
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /denied/i);
    assert.match(res.result.content[0].text, /ZEVET_MCP_URL|permission/i);
  });

  test("screenshot is gated the same way as every other tool", async (t) => {
    const c = mcpClient(t, { env: { ZEVET_MCP_URL: undefined, ZEVET_MCP_TOKEN: undefined } });
    c.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "screenshot", arguments: {} } });
    const res = await c.next();
    assert.equal(res.result.isError, true);
  });

  // permission_prompt is what --permission-prompt-tool calls for EVERY tool
  // Claude would otherwise prompt about (Bash, Edit, ...), not just this
  // server's own four. Its reply shape is a strict allow/deny contract Claude
  // Code parses itself (verified against the installed Claude Agent SDK's
  // own bundled zod schema — see the comment in zevet-mcp.js), so these
  // tests assert the exact JSON body, not just isError.
  describe("permission_prompt", () => {
    test("an allow answer from the gate produces the allow shape", async (t) => {
      const gate = await startAskServer({ onPermit: async () => ({ ok: true }) });
      t.after(gate.close);
      const c = mcpClient(t, { env: { ZEVET_MCP_URL: gate.url, ZEVET_MCP_TOKEN: gate.token } });
      c.send({
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: {
          name: "permission_prompt",
          arguments: { tool_name: "Bash", input: { command: "ls" }, tool_use_id: "abc123" },
        },
      });
      const res = await c.next();
      // Must read as a decision, never as a tool error.
      assert.notEqual(res.result.isError, true);
      assert.equal(res.result.content.length, 1);
      assert.equal(res.result.content[0].type, "text");
      const decision = JSON.parse(res.result.content[0].text);
      assert.deepEqual(decision, { behavior: "allow", updatedInput: { command: "ls" } });
    });

    test("a deny answer from the gate produces the deny shape with the reason", async (t) => {
      const gate = await startAskServer({ onPermit: async () => ({ ok: false, reason: "not right now" }) });
      t.after(gate.close);
      const c = mcpClient(t, { env: { ZEVET_MCP_URL: gate.url, ZEVET_MCP_TOKEN: gate.token } });
      c.send({
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: { name: "permission_prompt", arguments: { tool_name: "Edit", input: { file_path: "x.txt" } } },
      });
      const res = await c.next();
      const decision = JSON.parse(res.result.content[0].text);
      assert.equal(decision.behavior, "deny");
      assert.match(decision.message, /not right now/);
    });

    test("no permit env produces a well-formed deny, not a tool error", async (t) => {
      const c = mcpClient(t, { env: { ZEVET_MCP_URL: undefined, ZEVET_MCP_TOKEN: undefined } });
      c.send({
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: { name: "permission_prompt", arguments: { tool_name: "Bash", input: { command: "rm -rf /" } } },
      });
      const res = await c.next();
      // The whole point: a claude reading this must see a decision, not a
      // broken tool. isError must not be set.
      assert.notEqual(res.result.isError, true);
      const decision = JSON.parse(res.result.content[0].text);
      assert.equal(decision.behavior, "deny");
      assert.equal(typeof decision.message, "string");
      assert.ok(decision.message.length > 0);
    });
  });
});

// ---------------------------------------------------------------------------
// ask-server.js — the loopback gate itself
// ---------------------------------------------------------------------------

describe("ask-server", () => {
  test("rejects a missing token", async (t) => {
    const { url, close } = await startAskServer({ onPermit: async () => ({ ok: true }) });
    t.after(close);
    const res = await fetch(`${url}/permit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "click", arguments: {} }),
    });
    assert.equal(res.status, 401);
  });

  test("rejects a wrong token", async (t) => {
    const { url, close } = await startAskServer({ onPermit: async () => ({ ok: true }) });
    t.after(close);
    const res = await fetch(`${url}/permit`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer not-the-token" },
      body: JSON.stringify({ tool: "click", arguments: {} }),
    });
    assert.equal(res.status, 401);
  });

  test("accepts the right token and relays onPermit's answer", async (t) => {
    const { url, token, close } = await startAskServer({ onPermit: async (req) => ({ ok: true, tool: req.tool }) });
    t.after(close);
    const res = await fetch(`${url}/permit`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ tool: "click", arguments: { x: 1, y: 2 } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  test("denies on timeout rather than allowing", async (t) => {
    const { url, token, close } = await startAskServer({
      onPermit: () => new Promise(() => {}), // never resolves — simulates nobody answering
      timeoutMs: 50,
    });
    t.after(close);
    const res = await fetch(`${url}/permit`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ tool: "click", arguments: {} }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.reason, /timed out/);
  });
});
