#!/usr/bin/env node
// The auto-ship watcher: "a push to main is the update". Run every 10 minutes by the Scheduled Task that
// scripts/register-ship-watch.ps1 registers (hidden, no window). One tick:
//
//   ship already running (lock file)                       -> nothing
//   newest tag unfinished, canary not yet recorded         -> run ship, it resumes up to the canary and stops
//   newest tag on canary: soak gate (decideSoak) passes    -> run ship --promote (stable, hub, verify, D-record)
//   newest tag on canary: soak gate fails                  -> log the reasons, wait
//   commits past the last release that classify() calls a
//   release AND the tip's `ci` run is green                -> run ship
//   anything else                                          -> log why, do nothing
//
//   node scripts/ship-watch.mjs [--log FILE] [--dry-run] [--min-hours 4] [--max-new-issues 0] [--allow-unseen]
//
// CI is read with gh, never assumed: a tip whose ci run is red, still pending, or absent is not shipped.
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, LOCK, ROOT, readCanaryAt, realIo } from "./ship.mjs";
import { ciVerdict, decide, decideSoak, lockHeld, readSentry } from "./ship-lib.mjs";

const MAX_LOG = 512 * 1024;

/** One tick. Returns what it did, for the log and the tests. */
export async function tick({ io, held, runShip, feed, canaryAt = readCanaryAt, soak = {}, now = Date.now }) {
  if (held()) return { did: "skip", why: "a ship is running" };
  const d = decide(io, { feed: await feed(), soaking: canaryAt });
  if (d.action === "none") return { did: "skip", why: d.reason };
  if (d.action === "resume") {
    const at = canaryAt(d.version);
    if (!at) return { did: "ship", why: `resume ${d.tag} up to the canary`, code: await runShip() };
    let sentry = null;
    try { sentry = readSentry(d.version, new Date(at), (a) => io.sentry(a)); } catch (e) { io.log?.(`sentry: ${e.message.split("\n")[0]}`); }
    const g = decideSoak({ canaryAt: at, now: now(), sentry }, soak);
    if (!g.ok) return { did: "skip", why: `${d.tag} soaking on canary since ${at}: ${g.reasons.join("; ")}` };
    return { did: "ship", why: `promote ${d.tag}: soak gate passed (canary since ${at})`, code: await runShip(["--promote"]) };
  }
  const runs = JSON.parse(io.gh(["run", "list", "--workflow", "ci", "--commit", d.tip, "-L", "5", "--json", "status,conclusion,createdAt"]));
  const ci = ciVerdict(runs);
  if (ci !== "green") return { did: "skip", why: `${d.version} is ready (${d.commits} commit(s) past v${d.base}) but ci on ${d.tip.slice(0, 7)} is ${ci}` };
  return { did: "ship", why: `${d.version} (${d.kind}${d.hub ? " + hub" : ""}), ci green on ${d.tip.slice(0, 7)}`, code: await runShip() };
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const logFile = flag("--log") || path.join(process.env.LOCALAPPDATA || ROOT, "Zevet", "ship-watch.log");
  mkdirSync(path.dirname(logFile), { recursive: true });
  try { if (statSync(logFile).size > MAX_LOG) writeFileSync(logFile, readFileSync(logFile, "utf8").slice(-MAX_LOG / 4)); } catch { /* no log yet */ }
  const log = (s) => appendFileSync(logFile, `${new Date().toISOString()} ${s}\n`);
  const io = realIo({ log });
  try {
    io.git(["fetch", "-q", "--tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    // Run the newest ship.mjs: fast-forward this checkout when it is a clean main.
    if (io.git(["branch", "--show-current"]) === "main" && !io.git(["status", "--porcelain"])) io.git(["merge", "--ff-only", "-q", "origin/main"]);
    const r = await tick({
      io,
      held: () => lockHeld(LOCK),
      feed: async () => JSON.parse((await io.https(`${BASE}/zevet-latest.json`)).body.toString("utf8")).version,
      soak: {
        ...(flag("--min-hours") && { minHours: Number(flag("--min-hours")) }),
        ...(flag("--max-new-issues") && { maxNewIssues: Number(flag("--max-new-issues")) }),
        allowUnseen: argv.includes("--allow-unseen"),
      },
      runShip: (extra = []) => new Promise((resolve) => {
        if (argv.includes("--dry-run")) return resolve(0);
        const fd = openSync(logFile, "a");
        const p = spawn(process.execPath, [path.join(ROOT, "scripts", "ship.mjs"), ...extra], { cwd: ROOT, stdio: ["ignore", fd, fd], windowsHide: true });
        p.on("close", (code) => { closeSync(fd); resolve(code); });
      }),
    });
    log(`${r.did}: ${r.why}${r.code === undefined ? "" : ` -> exit ${r.code}`}`);
    process.exitCode = r.code || 0;
  } catch (e) {
    log(`error: ${e.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
