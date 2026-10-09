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
  allowed_actions: ["github.open_pr"], deadline: null, ...over,
});

let n = 0;
function rig(over = {}) {
  queue = [];
  seen = [];
  const outcomes = [];
  const started = [];
  const consoleEntry = { running: false, state: "idle", isError: false, lastResult: "all done", events: [] };
  const deps = {
    enabled: () => true,
    credential: () => ({ baseUrl: base, token: "family-credential" }),
    start: async (run) => { started.push(run); return { ok: true, id: "c1" }; },
    getConsole: () => consoleEntry,
    stop: () => {},
    needsYou: () => false,
    summarize: () => ({ sessionId: "sess-1", usage: { input_tokens: 3 }, costUsd: 0.5, elapsedMs: 1234 }),
    resultText: (e) => e.lastResult,
    payer: () => "Andrew",
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
      elapsed_ms: 1234, payer: "Andrew", result_text: "all done",
    });
    assert.deepEqual(outcomes, [["c1", "running"], ["c1", "done · reported"]]);
  });

  test("an errored console reports failed; a permission stall reports needs_you", { timeout: 10_000 }, async () => {
    let r = rig();
    r.consoleEntry.isError = true;
    queue.push(mkRun({ run_id: "run-f" }));
    await (await r.poller.tick()).done;
    assert.equal(seen.find((x) => x.url.endsWith("/report")).body.status, "failed");

    r = rig({ needsYou: () => true });
    r.consoleEntry.running = true;
    r.consoleEntry.state = "working";
    queue.push(mkRun({ run_id: "run-n" }));
    await (await r.poller.tick()).done;
    assert.equal(seen.find((x) => x.url.endsWith("/report")).body.status, "needs_you");
    assert.match(r.outcomes.at(-1)[1], /^needs you/);
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
