#!/usr/bin/env node
// Head-to-head boot timing for any Electron app, headless (scripts/lib/boot-probe.cjs hides every window).
//
//   node scripts/perf-boot.mjs --exe <app.exe> --label zevet --mode cold|warm [--runs 5]
//        [--env K=V ...] [--ready-url /events] [--config '{"hub":...}'] [--settle 4000] [--arg --flag ...]
//
// The app must have been prepared so its entry requires the probe first: see scripts/perf-rig.md.
// cold = a fresh empty profile every run (first launch after install). warm = one priming run, then
// RUNS launches against the same profile (relaunch with a persisted session and a warm HTTP cache).
// Prints the median of each metric over RUNS runs (ms since the process was created).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : args[i + 1]; };
const multi = (n) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const exe = flag("exe");
if (!exe) { console.error("--exe required"); process.exit(2); }
const label = flag("label", path.basename(exe));
const mode = flag("mode", "cold");
const RUNS = Number(flag("runs", 5));
const settle = flag("settle", "4000");
const readyUrl = flag("ready-url", "");
const extraEnv = Object.fromEntries(multi("env").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
const extraArgs = multi("arg");
const config = flag("config", ""); // JSON written to $ZEVET_HOME/config.json in every fresh profile (a signed-in install)
const median = (xs) => { const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };

function profile() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "perf-boot-"));
  for (const d of ["ap", "lap", "ud", "zh"]) fs.mkdirSync(path.join(t, d));
  if (config) fs.writeFileSync(path.join(t, "zh", "config.json"), config);
  return t;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A launch can relaunch itself (payload swap), so wait for the line a process writes when it SETTLES.
// Returns every process line in order: [seed boot, ..., the one that settled].
async function once(t) {
  const out = path.join(t, "out.jsonl");
  fs.rmSync(out, { force: true });
  const env = {
    ...process.env, APPDATA: path.join(t, "ap"), LOCALAPPDATA: path.join(t, "lap"), ZEVET_HOME: path.join(t, "zh"),
    ZEVET_ALLOW_MULTI: "1", PROBE_OUT: out, PROBE_SETTLE_MS: settle, PROBE_MAX_MS: "40000", PROBE_READY_URL: readyUrl, ...extraEnv,
  };
  const res = spawnSync(exe, [`--user-data-dir=${path.join(t, "ud")}`, ...extraArgs], { env, windowsHide: true, timeout: 70000, stdio: "ignore" });
  const lines = () => (fs.existsSync(out) ? fs.readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  for (let i = 0; i < 100 && !lines().some((l) => l.settled); i++) await sleep(500);
  const all = lines();
  if (!all.length) throw new Error(`${label}: no probe output (exit ${res.status}, signal ${res.signal})`);
  await sleep(2000); // let the settled process finish exiting before its profile is reused or deleted
  return all;
}

const dirs = [];
const runs = [];
const launches = []; // processes per run: 2 means the app relaunched itself before settling
const seedBoot = [];
try {
  let shared;
  if (mode === "warm") { shared = profile(); dirs.push(shared); await once(shared); }
  for (let i = 0; i < RUNS; i++) {
    const t = shared || profile();
    if (!shared) dirs.push(t);
    const chain = await once(t);
    launches.push(chain.length);
    seedBoot.push(chain.length > 1 ? chain[0] : null);
    runs.push(chain[chain.length - 1]);
  }
} finally {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

const w0 = (r, k) => r.windows[0]?.[k];
const rows = {
  appReady: runs.map((r) => r.appReady),
  windowCreated: runs.map((r) => w0(r, "created")),
  firstLoadStart: runs.map((r) => w0(r, "loadStart")),
  firstRealLoaded: runs.map((r) => r.firstReal),
  firstRealCommit: runs.map((r) => w0(r, "commit")),
  firstRealPaint: runs.map((r) => r.firstRealPaint),
  usable: runs.map((r) => r.ready),
  procs: runs.map((r) => r.procs),
  workingSetMB: runs.map((r) => r.workingSetMB),
  privateMB: runs.map((r) => r.privateMB),
  requests: runs.map((r) => r.reqCount),
  fromCache: runs.map((r) => r.fromCache),
};
const summary = { label, mode, runs: RUNS, url: runs[0].firstRealUrl, errors: runs.flatMap((r) => r.errors).length };
for (const [k, v] of Object.entries(rows)) summary[k] = median(v) === null ? null : Math.round(median(v));
summary.launches = median(launches);
summary.firstProcPaint = Math.round(median(seedBoot.map((b) => b && b.firstRealPaint)) ?? NaN) || null;
summary.all = Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.map((x) => (typeof x === "number" ? Math.round(x) : x))]));
if (args.includes("--requests")) for (const q of runs[runs.length - 1].requests) console.error(`${String(q.at).padStart(6)} ${q.s} ${q.c ? "cache" : "net  "} ${q.u}`);
console.log(JSON.stringify(summary));
