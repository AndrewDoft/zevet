#!/usr/bin/env node
// Perf budgets for the parts of Zevet's boot that run in plain Node.
// Not in the suite: wall-clock timings on a loaded box flake, and a flaky
// test gets ignored. Run it on its own (`node scripts/perf-gate.mjs`), or
// before a release; exit code is the gate's own, so never pipe it.
//
//   moduleLoad     fresh `node` requires the Electron-free main-process modules
//   agentApiReady  fresh `node` start()s agent-api and answers one authed GET /list
//   hubColdBoot    `node hub/server.mjs` spawned -> /healthz answers 200
//
// NOT measured: Electron window-ready / board first paint. That needs a real
// BrowserWindow, which this gate refuses to open. Measure it by hand on a
// packaged build.
//
// Each figure is the median of RUNS fresh processes (run 1 is the coldest and
// stays in the median on purpose). Budgets live in perf-budgets.json and carry
// the 3.3-4.8x CI margin over the dev-box baseline.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const budgets = JSON.parse(fs.readFileSync(new URL("./perf-budgets.json", import.meta.url), "utf8"));
const RUNS = 5;
const PRINT = process.argv.includes("--print");
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const d = (f) => JSON.stringify(path.join(ROOT, "desktop", f));

// Runs `node -e src`, resolves with the ms from spawn until the child prints READY.
function timeChild(args, env, ready, cwd = os.tmpdir()) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const c = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let done = false;
    const finish = (err, ms) => { if (done) return; done = true; clearTimeout(timer); c.kill(); err ? reject(err) : resolve(ms); };
    const timer = setTimeout(() => finish(new Error(`no ready signal in 30s; output: ${out.slice(-300)}`)), 30000);
    const onData = (b) => { out += b; if (ready.test(out)) finish(null, performance.now() - t0); };
    c.stdout.on("data", onData);
    c.stderr.on("data", (b) => { out += b; });
    c.on("exit", (code) => finish(new Error(`child exited ${code} before ready; output: ${out.slice(-300)}`)));
  });
}

const MODULES = ["agent-api", "payload-swap", "console-persistence", "family", "app-update", "ask-server", "agent-engine"];
const loadSrc = `${MODULES.map((m) => `require(${d(m + ".js")});`).join("")}console.log("READY")`;

const apiSrc = `
const api = require(${d("agent-api.js")});
const no = () => ({ ok: true });
api.start({ startAgentCore: no, sendToAgentCore: no, stopAgentCore: no, getConsole: () => undefined, listConsoles: () => [] })
  .then(async ({ url, token }) => {
    const r = await fetch(url + "/list", { headers: { authorization: "Bearer " + token } });
    if (r.status !== 200) throw new Error("/list answered " + r.status);
    console.log("READY");
  }).catch((e) => { console.error(e.message); process.exit(1); });`;

async function hubColdBoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zevet-perf-"));
  try {
    const t0 = performance.now();
    const c = spawn(process.execPath, [path.join(ROOT, "hub", "server.mjs")], {
      cwd: dir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, PORT: "0", ZEVET_TOKEN: "perf", ZEVET_EVENTS: path.join(dir, "events.jsonl") },
    });
    try {
      const port = await new Promise((resolve, reject) => {
        let out = "";
        const timer = setTimeout(() => reject(new Error(`hub never listened; output: ${out.slice(-300)}`)), 30000);
        c.stdout.on("data", (b) => { out += b; const m = /127\.0\.0\.1:(\d+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
        c.stderr.on("data", (b) => { out += b; });
        c.on("exit", (code) => reject(new Error(`hub exited ${code}; output: ${out.slice(-300)}`)));
      });
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.status !== 200) throw new Error(`/healthz answered ${r.status}`);
      return Math.round(performance.now() - t0);
    } finally { c.kill(); }
  } finally {
    await new Promise((r) => setTimeout(r, 100));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const checks = [
  ["module load", "moduleLoad", () => timeChild(["-e", loadSrc], {}, /READY/)],
  ["agent-api ready", "agentApiReady", () => timeChild(["-e", apiSrc], {}, /READY/)],
  ["hub cold boot", "hubColdBoot", hubColdBoot],
];

let failed = false;
for (const [name, key, run] of checks) {
  const runs = [];
  try {
    for (let i = 0; i < RUNS; i++) runs.push(Math.round(await run()));
  } catch (e) {
    console.error(`::error::${name}: ${e.message}`);
    failed = true;
    continue;
  }
  const m = median(runs);
  if (PRINT) { console.log(`${key}: runs ${runs.join(", ")}ms, median ${m}ms -> budgetMs >= ${Math.ceil(m * 4.8)}`); continue; }
  const b = budgets[key];
  console.log(`${name}: ${runs.join(", ")}ms, median ${m}ms (baseline ${b.baselineMs}ms, budget ${b.budgetMs}ms)`);
  if (m > b.budgetMs) { console.error(`::error::${name} median ${m}ms exceeds the ${b.budgetMs}ms budget`); failed = true; }
}
process.exit(failed ? 1 : 0);
