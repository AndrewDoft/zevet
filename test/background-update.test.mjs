// Updates while zevet is closed (Andrew, 2026-10-11): the decision, the OS job, the stale-tree sweep and the crash guard.
// The real Electron run of `--background-update` against a throwaway profile is in DECISIONS (D-111); these are the
// parts that must not regress without it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = path.join(ROOT, "desktop");
const require = createRequire(import.meta.url);
const bg = require(path.join(DESKTOP, "background-update.js"));
const sweepLib = require(path.join(DESKTOP, "payload-sweep.js"));
const guardPath = path.join(DESKTOP, "crash-guard.js");
const { installCrashGuard } = require(guardPath);

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "zevet-bg-"));

describe("decide", () => {
  const base = { lockHeld: true, running: "0.2.139", version: "0.2.140", offerable: true, attempt: null, now: 1e12 };
  test("installs a newer, offerable version once the lock is ours", () => {
    assert.deepEqual(bg.decide(base), { install: true, reason: "newer" });
  });
  test("zevet running (no lock), nothing newer, withdrawn, or tried today: no install", () => {
    assert.equal(bg.decide({ ...base, lockHeld: false }).reason, "running");
    assert.equal(bg.decide({ ...base, version: null }).reason, "no-update");
    assert.equal(bg.decide({ ...base, version: "0.2.139" }).reason, "not-newer");
    assert.equal(bg.decide({ ...base, offerable: false }).reason, "withdrawn");
    assert.equal(bg.decide({ ...base, attempt: { version: "0.2.140", at: base.now - 1000 } }).reason, "attempted-today");
    assert.equal(bg.decide({ ...base, attempt: { version: "0.2.140", at: base.now - bg.ATTEMPT_GAP_MS - 1 } }).install, true);
    assert.equal(bg.decide({ ...base, attempt: { version: "0.2.138", at: base.now } }).install, true);
  });
});

describe("runBackgroundUpdate", () => {
  const harness = (over = {}) => {
    const dir = tmp();
    const lines = [];
    const calls = [];
    const payload = over.payload ?? { check: async () => ({ status: "staged", build: "0.2.150" }), staged: () => ({ build: "0.2.150" }) };
    const updater = over.updater ?? {
      check: async () => ({ phase: "ready", version: "0.2.140" }),
      installQuiet: () => { calls.push("installQuiet"); return { ok: true }; },
    };
    const args = { lockHeld: true, payload, updater, rollback: null, running: "0.2.139", build: "0.2.139", dir, log: (m) => lines.push(m), sweep: async () => { calls.push("sweep"); }, ...over.args };
    return { args, lines, calls, dir, run: () => bg.runBackgroundUpdate(args) };
  };
  const startAndOutcome = (lines) => ({ start: lines.filter((l) => l.startsWith("start:")).length, outcome: lines.filter((l) => l.startsWith("outcome:")).length });

  test("closed: stages the payload, sweeps old trees, runs the installer silently, and logs one start and one outcome line", async () => {
    const h = harness();
    const r = await h.run();
    assert.equal(r.payload, "staged 0.2.150");
    assert.equal(r.shell, "installing 0.2.140");
    assert.deepEqual(h.calls, ["sweep", "installQuiet"]);
    assert.deepEqual(startAndOutcome(h.lines), { start: 1, outcome: 1 });
    assert.match(h.lines.at(-1), /^outcome: payload staged 0\.2\.150; shell installing 0\.2\.140$/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, bg.ATTEMPT_FILE), "utf8")).version, "0.2.140");
  });
  test("one installer attempt per version per day", async () => {
    const h = harness();
    await h.run();
    h.calls.length = 0;
    const again = await h.run();
    assert.equal(again.shell, "0.2.140 skipped: attempted-today");
    assert.equal(h.calls.includes("installQuiet"), false);
  });
  test("zevet running: nothing is touched, and both lines are still logged", async () => {
    const h = harness({ args: { lockHeld: false } });
    const r = await h.run();
    assert.deepEqual(h.calls, []);
    assert.match(r.payload, /zevet is running/);
    assert.deepEqual(startAndOutcome(h.lines), { start: 1, outcome: 1 });
  });
  test("a per-machine install this user cannot write: the installer is never downloaded or run, the payload still stages", async () => {
    let checked = false;
    const h = harness({ args: { canInstall: () => false }, updater: { check: async () => { checked = true; return { phase: "ready", version: "0.2.140" }; }, installQuiet: () => assert.fail("must not run") } });
    const r = await h.run();
    assert.equal(r.payload, "staged 0.2.150");
    assert.match(r.shell, /^needs-elevation/);
    assert.equal(checked, false, "no 150 MB download for an installer that cannot run");
    assert.match(h.lines.at(-1), /^outcome: payload staged/);
  });
  test("a payload check that throws is an outcome, not a silent exit; the installer step still runs", async () => {
    const h = harness({ payload: { check: async () => { throw new Error("pulse host answered 503"); }, staged: () => null } });
    const r = await h.run();
    assert.equal(r.payload, "error: pulse host answered 503");
    assert.equal(r.shell, "installing 0.2.140");
    assert.ok(h.lines.some((l) => l.includes("payload check failed: pulse host answered 503")));
    assert.deepEqual(startAndOutcome(h.lines), { start: 1, outcome: 1 });
  });
  test("an updater that throws, or a sweep that throws, still ends with an outcome line", async () => {
    const h = harness({ updater: { check: async () => { throw new Error("feed down"); } }, args: { sweep: async () => { throw new Error("EPERM"); } } });
    const r = await h.run();
    assert.equal(r.shell, "error: feed down");
    assert.ok(h.lines.some((l) => l.includes("old payload cleanup failed: EPERM")));
    assert.deepEqual(startAndOutcome(h.lines), { start: 1, outcome: 1 });
  });
  test("a person launching zevet mid-run stops the installer", async () => {
    const h = harness({ args: { aborted: () => true } });
    const r = await h.run();
    assert.match(r.shell, /zevet was launched/);
    assert.equal(h.calls.includes("installQuiet"), false);
  });
  test("a failed installer start is reported, not swallowed", async () => {
    const h = harness({ updater: { check: async () => ({ phase: "ready", version: "0.2.140" }), installQuiet: () => ({ ok: false, error: "could not start the install: EACCES" }) } });
    const r = await h.run();
    assert.equal(r.shell, "failed: could not start the install: EACCES");
  });
});

describe("the OS job", () => {
  const exe = "C:\\Users\\a\\AppData\\Local\\Programs\\zevet\\zevet.exe";
  test("the Windows task is per-user, unelevated, hidden, hourly and at logon, and runs the GUI exe with the flag", () => {
    const xml = bg.taskXml({ exe, user: "PC\\a" });
    for (const needle of ["<RunLevel>LeastPrivilege</RunLevel>", "<LogonType>InteractiveToken</LogonType>", "<Hidden>true</Hidden>", "<LogonTrigger>", "<Interval>PT1H</Interval>", "<StartWhenAvailable>true</StartWhenAvailable>", `<Command>${exe}</Command>`, "<Arguments>--background-update</Arguments>"]) {
      assert.ok(xml.includes(needle), needle);
    }
    assert.equal(xml.includes("HighestAvailable"), false);
    assert.equal(bg.taskXml({ exe, user: "PC\\a", logon: false }).includes("LogonTrigger"), false);
  });
  test("a registration is idempotent: the second run only queries", async () => {
    const dir = tmp();
    const calls = [];
    const run = async (cmd, args) => { calls.push(args[0]); return { code: 0 }; };
    const opts = { platform: "win32", exe, user: "PC\\a", dir, run, tmpdir: dir, writeFile: () => {} };
    assert.equal(await bg.ensureBackgroundJob(opts), "registered");
    assert.equal(await bg.ensureBackgroundJob(opts), "unchanged");
    assert.deepEqual(calls, ["/Create", "/Query"]);
  });
  test("when Windows refuses the logon trigger, the hourly task is registered without it", async () => {
    const dir = tmp();
    let n = 0;
    const run = async () => ({ code: n++ === 0 ? 1 : 0 });
    assert.equal(await bg.ensureBackgroundJob({ platform: "win32", exe, user: "PC\\a", dir, run, tmpdir: dir, writeFile: () => {} }), "registered-no-logon");
  });
  test("the launch agent runs the flag hourly and at load", () => {
    const plist = bg.agentPlist({ exe: "/Applications/zevet.app/Contents/MacOS/zevet" });
    assert.ok(plist.includes("<string>--background-update</string>") && plist.includes("<key>RunAtLoad</key>") && plist.includes("<integer>3600</integer>"));
  });
  test("only a real packaged install registers: not a dev run, a throwaway profile, CI or a misplaced copy", () => {
    const ok = { isPackaged: true, execPath: exe, env: {}, misplaced: () => null };
    assert.equal(bg.mayRegister(ok), true);
    assert.equal(bg.mayRegister({ ...ok, isPackaged: false }), false);
    assert.equal(bg.mayRegister({ ...ok, env: { ZEVET_PAYLOAD_ROOT: "C:\\t" } }), false);
    assert.equal(bg.mayRegister({ ...ok, env: { ZEVET_ALLOW_MULTI: "1" } }), false);
    assert.equal(bg.mayRegister({ ...ok, env: { CI: "true" } }), false);
    assert.equal(bg.mayRegister({ ...ok, misplaced: () => "inside node_modules" }), false);
  });
  test("installDirWritable probes by writing, and cleans up", () => {
    const dir = tmp();
    assert.equal(bg.installDirWritable(dir), true);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(bg.installDirWritable(path.join(dir, "missing")), false);
  });
});

describe("sweeping old payload trees", () => {
  const rootWith = (names, { current = "0.2.142", previous = "0.2.128", staged } = {}) => {
    const root = tmp();
    for (const n of names) { fs.mkdirSync(path.join(root, "versions", n), { recursive: true }); fs.writeFileSync(path.join(root, "versions", n, ".complete"), ""); }
    fs.writeFileSync(path.join(root, "current.json"), JSON.stringify({ build: current, previous: { build: previous } }));
    if (staged) fs.writeFileSync(path.join(root, "staged.json"), JSON.stringify({ build: staged }));
    return root;
  };

  test("one tree Windows will not release no longer strands the others, and the log names what holds it", async () => {
    const root = rootWith(["0.2.121", "0.2.122", "0.2.123", "0.2.128", "0.2.142"]);
    const real = fs.rmSync;
    const fsImpl = { readdirSync: fs.readdirSync, rmSync: (p, o) => { if (p.endsWith("0.2.121")) throw Object.assign(new Error("EPERM, Permission denied"), { code: "EPERM" }); return real(p, o); } };
    const r = await sweepLib.sweepOldVersions({ root, fsImpl, holders: async () => ["4242 claude.exe"] });
    assert.deepEqual(fs.readdirSync(path.join(root, "versions")).sort(), ["0.2.121", "0.2.128", "0.2.142"]);
    assert.deepEqual(r.removed.sort(), ["0.2.122", "0.2.123"]);
    assert.deepEqual(r.held, [{ name: "0.2.121", code: "EPERM", holders: ["4242 claude.exe"] }]);
    assert.match(sweepLib.describeSweep(r), /0\.2\.121 held \(EPERM\) by 4242 claude\.exe/);
  });
  test("current, previous and staged are kept by name, never by age; stray .tmp- trees go", async () => {
    const root = rootWith(["0.2.100", "0.2.128", "0.2.142", "0.2.143", "0.2.144.tmp-9"], { staged: "0.2.143" });
    const r = await sweepLib.sweepOldVersions({ root });
    assert.deepEqual(fs.readdirSync(path.join(root, "versions")).sort(), ["0.2.128", "0.2.142", "0.2.143"]);
    assert.deepEqual(r.held, []);
  });
  test("a held tree is retried on a timer until clean, then it stops", async () => {
    const results = [{ removed: [], held: [{ name: "0.2.121", code: "EPERM", holders: [] }] }, { removed: ["0.2.121"], held: [] }];
    const timers = [];
    const lines = [];
    let n = 0;
    await sweepLib.sweepUntilClean({ root: "x", log: (m) => lines.push(m), sweep: async () => results[n++], setTimeoutImpl: (fn) => { timers.push(fn); return {}; } });
    assert.equal(timers.length, 1);
    await timers.pop()();
    assert.equal(timers.length, 0);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /held \(EPERM\)/);
    assert.match(lines[1], /removed 0\.2\.121/);
  });
});

describe("the main-process crash guard", () => {
  test("uncaught exceptions, rejections and a closed stdout pipe go to the log and nothing else", () => {
    const handlers = {};
    const proc = { on: (e, f) => { handlers[e] = f; }, removeListener() {} };
    const stream = { on: (e, f) => { handlers.stream = f; }, removeListener() {} };
    const lines = [];
    installCrashGuard({ proc, streams: [stream], log: (m) => lines.push(m) });
    handlers.uncaughtException(new Error("boom"));
    handlers.unhandledRejection(new Error("nope"));
    handlers.stream(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    handlers.stream(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    assert.equal(lines.filter((l) => l.startsWith("uncaughtException: Error: boom")).length, 1);
    assert.equal(lines.filter((l) => l.startsWith("unhandledRejection: Error: nope")).length, 1);
    assert.equal(lines.filter((l) => l.includes("stdio pipe closed")).length, 1, "a closed pipe is noted once, not per console call");
  });

  // The Masora failure, for real: the parent closes the child's stdout/stderr, the child keeps writing to them (a direct stream write raises the error as an event; console.* swallows it).
  const survives = (withGuard) => new Promise((resolve) => {
    const dir = tmp();
    const marker = path.join(dir, "survived");
    const script = `
      ${withGuard ? `require(${JSON.stringify(guardPath)}).installCrashGuard({ log() {} });` : ""}
      process.stdout.write("ready\\n");
      setTimeout(() => {
        for (let i = 0; i < 50; i++) { console.error("x".repeat(4096)); process.stderr.write("y".repeat(4096)); }
        process.stdout.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        setTimeout(() => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1"); process.exit(0); }, 300);
      }, 500);`;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout.once("data", () => { child.stdout.destroy(); child.stderr.destroy(); });
    child.on("exit", () => resolve(fs.existsSync(marker)));
  });
  test("a child whose stdout pipe closed keeps running with the guard", async () => {
    assert.equal(await survives(true), true);
  });
  test("and dies of write EPIPE without it (the control: the test can fail)", async () => {
    assert.equal(await survives(false), false);
  });
});
