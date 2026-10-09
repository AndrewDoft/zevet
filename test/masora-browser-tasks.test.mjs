// Masora `browser.task` on the desktop (desktop/masora-browser-tasks.js; wire: docs/contracts/browser-task.md).
// The server is a local fake of the contract's two routes; the runner is a fake `run` dep (the real Python
// runner is covered by browser-task-runner.test.mjs).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { tempDir, ROOT } from "./helpers.mjs";

const home = tempDir("zevet-browser-tasks-");
process.env.ZEVET_HOME = home.dir;
const require = createRequire(import.meta.url);
const bt = require(path.join(ROOT, "desktop", "masora-browser-tasks.js"));

const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
const inFuture = () => Math.floor(Date.now() / 1000) + 3600;
const SHA = "a".repeat(64);
const CONTRACT_KEYS = ["cost_usd", "final_url", "reason", "screenshot_sha256", "status", "steps"];

let server;
let base;
let queue;
let seen;
let reportStatus; // what the fake answers to a report
before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      if (req.url === "/api/v2/browser-tasks/claim") {
        const next = queue.shift();
        if (!next) return res.writeHead(204).end();
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(next));
      }
      res.writeHead(reportStatus, { "content-type": "application/json" }).end(JSON.stringify({ status: "done", reason: "" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const mkTask = (over = {}) => ({
  task_id: "task-1", action_id: "act-1", start_url: "https://app.example.com/start?q=secret#frag", instruction: "do the thing",
  allowed_domains: ["app.example.com"], max_steps: 5, max_usd: 2, payload_sha256: "f".repeat(64), allowed_providers: null,
  deadline: new Date(Date.now() + 3600_000).toISOString(), task_token: jwt(inFuture()), ...over,
});
const goodResult = (over = {}) => ({
  status: "done", steps: [{ verb: "navigate", url: "https://app.example.com/start", ok: true }, { verb: "click", url: "https://app.example.com/x", ok: true }],
  final_url: "https://app.example.com/done", screenshot_sha256: SHA, reason: null, cost_usd: 0.31, ...over,
});
const reports = () => seen.filter((x) => x.url.endsWith("/report"));

let n = 0;
function rig(over = {}) {
  queue = [];
  seen = [];
  reportStatus = 200;
  const ran = [];
  const ledgerFile = path.join(home.dir, `ledger-${++n}.json`);
  const deps = {
    enabled: () => true,
    credential: () => ({ baseUrl: base, token: "family-credential" }),
    runnerConfig: () => ({ python: "py", script: "runner.py", config: { profile_dir: "p", models: [] } }),
    run: async (job) => { ran.push(job); return goodResult(); },
    setOutcome: () => {},
    ledgerFile,
    ...over,
  };
  return { poller: new bt.BrowserTaskPoller(deps), deps, ran, ledgerFile };
}

describe("claim and report: the contract's wire shapes", () => {
  test("claim sends only device_id with the person credential; 204 is no task", async () => {
    const { poller } = rig();
    assert.equal(await poller.tick(), null);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/api/v2/browser-tasks/claim");
    assert.equal(seen[0].auth, "Bearer family-credential");
    assert.deepEqual(Object.keys(seen[0].body), ["device_id"]);
  });

  test("happy path: ledgered BEFORE the runner starts, runner never sees the task_token, report carries only contract keys", async () => {
    let ledgerAtRun;
    const r = rig({ run: async (job) => { ledgerAtRun = JSON.parse(fs.readFileSync(r.ledgerFile, "utf8")); r.ran.push(job); return goodResult(); } });
    const task = mkTask();
    queue.push(task);
    await (await r.poller.tick()).done;
    assert.ok(ledgerAtRun.open["task-1"], "the id must be on disk before the runner starts");
    assert.equal(r.ran.length, 1);
    assert.equal(JSON.stringify(r.ran[0]).includes(task.task_token), false, "the runner must not receive the task_token");
    assert.equal(r.ran[0].input.task.instruction, "do the thing");
    assert.ok(r.ran[0].input.config.timeout_s > 0 && r.ran[0].input.config.timeout_s <= 45 * 60);
    const rep = reports()[0];
    assert.equal(rep.url, "/api/v2/browser-tasks/task-1/report");
    assert.equal(rep.auth, `Bearer ${task.task_token}`);
    assert.deepEqual(Object.keys(rep.body).sort(), CONTRACT_KEYS);
    assert.deepEqual(rep.body, goodResult());
    assert.deepEqual(JSON.parse(fs.readFileSync(r.ledgerFile, "utf8")).open, {}, "closed after the report");
  });

  test("a report never carries a key outside the contract, nor page text", async () => {
    const r = rig({ run: async () => goodResult({ page_text: "SECRET PAGE", html: "<b>", steps: [{ verb: "type", url: "https://app.example.com/a", ok: true, text: "hunter2", value: "x" }] }) });
    queue.push(mkTask());
    await (await r.poller.tick()).done;
    const body = reports()[0].body;
    assert.deepEqual(Object.keys(body).sort(), CONTRACT_KEYS);
    assert.deepEqual(Object.keys(body.steps[0]).sort(), ["ok", "url", "verb"]);
    assert.deepEqual(Object.keys(bt.buildReport(goodResult({ page_text: "x" }), mkTask())).sort(), CONTRACT_KEYS, "buildReport is a whitelist on its own");
    assert.equal(JSON.stringify(body).includes("SECRET PAGE") || JSON.stringify(body).includes("hunter2"), false);
  });

  test("the client itself sends only the contract keys, whatever it is handed", async () => {
    const r = rig();
    await bt.createClient({ baseUrl: base, fetchImpl: undefined }).report("t9", jwt(inFuture()), Date.now(), { ...goodResult(), page_text: "LEAK", extra: 1 });
    assert.deepEqual(Object.keys(reports().find((x) => x.url.includes("/t9/")).body).sort(), CONTRACT_KEYS);
    void r;
  });

  test("query and fragment are dropped from step and final urls", () => {
    const rep = bt.buildReport(goodResult({ steps: [{ verb: "click", url: "https://app.example.com/a?token=abc#f", ok: true }], final_url: "https://app.example.com/b?x=1" }), mkTask());
    assert.equal(rep.steps[0].url, "https://app.example.com/a");
    assert.equal(rep.final_url, "https://app.example.com/b");
  });
});

describe("the report is re-checked against the fence and the approved limits", () => {
  const task = mkTask();
  test("an off-fence step url makes it failed/off_domain and the url is not forwarded", () => {
    const rep = bt.buildReport(goodResult({ steps: [{ verb: "navigate", url: "https://evil.example.net/x", ok: true }] }), task);
    assert.equal(rep.status, "failed");
    assert.equal(rep.reason, "off_domain");
    assert.equal(JSON.stringify(rep).includes("evil.example.net"), false);
  });
  test("a lookalike host (label boundary) is off-fence", () => {
    const rep = bt.buildReport(goodResult({ final_url: "https://evilapp.example.com/" }), mkTask({ allowed_domains: ["app.example.com"] }));
    assert.equal(rep.reason, "off_domain");
    assert.equal(bt.inFence("https://x.app.example.com/", ["app.example.com"]), true);
    assert.equal(bt.inFence("http://app.example.com/", ["app.example.com"]), false);
  });
  test("more steps than approved is failed/max_steps and truncated", () => {
    const steps = Array.from({ length: 9 }, () => ({ verb: "click", url: "https://app.example.com/a", ok: true }));
    const rep = bt.buildReport(goodResult({ steps }), task);
    assert.equal(rep.status, "failed");
    assert.equal(rep.reason, "max_steps");
    assert.equal(rep.steps.length, 5);
  });
  test("cost over max_usd is failed/cost_cap", () => {
    const rep = bt.buildReport(goodResult({ cost_usd: 2.5 }), task);
    assert.equal(rep.status, "failed");
    assert.equal(rep.reason, "cost_cap");
  });
  test("a verb or reason outside the vocabulary never goes out", () => {
    const rep = bt.buildReport(goodResult({ steps: [{ verb: "exfiltrate", url: "https://app.example.com/a", ok: true }, { verb: "click", url: "https://app.example.com/a", ok: "yes" }], status: "failed", reason: "because" }), task);
    assert.deepEqual(rep.steps, []);
    assert.equal(rep.reason, "error");
  });
  test("done can never carry a reason; a bad hash becomes the empty-screenshot hash", () => {
    const rep = bt.buildReport(goodResult({ reason: "error", screenshot_sha256: "nope" }), task);
    assert.equal(rep.status, "failed");
    assert.equal(rep.screenshot_sha256, bt.EMPTY_SHA256);
  });
  test("model_not_allowed passes through as the runner's failure reason", () => {
    const rep = bt.buildReport({ status: "failed", steps: [], final_url: "https://app.example.com/start", screenshot_sha256: SHA, reason: "model_not_allowed", cost_usd: 0 }, task);
    assert.equal(rep.reason, "model_not_allowed");
  });
});

describe("runner failures are failed reports, never silence", () => {
  for (const [name, run] of [
    ["a crash", async () => { throw new Error("exit 1"); }],
    ["a timeout", async () => { throw new Error("runner timed out"); }],
    ["garbage", async () => "not an object"],
    ["null", async () => null],
  ]) {
    test(name, async () => {
      const r = rig({ run });
      queue.push(mkTask());
      await (await r.poller.tick()).done;
      const b = reports()[0].body;
      assert.equal(b.status, "failed");
      assert.equal(b.reason, "error");
      assert.deepEqual(Object.keys(b).sort(), CONTRACT_KEYS);
      assert.equal(b.final_url, "https://app.example.com/start");
    });
  }
  test("no runner configured: failed/error, visibly", async () => {
    const outcomes = [];
    const r = rig({ runnerConfig: () => null, setOutcome: (id, t) => outcomes.push(t) });
    queue.push(mkTask());
    await (await r.poller.tick()).done;
    assert.equal(reports()[0].body.reason, "error");
    assert.match(outcomes[0], /not set up/);
  });
});

describe("a claim never runs twice", () => {
  test("the same task_id offered again does not run again, even in a new poller", async () => {
    const first = rig();
    queue.push(mkTask());
    await (await first.poller.tick()).done;
    assert.equal(first.ran.length, 1);
    queue.push(mkTask());
    const again = new bt.BrowserTaskPoller({ ...first.deps, run: async () => assert.fail("ran twice") });
    assert.equal(await again.tick(), null);
  });

  test("one task at a time: a busy poller does not claim", async () => {
    let release;
    const r = rig({ run: () => new Promise((res) => { release = () => res(goodResult()); }) });
    queue.push(mkTask({ task_id: "a" }), mkTask({ task_id: "b" }));
    const t = await r.poller.tick();
    seen.length = 0;
    assert.equal(await r.poller.tick(), null);
    assert.equal(seen.length, 0);
    release();
    await t.done;
  });
});

describe("restart safety", () => {
  test("a claimed-but-unreported task is reported failed/error at the next start, then cleared", async () => {
    const r = rig();
    fs.writeFileSync(r.ledgerFile, JSON.stringify({ deviceId: "d", ids: ["old"], open: { old: { task_token: jwt(inFuture()), claimedAt: Date.now(), start_url: "https://app.example.com/start" } } }));
    const p = new bt.BrowserTaskPoller(r.deps);
    await p.tick();
    const rep = reports().find((x) => x.url.includes("/old/report"));
    assert.equal(rep.body.status, "failed");
    assert.equal(rep.body.reason, "error");
    assert.equal(rep.body.final_url, "https://app.example.com/start");
    assert.deepEqual(JSON.parse(fs.readFileSync(r.ledgerFile, "utf8")).open, {});
  });

  test("owed even with the setting off, but nothing new is claimed", async () => {
    const r = rig({ enabled: () => false });
    fs.writeFileSync(r.ledgerFile, JSON.stringify({ deviceId: "d", ids: ["old"], open: { old: { task_token: jwt(inFuture()), claimedAt: Date.now(), start_url: "https://app.example.com/" } } }));
    await new bt.BrowserTaskPoller(r.deps).tick();
    assert.equal(reports().length, 1);
    assert.equal(seen.some((x) => x.url.endsWith("/claim")), false);
  });

  test("a finished task whose report could not be delivered is re-sent as it was, not as a failure", async () => {
    const r = rig();
    queue.push(mkTask());
    reportStatus = 500;
    await (await r.poller.tick()).done;
    assert.ok(JSON.parse(fs.readFileSync(r.ledgerFile, "utf8")).open["task-1"], "stays open");
    reportStatus = 200;
    seen.length = 0;
    await new bt.BrowserTaskPoller(r.deps).tick();
    assert.deepEqual(reports()[0].body, goodResult());
    assert.deepEqual(JSON.parse(fs.readFileSync(r.ledgerFile, "utf8")).open, {});
  });

  test("a corrupt ledger is kept aside and nothing is claimed", async () => {
    const r = rig();
    fs.writeFileSync(r.ledgerFile, "{not json");
    const p = new bt.BrowserTaskPoller(r.deps);
    assert.equal(await p.tick(), null);
    assert.equal(seen.length, 0);
    assert.ok(fs.readdirSync(home.dir).some((f) => f.startsWith(path.basename(r.ledgerFile) + ".corrupt-")));
  });
});

describe("expired task_token and the setting", () => {
  test("a token already expired at claim is never used: no run, no report", async () => {
    const r = rig();
    queue.push(mkTask({ task_token: jwt(Math.floor(Date.now() / 1000) - 10) }));
    assert.equal(await r.poller.tick(), null);
    assert.equal(r.ran.length, 0);
    assert.equal(reports().length, 0);
  });

  test("a token that expires while the runner works is not presented; the row is closed", async () => {
    let t = Date.now();
    const r = rig({ now: () => t, run: async () => { t += 2 * 3600_000; return goodResult(); } });
    queue.push(mkTask({ task_token: jwt(Math.floor(t / 1000) + 3000), deadline: null }));
    await (await r.poller.tick()).done;
    assert.equal(reports().length, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(r.ledgerFile, "utf8")).open, {});
    await assert.rejects(bt.createClient({ baseUrl: base }).report("x", jwt(1), 0, goodResult(), Date.now()), bt.TaskTokenExpired);
  });

  test("a 401 on the report counts as expiry and closes the task", async () => {
    const r = rig();
    queue.push(mkTask());
    reportStatus = 401;
    await (await r.poller.tick()).done;
    assert.deepEqual(JSON.parse(fs.readFileSync(r.ledgerFile, "utf8")).open, {});
  });

  test("off by default: disabled or unpaired requests nothing; only an explicit true turns the setting on", async () => {
    const off = rig({ enabled: () => false });
    const unpaired = rig({ credential: () => null });
    await off.poller.tick();
    await unpaired.poller.tick();
    assert.equal(seen.length, 0);
    const masora = require(path.join(ROOT, "desktop", "masora.js"));
    assert.equal(masora.readConfig().browserTasks, false);
    assert.equal(masora.setBrowserTasksPoll(true).browserTasks, true);
    assert.equal(masora.setBrowserTasksPoll("yes").browserTasks, false);
  });
});

describe("spawnRunner (a real child process)", () => {
  const script = (name, body) => {
    const f = path.join(home.dir, name);
    fs.writeFileSync(f, body);
    return f;
  };
  const go = (f, timeoutMs = 5000) => bt.spawnRunner({ python: process.execPath, pyArgs: [], script: f, input: { hello: 1 }, timeoutMs });

  test("reads stdin, takes the last JSON line of stdout", async () => {
    const f = script("ok.js", `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{console.log("noise");console.log(JSON.stringify({got:JSON.parse(s)}))})`);
    assert.deepEqual(await go(f), { got: { hello: 1 } });
  });
  test("garbage or an empty stdout rejects", async () => {
    await assert.rejects(go(script("bad.js", `console.log("not json")`)), /without a JSON result/);
    await assert.rejects(go(script("empty.js", `process.exit(3)`)), /exited 3/);
  });
  test("a runner that hangs is killed at the timeout", async () => {
    const t0 = Date.now();
    await assert.rejects(go(script("hang.js", `setInterval(()=>{},1000)`), 600), /timed out/);
    assert.ok(Date.now() - t0 < 4000);
  });
});
