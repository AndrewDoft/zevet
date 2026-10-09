// Masora agent runs on the desktop (desktop/masora-runs.js, spec 06 contract C5).
// Masora's T9 endpoints do not exist yet: the server here is a local fake that
// implements the spec's wire shapes, and lives in this file only.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { tempDir, ROOT } from "./helpers.mjs";

const home = tempDir("zevet-masora-runs-");
process.env.ZEVET_HOME = home.dir;
const require = createRequire(import.meta.url);
const runs = require(path.join(ROOT, "desktop", "masora-runs.js"));

const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
const inFuture = () => Math.floor(Date.now() / 1000) + 3600;

let server;
let base;
let queue; // runs the fake will hand out
let seen; // every request the fake received
before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      if (req.url === "/api/v2/agent-runs/claim") {
        const next = queue.shift();
        if (!next) return res.writeHead(204).end();
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(next));
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const mkRun = (over = {}) => ({
  run_id: "run-1", run_token: jwt(inFuture()), brief: "do the thing", repo_hint: "acme/app",
  allowed_actions: [], deadline: null, ...over,
});

let n = 0;
function rig(over = {}) {
  queue = [];
  seen = [];
  const outcomes = [];
  const started = [];
  const consoleEntry = { running: false, state: "idle", turns: 1, isError: false, lastResult: "all done", events: [] };
  const deps = {
    enabled: () => true,
    credential: () => ({ baseUrl: base, token: "family-credential" }),
    start: async (run) => { started.push(run); return { ok: true, id: "c1" }; },
    getConsole: () => consoleEntry,
    stop: () => {},
    needsYou: () => false,
    summarize: () => ({ sessionId: "sess-1", usage: { input_tokens: 3 }, costUsd: 0.5, elapsedMs: 1234 }),
    resultText: (e) => e.lastResult,
    payer: () => "Claude · andrew@example.com (Max)",
    isRelaunching: () => false,
    setOutcome: (id, text) => outcomes.push([id, text]),
    ledgerFile: path.join(home.dir, `ledger-${++n}.json`),
    sleep: () => new Promise((r) => setImmediate(r)),
    ...over,
  };
  return { poller: new runs.MasoraRunPoller(deps), deps, outcomes, started, consoleEntry };
}

describe("claim and report: the spec's wire shapes", () => {
  test("claim sends device_id with the person credential; 204 is no run", async () => {
    const { poller } = rig();
    assert.equal(await poller.tick(), null);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/api/v2/agent-runs/claim");
    assert.equal(seen[0].auth, "Bearer family-credential");
    assert.deepEqual(Object.keys(seen[0].body), ["device_id"]);
    assert.ok(seen[0].body.device_id);
  });

  test("a claimed run starts with its brief, then reports every C5 field with the run token", async () => {
    const { poller, started, outcomes } = rig();
    const run = mkRun();
    queue.push(run);
    const t = await poller.tick();
    await t.done;
    assert.equal(started.length, 1);
    assert.equal(started[0].brief, "do the thing");
    const report = seen.find((r) => r.url === "/api/v2/agent-runs/run-1/report");
    assert.equal(report.auth, `Bearer ${run.run_token}`);
    assert.deepEqual(report.body, {
      status: "done", session_id: "sess-1", usage: { input_tokens: 3 }, cost_reported: 0.5,
      elapsed_ms: 1234, payer: "Claude · andrew@example.com (Max)", result_text: "all done",
    });
    assert.deepEqual(outcomes, [["c1", "running"], ["c1", "done · reported"]]);
  });

  test("an errored console reports failed; a permission stall reports needs_you", { timeout: 10_000 }, async () => {
    let r = rig();
    r.consoleEntry.isError = true;
    queue.push(mkRun({ run_id: "run-f" }));
    await (await r.poller.tick()).done;
    assert.equal(seen.find((x) => x.url.endsWith("/report")).body.status, "failed");

    let waiting = true;
    r = rig({ needsYou: () => waiting });
    r.consoleEntry.running = true;
    r.consoleEntry.state = "working";
    queue.push(mkRun({ run_id: "run-n" }));
    const t = await r.poller.tick();
    while (!/^needs you/.test(r.outcomes.at(-1)?.[1] ?? "")) await new Promise((res) => setImmediate(res));
    assert.equal(seen.find((x) => x.url.endsWith("/report")).body.status, "needs_you");
    assert.match(r.outcomes.at(-1)[1], /^needs you/);
    waiting = false; // the person answered; the run ends, so the watch ends
    r.consoleEntry.running = false;
    await t.done;
  });

  test("a run that cannot start is reported failed, not dropped", async () => {
    const r = rig({ start: async () => ({ ok: false, error: "no single opened workspace matches" }) });
    queue.push(mkRun({ run_id: "run-x" }));
    await (await r.poller.tick()).done;
    const report = seen.find((x) => x.url.endsWith("/report"));
    assert.equal(report.body.status, "failed");
    assert.match(report.body.result_text, /could not start: no single opened workspace/);
  });

  test("past its deadline a still-working run is stopped and reported failed", async () => {
    const stops = [];
    const r = rig({ stop: (id) => stops.push(id) });
    r.consoleEntry.running = true;
    r.consoleEntry.state = "working";
    queue.push(mkRun({ run_id: "run-d", deadline: new Date(Date.now() - 1000).toISOString() }));
    await (await r.poller.tick()).done;
    assert.deepEqual(stops, ["c1"]);
    assert.equal(seen.find((x) => x.url.endsWith("/report")).body.result_text, "deadline passed");
  });
});

describe("idempotency: a claim never runs twice", () => {
  test("the same run_id handed out again does not start again, even in a new poller", async () => {
    const first = rig();
    queue.push(mkRun({ run_id: "dup" }));
    await (await first.poller.tick()).done;
    assert.equal(first.started.length, 1);

    queue.push(mkRun({ run_id: "dup" }));
    const again = new runs.MasoraRunPoller({ ...first.deps, start: async () => assert.fail("started twice") });
    assert.equal(await again.tick(), null);
  });

  test("only one run at a time: a busy poller does not claim", async () => {
    const r = rig();
    r.consoleEntry.running = true;
    r.consoleEntry.state = "working";
    queue.push(mkRun({ run_id: "a" }), mkRun({ run_id: "b" }));
    const t = await r.poller.tick();
    seen.length = 0;
    try {
      assert.equal(await r.poller.tick(), null);
      assert.equal(seen.length, 0);
    } finally {
      r.consoleEntry.running = false; // release the first run's watch loop
    }
    await t.done;
  });
});

describe("expired run_token is refused", () => {
  test("a token already expired at claim is never used: no start, no report", async () => {
    const r = rig();
    queue.push(mkRun({ run_id: "old", run_token: jwt(Math.floor(Date.now() / 1000) - 10) }));
    assert.equal(await r.poller.tick(), null);
    assert.equal(r.started.length, 0);
    assert.equal(seen.filter((x) => x.url.endsWith("/report")).length, 0);
  });

  test("a token that expires mid-run is not presented; the row says so", async () => {
    let t = Date.now();
    const r = rig({ now: () => t });
    r.consoleEntry.running = true;
    r.consoleEntry.state = "working";
    queue.push(mkRun({ run_id: "mid", run_token: jwt(Math.floor(t / 1000) + 60) }));
    const tick = await r.poller.tick();
    t += 120_000;
    r.consoleEntry.running = false;
    await tick.done;
    assert.equal(seen.filter((x) => x.url.endsWith("/report")).length, 0);
    assert.equal(r.outcomes.at(-1)[1], "done · token expired, not reported");
  });

  test("a token with no exp falls back to the spec's 4 h TTL; a 401 also counts as expiry", async () => {
    const t0 = 1_000_000;
    assert.equal(runs.tokenExpired("opaque", t0, t0 + 3 * 3600 * 1000), false);
    assert.equal(runs.tokenExpired("opaque", t0, t0 + 4 * 3600 * 1000), true);

    const client = runs.createClient({ baseUrl: base, fetchImpl: async () => ({ status: 401, ok: false }) });
    await assert.rejects(client.report(mkRun(), Date.now(), { status: "done" }), runs.RunTokenExpired);
  });
});

describe("off by default", () => {
  test("disabled or without a credential, nothing is requested", async () => {
    const off = rig({ enabled: () => false });
    const unpaired = rig({ credential: () => null });
    await off.poller.tick();
    await unpaired.poller.tick();
    assert.equal(seen.length, 0);
  });
});

describe("the setting", () => {
  test("defaults to off and only an explicit true turns it on", () => {
    const masora = require(path.join(ROOT, "desktop", "masora.js"));
    assert.equal(masora.readConfig().runs, false);
    assert.equal(masora.setRunsPoll(true).runs, true);
    assert.equal(masora.setRunsPoll("yes").runs, false);
  });
});

// ---- review fixes (thermos, d783f000) ----
import fs from "node:fs";
const wire = require(path.join(ROOT, "desktop", "masora-runs-wire.js"));
const masoraMod = require(path.join(ROOT, "desktop", "masora.js"));
const { createConsoleLog } = require(path.join(ROOT, "desktop", "console-log.js"));
const agentApi = require(path.join(ROOT, "desktop", "agent-api.js"));
const reports = () => seen.filter((x) => x.url.endsWith("/report"));
const tick = () => new Promise((r) => setImmediate(r));
const pause = () => new Promise((r) => setTimeout(r, 150)); // a negative needs real time for a wrongly-sent report to land
const until = async (f) => { for (let i = 0; i < 2000 && !f(); i++) await tick(); assert.ok(f(), "condition never held"); };

describe("1. repo_hint resolves like a teammate's spawn", () => {
  test("last segment, case-insensitive; none and ambiguous stay distinct errors", () => {
    assert.equal(wire.lastSegment("git@github.com:Acme/App.git"), "App");
    assert.equal(wire.lastSegment("acme/app"), "app");
    assert.equal(wire.lastSegment("C:\\code\\App"), "App");
    assert.equal(wire.resolveHint("acme/app", ["C:/w/App", "C:/w/other"]).dir, path.resolve("C:/w/App"));
    const none = wire.resolveHint("acme/app", ["C:/w/other"]);
    const many = wire.resolveHint("acme/app", ["C:/w/App", "D:/x/app"]);
    assert.match(none.error, /no open folder named app/);
    assert.match(many.error, /2 open folders/);
    assert.notEqual(none.error, many.error);
    assert.ok(wire.resolveHint("", ["C:/w/App"]).error);
  });
});

describe("2. idle is not finished until a turn happened (real console-log)", () => {
  const live = () => {
    const log = createConsoleLog();
    log.open("c1", { agent: "claude", root: "/r", startedAt: Date.now() });
    return log;
  };
  const rigReal = (log, over = {}) => rig({
    getConsole: (id) => log.get(id), summarize: agentApi._internals.summarize,
    resultText: (e) => e.lastResult, sleep: tick, ...over,
  });

  test("a console that is still idle with no turn is not reported; its result then is", async () => {
    const log = live();
    const r = rigReal(log);
    queue.push(mkRun({ run_id: "early" }));
    const t = await r.poller.tick();
    await pause();
    assert.equal(reports().length, 0, "idle before the first prompt is not done");
    log.record("c1", { type: "prompt", text: "go" });
    log.record("c1", { type: "agent", payload: { type: "result", result: "shipped", is_error: false } });
    await t.done;
    assert.equal(reports()[0].body.status, "done");
    assert.equal(reports()[0].body.result_text, "shipped");
  });

  test("an exit before any turn is failed, not done", async () => {
    const log = live();
    const r = rigReal(log);
    queue.push(mkRun({ run_id: "died" }));
    const t = await r.poller.tick();
    log.record("c1", { type: "exit" });
    await t.done;
    assert.equal(reports()[0].body.status, "failed");
    assert.match(reports()[0].body.result_text, /exited before answering/);
  });

  test("while the app relaunches, an exit is not the run's end", async () => {
    const log = live();
    let relaunching = true;
    const r = rigReal(log, { isRelaunching: () => relaunching });
    queue.push(mkRun({ run_id: "relaunch" }));
    const t = await r.poller.tick();
    log.record("c1", { type: "prompt", text: "go" });
    log.record("c1", { type: "agent", payload: { type: "result", result: "x" } });
    log.record("c1", { type: "exit" });
    await pause();
    assert.equal(reports().length, 0);
    relaunching = false;
    await t.done;
    assert.equal(reports().length, 1);
  });
});

describe("3. needs_you is this run's console, and the run stays ours while it is live", () => {
  test("needsYouFor looks at the asking console only", () => {
    const pendingPermits = new Map([["p1", () => {}]]);
    const permitRuns = new Map([["p1", "runA"]]);
    const runConsoles = new Map([["runA", "cA"], ["runB", "cB"]]);
    const ctx = { pendingPermits, permitRuns, runConsoles };
    assert.equal(wire.needsYouFor("cA", ctx), true);
    assert.equal(wire.needsYouFor("cB", ctx), false);
    pendingPermits.delete("p1");
    assert.equal(wire.needsYouFor("cA", ctx), false);
    assert.equal(permitRuns.size, 0, "answered permits are pruned");
  });

  test("after needs_you no second run is claimed until the console ends; then it reports done and stops it", async () => {
    let waiting = true;
    const stops = [];
    const r = rig({ needsYou: () => waiting, stop: (id) => stops.push(id) });
    r.consoleEntry.running = true;
    r.consoleEntry.state = "working";
    queue.push(mkRun({ run_id: "first" }), mkRun({ run_id: "second" }));
    const t = await r.poller.tick();
    await until(() => /^needs you/.test(r.outcomes.at(-1)?.[1] ?? ""));
    assert.deepEqual(stops, [], "needs_you leaves the console up for the answer");
    seen.length = 0;
    assert.equal(await r.poller.tick(), null);
    assert.equal(seen.length, 0, "a live run is never claimed on top of");
    waiting = false;
    r.consoleEntry.state = "idle";
    await t.done;
    assert.deepEqual(reports().map((x) => x.body.status), ["done"]);
    assert.deepEqual(stops, ["c1"], "a finished run's console is stopped");
    assert.ok(await r.poller.tick(), "free again");
  });
});

describe("4. one postJson", () => {
  test("https required except loopback; no redirects; its own ref'd timer", async () => {
    await assert.rejects(masoraMod.postJson("http://masora.example.com", "/x", "t", {}, 50, async () => assert.fail("must not fetch")), /https/);
    await assert.rejects(masoraMod.postJson("ftp://127.0.0.1", "/x", "t", {}, 50, async () => assert.fail("no")), /https/);
    let init;
    const ok = await masoraMod.postJson("http://127.0.0.1:9", "/x", "t", { a: 1 }, 50, async (_u, i) => { init = i; return { status: 200, ok: true, json: async () => ({ y: 1 }) }; });
    assert.equal(init.redirect, "error");
    assert.deepEqual(ok, { status: 200, ok: true, body: { y: 1 } });
    const hang = (_u, i) => new Promise((_r, rej) => i.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    const started = Date.now();
    await assert.rejects(masoraMod.postJson("https://m.example.com", "/x", "t", {}, 50, hang), /aborted/);
    assert.ok(Date.now() - started < 2000);
  });

  test("the runs client and briefFor both go through it: plain http off loopback is refused before any fetch", async () => {
    const client = runs.createClient({ baseUrl: "http://masora.example.com", fetchImpl: async () => assert.fail("must not fetch") });
    await assert.rejects(client.claim("c", "d"), runs.MasoraRunsError);
    assert.equal(await masoraMod.briefFor({ baseUrl: "http://masora.example.com", token: "t", prompt: "x", fetchImpl: async () => assert.fail("no") }), null);
  });
});

describe("5. restart safety", () => {
  test("the device id is persisted before the first claim, once runs are on; never at construction", async () => {
    const ledgerFile = path.join(home.dir, `fresh-${++n}.json`);
    const r = rig({ ledgerFile });
    assert.equal(fs.existsSync(ledgerFile), false, "construction writes nothing");
    await r.poller.tick();
    assert.equal(JSON.parse(fs.readFileSync(ledgerFile, "utf8")).deviceId, r.poller.ledger.deviceId);
    assert.equal(seen[0].body.device_id, r.poller.ledger.deviceId);
  });

  test("an unwritable ledger cannot stop the app: construction and startMasoraRuns do not throw", async () => {
    const blocker = path.join(home.dir, `blocker-${++n}`);
    fs.writeFileSync(blocker, "a file, so nothing can be created beneath it");
    const ledgerFile = path.join(blocker, "masora-runs.json");
    const p = new runs.MasoraRunPoller({ ledgerFile, enabled: () => false, credential: () => null });
    assert.ok(p);
    const masoraStub = { readConfig: () => ({ runs: false, paired: false }) };
    const ctx = {
      masora: masoraStub, safeStorage: {}, consoleLog: {}, agentApi: agentApi, payerOf: () => ({ label: "" }),
      announceOutcome() {}, readWorkspaces: () => [], storedMode: () => "ask", startAndBrief() {},
      stopAgentCore() {}, permits: {}, isRelaunching: () => false, ledgerFile,
    };
    const started = wire.startMasoraRuns(ctx);
    started.stop();
    // and a failure inside setup is logged and swallowed, not thrown out of whenReady
    assert.equal(wire.startMasoraRuns({ ...ctx, agentApi: null }), null);
  });

  test("a ledger that cannot be written on a claim does not make done reject", async () => {
    const blocker = path.join(home.dir, `blocker-${++n}`);
    fs.writeFileSync(blocker, "x");
    const r = rig({ ledgerFile: path.join(blocker, "l.json") });
    queue.push(mkRun({ run_id: "nowrite" }));
    await assert.rejects(r.poller.tick()); // the claim itself refuses: nothing started without a ledger entry
    assert.equal(r.started.length, 0);
  });

  test("a claimed-but-unreported run is reported failed 'desktop restarted' at the next start, then cleared", async () => {
    const ledgerFile = path.join(home.dir, `restart-${++n}.json`);
    const tok = jwt(inFuture());
    fs.writeFileSync(ledgerFile, JSON.stringify({ deviceId: "dev", ids: ["gone"], open: { gone: { run_token: tok, claimedAt: Date.now() } } }));
    const r = rig({ ledgerFile });
    assert.equal(await r.poller.tick(), null);
    const rep = reports();
    assert.equal(rep.length, 1);
    assert.equal(rep[0].url, "/api/v2/agent-runs/gone/report");
    assert.equal(rep[0].auth, `Bearer ${tok}`);
    assert.equal(rep[0].body.status, "failed");
    assert.equal(rep[0].body.result_text, "desktop restarted");
    assert.deepEqual(JSON.parse(fs.readFileSync(ledgerFile, "utf8")).open, {});
    seen.length = 0;
    await r.poller.tick();
    assert.equal(reports().length, 0, "reported once");
  });

  test("a run re-offered after a restart is not rerun", async () => {
    const ledgerFile = path.join(home.dir, `reoffer-${++n}.json`);
    fs.writeFileSync(ledgerFile, JSON.stringify({ deviceId: "dev", ids: ["again"], open: { again: { run_token: jwt(inFuture()), claimedAt: Date.now() } } }));
    let failedOnce = false; // the startup report is lost to a network blip; the re-offer is the second chance
    const flaky = (u, i) => {
      if (String(u).endsWith("/again/report") && !failedOnce) { failedOnce = true; return Promise.reject(new Error("offline")); }
      return fetch(u, i);
    };
    const r = rig({ ledgerFile, fetchImpl: flaky });
    queue.push(mkRun({ run_id: "again" }));
    await r.poller.tick();
    assert.equal(r.started.length, 0, "not rerun");
    assert.ok(reports().some((x) => x.url.includes("/again/") && x.body.result_text === "desktop restarted"));
    assert.deepEqual(JSON.parse(fs.readFileSync(ledgerFile, "utf8")).open, {});
  });

  test("a report that cannot be delivered stays open for the next start", async () => {
    const ledgerFile = path.join(home.dir, `retry-${++n}.json`);
    fs.writeFileSync(ledgerFile, JSON.stringify({ deviceId: "dev", ids: ["x"], open: { x: { run_token: jwt(inFuture()), claimedAt: Date.now() } } }));
    const r = rig({ ledgerFile, fetchImpl: async () => { throw new Error("offline"); } });
    await r.poller.tick().catch(() => {});
    assert.ok(JSON.parse(fs.readFileSync(ledgerFile, "utf8")).open.x);
  });
});

describe("6. deadlines", () => {
  test("ISO without a zone is UTC; epoch seconds work; junk is null", () => {
    assert.equal(runs.parseDeadline("2026-10-08T12:00:00"), Date.UTC(2026, 9, 8, 12));
    assert.equal(runs.parseDeadline("2026-10-08 12:00:00"), Date.UTC(2026, 9, 8, 12));
    assert.equal(runs.parseDeadline("2026-10-08T12:00:00+02:00"), Date.UTC(2026, 9, 8, 10));
    assert.equal(runs.parseDeadline(1791460800), 1791460800 * 1000);
    assert.equal(runs.parseDeadline("1791460800"), 1791460800 * 1000);
    assert.equal(runs.parseDeadline("soon"), null);
    assert.equal(runs.parseDeadline(null), null);
  });

  test("no deadline: bounded by the earlier of token exp and claim+4h", () => {
    const t0 = 1_000_000_000_000;
    assert.equal(runs.runBound({ deadline: null, run_token: jwt(t0 / 1000 + 60) }, t0), t0 + 60_000);
    assert.equal(runs.runBound({ deadline: null, run_token: jwt(t0 / 1000 + 99999) }, t0), t0 + 4 * 3600_000);
    assert.equal(runs.runBound({ deadline: "junk", run_token: "opaque" }, t0), t0 + 4 * 3600_000);
  });

  test("a far-future deadline cannot outlive the token", () => {
    const t0 = 1_000_000_000_000;
    assert.equal(runs.runBound({ deadline: new Date(t0 + 99 * 3600_000).toISOString(), run_token: jwt(t0 / 1000 + 60) }, t0), t0 + 60_000);
    assert.equal(runs.runBound({ deadline: new Date(t0 + 99 * 3600_000).toISOString(), run_token: "opaque" }, t0), t0 + 4 * 3600_000);
    assert.equal(runs.runBound({ deadline: new Date(t0 + 1000).toISOString(), run_token: jwt(t0 / 1000 + 60) }, t0), t0 + 1000);
  });

  test("a still-working run with a null deadline is stopped once its bound passes", async () => {
    let t = Date.now();
    const stops = [];
    const r = rig({ now: () => t, stop: (id) => stops.push(id) });
    r.consoleEntry.running = true;
    r.consoleEntry.state = "working";
    queue.push(mkRun({ run_id: "bound", run_token: jwt(Math.floor(t / 1000) + 3600) }));
    const tk = await r.poller.tick();
    await tick();
    t += 3601_000; // past the token's exp: the bound
    await tk.done;
    assert.deepEqual(stops, ["c1"]);
    assert.equal(r.outcomes.at(-1)[1], "failed · token expired, not reported");
  });
});

describe("7. allowed_actions", () => {
  test("a run that may act is failed visibly and never started", async () => {
    const r = rig();
    queue.push(mkRun({ run_id: "acts", allowed_actions: ["github.open_pr"] }));
    await (await r.poller.tick()).done;
    assert.equal(r.started.length, 0);
    assert.equal(reports()[0].body.status, "failed");
    assert.equal(reports()[0].body.result_text, "actions not supported by this Zevet");
  });
});

describe("8. payer", () => {
  test("the plan label goes out; an unknown payer fails the run instead of sending an empty one", async () => {
    let r = rig();
    queue.push(mkRun({ run_id: "p1" }));
    await (await r.poller.tick()).done;
    assert.equal(reports()[0].body.payer, "Claude · andrew@example.com (Max)");

    r = rig({ payer: () => "" });
    queue.push(mkRun({ run_id: "p2" }));
    await (await r.poller.tick()).done;
    assert.equal(r.started.length, 0);
    assert.equal(reports()[0].body.status, "failed");
    assert.notEqual(reports()[0].body.payer, "");
  });
});

describe("9. ticks and the ledger", () => {
  test("overlapping ticks claim once", async () => {
    const r = rig();
    queue.push(mkRun({ run_id: "once" }), mkRun({ run_id: "twice" }));
    const [a, b] = await Promise.all([r.poller.tick(), r.poller.tick()]);
    assert.equal(seen.filter((x) => x.url.endsWith("/claim")).length, 1);
    assert.equal([a, b].filter(Boolean).length, 1);
    await (a || b).done;
  });

  test("a corrupt ledger is kept aside and nothing is claimed", async () => {
    const ledgerFile = path.join(home.dir, `corrupt-${++n}.json`);
    fs.writeFileSync(ledgerFile, "{ not json");
    const r = rig({ ledgerFile });
    queue.push(mkRun({ run_id: "c" }));
    assert.equal(await r.poller.tick(), null);
    assert.equal(seen.length, 0);
    assert.equal(fs.readFileSync(ledgerFile, "utf8"), "{ not json", "the original is left in place");
    assert.ok(fs.readdirSync(home.dir).some((f) => f.startsWith(path.basename(ledgerFile) + ".corrupt-")), "and copied aside");
  });
});
