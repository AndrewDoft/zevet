// The agent console, driven by a process that is not an agent.
//
// WHY THERE IS A FAKE HERE AT ALL, given that the rest of this suite makes a
// point of running the real thing (see helpers.mjs — "a hub that only works
// against a fake socket is not evidence about the hub teammates will run").
//
// That principle is about MOCKING THE SUBJECT. It does not apply to the other
// end of a pipe. Running the real `claude` or `codex` here would mean every
// `npm test` needs two vendor logins and spends somebody's money, which buys a
// suite that nobody runs and that therefore proves nothing. And the code under
// test is not the agent — it is the line buffering, the JSON parsing, the
// process-tree kill and the refusal logic, all of which are ours and none of
// which the agent participates in.
//
// So the seam is deliberate, is documented as such in agent-console.js, and is
// used here to drive the cases a real agent would produce only by luck: a JSON
// object split across a chunk boundary, a line that is not JSON at all, a spawn
// that fails synchronously, a stop() called twice.
//
// What the fake CANNOT tell us is whether the flags are right — whether
// `--replay-user-messages` exists, whether codex reads stdin. Those were
// checked against the installed CLIs' own `--help` while this was written, and
// the findings are recorded in agent-console.js at the lines that depend on
// them. A passing run of this file is not evidence about them.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The module under test is CommonJS, because it runs in the Electron main
// process alongside main.js and preload.js, which are CJS. The suite is ESM.
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const console_ = require(path.join(ROOT, "desktop", "agent-console.js"));
const { resolveAgent, startConsole, _internals } = console_;

const IS_WINDOWS = process.platform === "win32";

// ---------------------------------------------------------------------------
// The fake process
// ---------------------------------------------------------------------------

/**
 * A child process that does nothing except let a test push bytes at it.
 *
 * `pid` is undefined on POSIX ON PURPOSE. stop() on POSIX signals the process
 * GROUP — `process.kill(-pid, ...)` — and a made-up pid there is not a harmless
 * placeholder, it is a signal delivered to whichever real process group happens
 * to hold that number on the machine running the suite. A test that can kill
 * the developer's editor is not a test. With no pid, stop() falls through to
 * child.kill(), which is this object, and nothing outside the test is touched.
 *
 * On Windows the kill goes through taskkill, which is spawned through the
 * injected spawn and therefore never actually runs, so a fake pid is safe and
 * lets us assert the exact argument vector.
 */
function fakeChild({ pid = IS_WINDOWS ? 4242 : undefined } = {}) {
  const child = new EventEmitter();
  child.pid = pid;

  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};

  child.writes = [];
  child.stdin = new EventEmitter();
  child.stdin.destroyed = false;
  child.stdin.writableEnded = false;
  child.stdin.write = (s) => {
    child.writes.push(String(s));
    return true;
  };
  child.stdin.end = () => {
    child.stdin.writableEnded = true;
  };

  child.kills = [];
  child.kill = (sig) => {
    child.kills.push(sig === undefined ? "default" : sig);
    return true;
  };

  return child;
}

/** A spawn that hands back `child` for the agent and a stub for taskkill. */
function fakeSpawn(child) {
  const calls = [];
  const fn = (command, args, options) => {
    calls.push({ command, args, options });
    if (String(command).toLowerCase().startsWith("taskkill")) {
      const killer = new EventEmitter();
      killer.pid = 999;
      return killer;
    }
    return child;
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// A planted binary, so resolveAgent has something deterministic to find
// ---------------------------------------------------------------------------

/**
 * Point PATH (and the home directory resolveAgent also searches) at temporary
 * directories, optionally containing a file named like an agent.
 *
 * This exercises the REAL search rather than stubbing it out, and it makes the
 * result independent of whether the machine running the suite has any agent
 * installed — which matters, because CI does not.
 *
 * Nothing planted here is ever executed: every test that gets as far as
 * spawning injects a fake spawn. The files are zero bytes.
 */
function plantAgent(t, { exe = false, shim = false, name = "claude" } = {}) {
  const binDir = mkdtempSync(path.join(tmpdir(), "zevet-bin-"));
  const homeDir = mkdtempSync(path.join(tmpdir(), "zevet-home-"));

  if (exe) writeFileSync(path.join(binDir, IS_WINDOWS ? `${name}.exe` : name), "");
  if (shim) writeFileSync(path.join(binDir, `${name}.cmd`), "");
  if (!IS_WINDOWS && exe) chmodSync(path.join(binDir, name), 0o755);

  const saved = {
    PATH: process.env.PATH,
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
  };

  process.env.PATH = binDir;
  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere. Both are
  // redirected so that the REAL ~/.local/bin/claude.exe on a developer's
  // machine cannot satisfy a test that is supposed to find nothing.
  process.env.USERPROFILE = homeDir;
  process.env.HOME = homeDir;
  process.env.LOCALAPPDATA = homeDir;

  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(binDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  return { binDir, homeDir };
}

/** Start a console against a planted binary and a fake process. */
function start(t, { agent = "claude", child = fakeChild(), spawn = null } = {}) {
  plantAgent(t, { exe: true, name: agent });
  const events = [];
  const spawnFn = spawn || fakeSpawn(child);
  const handle = startConsole({
    agent,
    cwd: process.cwd(),
    onEvent: (e) => events.push(e),
    spawn: spawnFn,
  });
  return { handle, events, child, spawnFn };
}

// ---------------------------------------------------------------------------

describe("resolveAgent", () => {
  test("refuses a name it does not know, and says so rather than throwing", () => {
    const r = resolveAgent("definitely-not-an-agent");
    assert.equal(r.ok, false);
    assert.match(r.error, /definitely-not-an-agent/);
    // The error must name the alternatives — "unknown agent" alone leaves the
    // user with nothing to do next.
    assert.match(r.error, /claude/);
    assert.match(r.error, /codex/);
  });

  test("survives being handed something that is not a string", () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      const r = resolveAgent(bad);
      assert.equal(r.ok, false, `expected ok:false for ${JSON.stringify(bad)}`);
      assert.equal(typeof r.error, "string");
    }
  });

  test("finds a directly executable binary on PATH", (t) => {
    const { binDir } = plantAgent(t, { exe: true });
    const r = resolveAgent("claude");
    assert.equal(r.ok, true);
    assert.equal(r.kind, "direct");
    assert.equal(path.dirname(r.file), binDir);
  });

  test("reports a clear miss when the agent is nowhere", (t) => {
    plantAgent(t, { exe: false, shim: false });
    const r = resolveAgent("claude");
    assert.equal(r.ok, false);
    assert.match(r.error, /Could not find claude/);
    // Actionable, not just negative.
    assert.match(r.error, /PATH/);
  });

  test("prefers a real executable over a .cmd shim in the same directory", (t) => {
    if (!IS_WINDOWS) {
      t.skip("shims are a Windows-only concept; SHIM_EXTS is empty off win32");
      return;
    }
    plantAgent(t, { exe: true, shim: true });
    const r = resolveAgent("claude");
    assert.equal(r.ok, true);
    // This is the whole point of the two-pass search: the shell path is more
    // dangerous, so a shim must never win while a direct binary exists.
    assert.equal(r.kind, "direct");
    assert.match(r.file, /\.exe$/);
  });

  test("falls back to a .cmd shim when that is all there is", (t) => {
    if (!IS_WINDOWS) {
      t.skip("shims are a Windows-only concept; SHIM_EXTS is empty off win32");
      return;
    }
    plantAgent(t, { exe: false, shim: true });
    const r = resolveAgent("claude");
    assert.equal(r.ok, true);
    assert.equal(r.kind, "shim");
    assert.match(r.file, /\.cmd$/);
  });

  test("finds the real claude, if this machine has one", (t) => {
    // Deliberately NOT plantAgent: this is the one case that reads the actual
    // environment. It is skipped loudly rather than passed vacuously, because
    // "resolveAgent returned ok:false and we asserted nothing" is not evidence
    // that resolution works — it is evidence that it was never tried.
    const r = resolveAgent("claude");
    if (!r.ok) {
      t.skip(`claude is not installed on this machine, so real resolution is untested here: ${r.error}`);
      return;
    }
    assert.equal(r.ok, true);
    // A native install is an .exe. If this ever comes back "shim", the machine
    // has an npm-only install and the cmd.exe path is the one being used in
    // anger — worth knowing, and worth failing over until someone looks.
    assert.equal(r.kind, "direct", `expected a direct executable, got ${r.kind} at ${r.file}`);
    assert.equal(typeof r.file, "string");
  });
});

describe("startConsole — reading the stream", () => {
  test("reassembles JSON objects split across chunk boundaries", (t) => {
    const { handle, events, child } = start(t);
    assert.equal(handle.ok, true, handle.error);

    // The defect this guards: parsing per-chunk instead of per-line. A pipe
    // splits wherever the kernel buffer happened to end, so the second object
    // arrives in two pieces with the break INSIDE a JSON token.
    child.stdout.emit("data", '{"a":1}\n{"b":');
    child.stdout.emit("data", "2}\n");

    const agentEvents = events.filter((e) => e.type === "agent");
    assert.equal(agentEvents.length, 2, `expected 2 agent events, got ${JSON.stringify(events)}`);
    assert.deepEqual(agentEvents[0].payload, { a: 1 });
    assert.deepEqual(agentEvents[1].payload, { b: 2 });
    // And nothing was misfiled as unparseable along the way.
    assert.equal(events.filter((e) => e.type === "stdout-line").length, 0);
  });

  test("holds a partial line until its newline arrives", (t) => {
    const { handle, events, child } = start(t);
    assert.equal(handle.ok, true, handle.error);

    child.stdout.emit("data", '{"half":');
    assert.equal(events.length, 0, "emitted an event for a line that had not ended");

    child.stdout.emit("data", 'true}\n');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { type: "agent", payload: { half: true } });
  });

  test("a line that is not JSON becomes stdout-line, and does not throw", (t) => {
    const { handle, events, child } = start(t);
    assert.equal(handle.ok, true, handle.error);

    // Both CLIs print things like this in the wild: update notices, auth
    // prompts, and the occasional stack trace.
    child.stdout.emit("data", "Claude Code v2.1.0\n");
    child.stdout.emit("data", '{"ok":true}\n');
    child.stdout.emit("data", "{not json at all\n");

    assert.deepEqual(
      events.map((e) => e.type),
      ["stdout-line", "agent", "stdout-line"],
    );
    assert.equal(events[0].line, "Claude Code v2.1.0");
    assert.equal(events[2].line, "{not json at all");
  });

  test("a bare JSON scalar is a line, not an agent event", (t) => {
    const { handle, events, child } = start(t);
    assert.equal(handle.ok, true, handle.error);

    // `null`, `7` and `"hi"` all parse. None of them is an event object, and
    // handing the UI a `null` payload to render is how you get a crash three
    // layers away from the cause.
    child.stdout.emit("data", 'null\n7\n"hi"\n');

    assert.deepEqual(
      events.map((e) => e.type),
      ["stdout-line", "stdout-line", "stdout-line"],
    );
  });

  test("strips CRLF rather than leaving a stray carriage return on the line", (t) => {
    const { handle, events, child } = start(t);
    assert.equal(handle.ok, true, handle.error);
    child.stdout.emit("data", "plain text\r\n");
    assert.equal(events[0].type, "stdout-line");
    assert.equal(events[0].line, "plain text");
  });

  test("stderr is passed through raw, not line-split or parsed", (t) => {
    const { handle, events, child } = start(t);
    assert.equal(handle.ok, true, handle.error);

    // Progress bars and ANSI do not survive being cut at newlines, so stderr
    // is deliberately not buffered.
    child.stderr.emit("data", "warning: partial");
    child.stderr.emit("data", " line\n");

    const errs = events.filter((e) => e.type === "stderr");
    assert.equal(errs.length, 2);
    assert.equal(errs[0].text, "warning: partial");
    assert.equal(errs[1].text, " line\n");
  });

  test("flushes a trailing unterminated line when the process dies", (t) => {
    const { handle, events, child } = start(t);
    assert.equal(handle.ok, true, handle.error);

    // A process killed mid-write still said something, and dropping it loses
    // exactly the output most likely to explain why it died.
    child.stdout.emit("data", "died mid-sentence");
    child.emit("exit", 1, null);

    assert.deepEqual(events[0], { type: "stdout-line", line: "died mid-sentence" });
    assert.equal(events[1].type, "exit");
    assert.equal(events[1].code, 1);
  });

  test("emits exit exactly once even if the process reports twice", (t) => {
    const { handle, events, child } = start(t);
    assert.equal(handle.ok, true, handle.error);

    child.emit("exit", 0, null);
    child.emit("exit", 0, null);
    child.emit("error", new Error("late failure"));

    assert.equal(events.filter((e) => e.type === "exit").length, 1);
  });
});

describe("startConsole — sending", () => {
  test("a claude prompt is one JSON line, with the newline that makes it arrive", (t) => {
    const { handle, child } = start(t, { agent: "claude" });
    assert.equal(handle.ok, true, handle.error);

    const sent = handle.send("hello there");
    assert.equal(sent.ok, true, sent.error);
    assert.equal(child.writes.length, 1);

    const raw = child.writes[0];
    // THE NEWLINE. Without it the CLI holds the prompt in its line buffer and
    // the agent looks hung rather than failed.
    assert.ok(raw.endsWith("\n"), `prompt was written without a trailing newline: ${JSON.stringify(raw)}`);

    const parsed = JSON.parse(raw);
    assert.equal(parsed.type, "user");
    // "role" is the message's role, and the only valid value here is "user".
    assert.equal(parsed.message.role, "user");
    assert.deepEqual(parsed.message.content, [{ type: "text", text: "hello there" }]);
  });

  test("a prompt with quotes, newlines and shell metacharacters survives intact", (t) => {
    const { handle, child, spawnFn } = start(t, { agent: "claude" });
    assert.equal(handle.ok, true, handle.error);

    const nasty = 'rm -rf / & echo "pwned" | cat <<EOF\n%PATH%\n';
    handle.send(nasty);

    // It goes through JSON, so it round-trips byte for byte...
    assert.equal(JSON.parse(child.writes[0]).message.content[0].text, nasty);

    // ...and, the part that actually matters, NONE of it reached argv. This is
    // the invariant the whole cmd.exe guard rail exists to protect: if a prompt
    // can never be an argument, the shell-quoting question never has to be
    // answered correctly for untrusted text.
    const argv = spawnFn.calls[0].args;
    for (const arg of argv) {
      assert.ok(!arg.includes("pwned"), `prompt text leaked onto argv: ${arg}`);
      assert.ok(!arg.includes("rm -rf"), `prompt text leaked onto argv: ${arg}`);
    }
  });

  test("refuses an empty prompt instead of writing a blank line", (t) => {
    const { handle, child } = start(t);
    assert.equal(handle.ok, true, handle.error);
    assert.equal(handle.send("").ok, false);
    assert.equal(handle.send(null).ok, false);
    assert.equal(child.writes.length, 0);
  });

  test("refuses to send to a process that has already exited", (t) => {
    const { handle, child } = start(t);
    assert.equal(handle.ok, true, handle.error);
    child.emit("exit", 0, null);

    const sent = handle.send("too late");
    assert.equal(sent.ok, false);
    assert.match(sent.error, /exited/);
    assert.equal(child.writes.length, 0);
  });

  test("codex gets the prompt as plain text and then EOF, because it is one-shot", (t) => {
    const { handle, child } = start(t, { agent: "codex" });
    assert.equal(handle.ok, true, handle.error);

    const sent = handle.send("summarise this repo");
    assert.equal(sent.ok, true, sent.error);
    assert.equal(child.writes[0], "summarise this repo\n");

    // MEASURED while writing this: `codex exec ... -` emits nothing at all
    // while stdin stays open, because `-` means the prompt IS stdin and it is
    // read to EOF. So the end() is not tidiness — without it the turn is never
    // submitted.
    assert.equal(child.stdin.writableEnded, true, "codex stdin was left open, so its prompt is never submitted");

    // And the second prompt is honestly refused rather than silently swallowed.
    const again = handle.send("and again");
    assert.equal(again.ok, false);
    assert.match(again.error, /one prompt per run/);
    assert.equal(child.writes.length, 1);
  });

  test("opencode gets the prompt as plain text and then EOF, because it is one-shot too", (t) => {
    const { handle, child, spawnFn } = start(t, { agent: "opencode" });
    assert.equal(handle.ok, true, handle.error);

    const sent = handle.send("summarise this repo");
    assert.equal(sent.ok, true, sent.error);
    assert.equal(child.writes[0], "summarise this repo\n");

    // MEASURED 2026-09-19: `opencode run --format json` with no message
    // argument holds stdin open and prints nothing until EOF, then runs and
    // exits 0. Same one-shot shape as codex, same end() requirement.
    assert.equal(child.stdin.writableEnded, true, "opencode stdin was left open, so its prompt is never submitted");

    const again = handle.send("and again");
    assert.equal(again.ok, false);
    assert.match(again.error, /one prompt per run/);
    assert.equal(child.writes.length, 1);

    // The prompt never reaches argv either — the invocation carries no message
    // argument at all, which is what makes the shim-shell check trivially safe.
    const argv = spawnFn.calls[0].args;
    for (const arg of argv) {
      assert.ok(!arg.includes("summarise"), `prompt text leaked onto argv: ${arg}`);
    }
  });

  test("an opencode console parses step lines into agent events", (t) => {
    const { handle, events, child } = start(t, { agent: "opencode" });
    assert.equal(handle.ok, true, handle.error);
    handle.send("hi");

    child.stdout.emit(
      "data",
      '{"type":"text","timestamp":1,"sessionID":"s","part":{"type":"text","text":"ok"}}\n' +
        '{"type":"step_finish","timestamp":2,"sessionID":"s","part":{"reason":"stop","tokens":{"input":10,"output":2},"cost":0}}\n',
    );
    const agentEvents = events.filter((e) => e.type === "agent");
    assert.equal(agentEvents.length, 2);
    assert.equal(agentEvents[0].payload.part.text, "ok");
    assert.equal(agentEvents[1].payload.part.tokens.input, 10);
  });
});

describe("startConsole — stopping", () => {
  test("stop() is safe to call twice", (t) => {
    const { handle, spawnFn, child } = start(t);
    assert.equal(handle.ok, true, handle.error);

    const first = handle.stop();
    assert.equal(first.ok, true, first.error);

    // The UI calls stop() from a button, from window close and from app quit,
    // and those overlap routinely. The second call must be a no-op — not a
    // throw, and emphatically not a second kill against a pid that by then may
    // belong to somebody else.
    const second = handle.stop();
    assert.equal(second.ok, true);
    assert.equal(second.alreadyStopped, true);

    if (IS_WINDOWS) {
      const kills = spawnFn.calls.filter((c) => c.command === "taskkill");
      assert.equal(kills.length, 1, "stopped twice, killed twice");
    } else {
      assert.equal(child.kills.length, 1, "stopped twice, killed twice");
    }
  });

  test("kills the whole tree, not just the process we started", (t) => {
    if (!IS_WINDOWS) {
      t.skip("the tree kill is taskkill /T on Windows; on POSIX it is a process-group signal, which this fake deliberately cannot exercise safely");
      return;
    }
    const { handle, spawnFn } = start(t, { child: fakeChild({ pid: 4242 }) });
    assert.equal(handle.ok, true, handle.error);
    handle.stop();

    const kill = spawnFn.calls.find((c) => c.command === "taskkill");
    assert.ok(kill, "stop() did not reach taskkill");
    // /T is the tree; without it the agent's children — its builds, its test
    // runs — are reparented and keep going with nothing reading their output.
    // /F because a console app mid-syscall will not otherwise go.
    assert.deepEqual(kill.args, ["/pid", "4242", "/T", "/F"]);
  });

  test("stop() after the process already exited does not kill anything", (t) => {
    const { handle, spawnFn, child } = start(t);
    assert.equal(handle.ok, true, handle.error);
    child.emit("exit", 0, null);

    const r = handle.stop();
    assert.equal(r.ok, true);
    assert.equal(r.alreadyStopped, true);
    assert.equal(spawnFn.calls.filter((c) => c.command === "taskkill").length, 0);
    assert.equal(child.kills.length, 0);
  });
});

describe("startConsole — failing to start", () => {
  test("a spawn that throws synchronously returns ok:false instead of exploding", (t) => {
    plantAgent(t, { exe: true });

    // THIS IS THE REAL WINDOWS FAILURE, not a hypothetical. Measured on Node
    // v24.17.0 / Windows 11: spawning a .cmd with shell:false throws this
    // synchronously — it does NOT emit an 'error' event. In the Electron main
    // process an uncaught throw here takes the window with it.
    const einval = Object.assign(new Error("spawn EINVAL"), {
      errno: -4071,
      code: "EINVAL",
      syscall: "spawn",
    });
    const throwingSpawn = () => {
      throw einval;
    };

    let result;
    assert.doesNotThrow(() => {
      result = startConsole({ agent: "claude", onEvent: () => {}, spawn: throwingSpawn });
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /EINVAL/);
  });

  test("a spawn that emits 'error' later becomes an exit event, not an uncaught throw", (t) => {
    const child = fakeChild();
    const { handle, events } = start(t, { child });
    assert.equal(handle.ok, true, handle.error);

    // An EventEmitter with no 'error' listener rethrows. If startConsole did
    // not attach one, this line would kill the test process outright — which
    // is precisely what it would do to the Electron main process.
    assert.doesNotThrow(() => child.emit("error", new Error("ENOENT: vanished mid-spawn")));

    const exit = events.find((e) => e.type === "exit");
    assert.ok(exit, `expected an exit event, got ${JSON.stringify(events)}`);
    assert.match(exit.error, /vanished mid-spawn/);
    assert.equal(exit.code, null);
  });

  test("an unresolvable agent never reaches spawn at all", (t) => {
    plantAgent(t, { exe: false });
    let spawned = false;
    const r = startConsole({
      agent: "claude",
      onEvent: () => {},
      spawn: () => {
        spawned = true;
        return fakeChild();
      },
    });
    assert.equal(r.ok, false);
    assert.equal(spawned, false, "tried to spawn an agent it had not found");
  });

  test("an unknown agent name is refused, not spawned", () => {
    const r = startConsole({ agent: "hal9000", onEvent: () => {}, spawn: () => fakeChild() });
    assert.equal(r.ok, false);
    assert.match(r.error, /hal9000/);
  });

  test("a spawn that returns nothing is reported, not dereferenced", (t) => {
    plantAgent(t, { exe: true });
    const r = startConsole({ agent: "claude", onEvent: () => {}, spawn: () => null });
    assert.equal(r.ok, false);
    assert.match(r.error, /spawn returned nothing/);
  });
});

describe("the platform workarounds themselves", () => {
  test("the cmd.exe line uses the doubled-quote form and asks for verbatim args", () => {
    const { buildShimInvocation } = _internals;
    const inv = buildShimInvocation("C:\\path with space\\claude.cmd", ["-p", "--verbose"]);

    assert.equal(inv.command, "cmd.exe");
    assert.equal(inv.args[0], "/d");
    assert.equal(inv.args[1], "/s");
    assert.equal(inv.args[2], "/c");

    // MEASURED, Node v24.17.0 / Windows 11, against a real .cmd in a directory
    // with a space in its name:
    //   doubled + verbatim -> exit 0, "GOT:[hello world]"
    //   single  + verbatim -> exit 1, "'C:\...\dir' is not recognized..."
    //   doubled, no verbatim -> exit 1, "The network path was not found."
    // /s strips the OUTERMOST quote pair, so with a single pair the quotes that
    // were protecting the path are the ones that get eaten.
    const line = inv.args[3];
    assert.ok(line.startsWith('""'), `expected a doubled opening quote, got ${line}`);
    assert.ok(line.endsWith('""'), `expected a doubled closing quote, got ${line}`);
    assert.ok(line.includes('"C:\\path with space\\claude.cmd"'), "the executable path lost its quotes");
    assert.ok(line.includes('"-p"'), "an argument lost its quotes");

    // Without this Node re-escapes the line we just built and cmd sees garbage.
    assert.equal(inv.options.windowsVerbatimArguments, true);
  });

  test("shell metacharacters are detected rather than escaped", () => {
    const { unsafeForCmd } = _internals;

    // Each of these changes what cmd.exe RUNS, which is why the answer is to
    // refuse rather than to attempt an escape and hope.
    for (const bad of ['say "hi"', "a & b", "a | b", "a > f", "a < f", "a ^ b", "a\nb", "a\rb", "%PATH%", "!DELAYED!"]) {
      assert.deepEqual(unsafeForCmd([bad]), [bad], `not flagged: ${JSON.stringify(bad)}`);
    }

    // And the things we actually pass are clean, so the guard never fires in
    // normal operation. If this half ever breaks, every shim launch refuses.
    const { invocationFor } = _internals;
    assert.deepEqual(unsafeForCmd(invocationFor("claude")), []);
    assert.deepEqual(unsafeForCmd(invocationFor("codex")), []);
    assert.deepEqual(unsafeForCmd(invocationFor("opencode")), []);
    assert.deepEqual(unsafeForCmd(["C:\\Users\\a b\\AppData\\claude.cmd"]), []);
  });

  test("the headless flags are the ones the CLIs document", () => {
    const { invocationFor } = _internals;

    // Read off `claude --help` in the session that wrote this file. Asserted
    // here so that a future edit has to change the test on purpose.
    const claude = invocationFor("claude");
    for (const flag of [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "--verbose",
      "--include-partial-messages",
      "--replay-user-messages",
    ]) {
      assert.ok(claude.includes(flag), `claude invocation is missing ${flag}`);
    }

    // Read off `codex exec --help` (codex-cli 0.155.0-alpha.2.6). The trailing
    // "-" is the CLI's own documented spelling of "read the prompt from stdin",
    // which is what keeps the prompt off argv.
    const codex = invocationFor("codex");
    assert.deepEqual(codex, ["exec", "--skip-git-repo-check", "--json", "-"]);
    assert.equal(codex[codex.length - 1], "-", "codex must read its prompt from stdin");

    // Read off `opencode run --help` and MEASURED 2026-09-19: no message
    // argument, `--format json` for JSONL, `-m` for the model. The prompt
    // arrives on stdin (see the send tests), so there is deliberately no
    // positional prompt here the way codex has `-`.
    const opencode = invocationFor("opencode");
    assert.deepEqual(opencode, ["run", "--format", "json"]);
    const opencodeModel = invocationFor("opencode", { model: "openrouter/cohere/north-mini-code:free" });
    assert.deepEqual(opencodeModel.slice(0, 5), ["run", "--format", "json", "-m", "openrouter/cohere/north-mini-code:free"]);

    // opencode has no plan mode and no full bypass (`--auto` is the strongest
    // posture `run` offers), so two of the four postures fall back and say so.
    const { modeFlags } = console_;
    assert.deepEqual(modeFlags("opencode", "plan").flags, []);
    assert.ok(modeFlags("opencode", "plan").note, "plan fallback is silent");
    assert.deepEqual(modeFlags("opencode", "auto").flags, ["--auto"]);
    assert.deepEqual(modeFlags("opencode", "dangerous").flags, ["--auto"]);
    assert.ok(modeFlags("opencode", "dangerous").note, "dangerous fallback is silent");
  });

  test("the line splitter keeps a remainder and flushes it on demand", () => {
    const { makeLineSplitter } = _internals;
    const lines = [];
    const s = makeLineSplitter((l) => lines.push(l));

    s.push("one\ntw");
    assert.deepEqual(lines, ["one"]);
    s.push("o\nthree");
    assert.deepEqual(lines, ["one", "two"]);
    s.flush();
    assert.deepEqual(lines, ["one", "two", "three"]);
    // A second flush has nothing left to give.
    s.flush();
    assert.deepEqual(lines, ["one", "two", "three"]);
  });

  test("each console gets its own id", (t) => {
    const a = start(t, { child: fakeChild() });
    const b = start(t, { child: fakeChild() });
    assert.equal(a.handle.ok, true);
    assert.equal(b.handle.ok, true);
    assert.notEqual(a.handle.id, b.handle.id);
  });
});
