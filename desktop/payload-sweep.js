"use strict";

/**
 * Old payload version trees, removed one at a time.
 *
 * desktop-kit's payload.gc() throws at the first directory Windows refuses to delete and stops there, so one held
 * tree (`EPERM ... payload\versions\0.2.121`, repeating for days in zevet-boot.log) kept every later tree and every
 * orphaned blob too. This sweeps each tree on its own with bounded retries, keeps what current.json / staged.json
 * name (the same keep set as gc, by name and never by age), and reports the ones it could not remove, with whatever
 * still has the tree open so the next log line says what holds it.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function keepSet(root) {
  const keep = new Set();
  const current = readJson(path.join(root, "current.json"));
  const staged = readJson(path.join(root, "staged.json"));
  if (current && current.build) keep.add(current.build);
  if (current && current.previous && current.previous.build) keep.add(current.previous.build);
  if (staged && staged.build) keep.add(staged.build);
  return keep;
}

/** Processes whose command line names `dir` (Windows). Best effort, hidden, bounded; [] anywhere it cannot look. */
function findHolders(dir, { platform = process.platform, exec = execFile } = {}) {
  if (platform !== "win32") return Promise.resolve([]);
  const needle = dir.replace(/'/g, "''");
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`;
  return new Promise((resolve) => {
    exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      resolve(err ? [] : String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 8));
    });
  });
}

/**
 * Remove every tree under <root>/versions that is not kept (and any stray `.tmp-*`). Never throws.
 * Returns { removed: [names], held: [{ name, code, holders }] }.
 */
async function sweepOldVersions({ root, fsImpl = fs, holders = findHolders, retries = 4, retryDelay = 250 }) {
  const versions = path.join(root, "versions");
  const keep = keepSet(root);
  const removed = [], held = [];
  let names;
  try { names = fsImpl.readdirSync(versions); } catch { return { removed, held }; }
  for (const name of names) {
    if (keep.has(name) && !name.includes(".tmp-")) continue;
    const full = path.join(versions, name);
    try {
      fsImpl.rmSync(full, { recursive: true, force: true, maxRetries: retries, retryDelay });
      removed.push(name);
    } catch (err) {
      let who = [];
      try { who = await holders(full); } catch { /* diagnostics only */ }
      held.push({ name, code: err && err.code || "ERR", holders: who });
    }
  }
  return { removed, held };
}

/** One log line for a sweep, or null when there was nothing to say. */
function describeSweep({ removed, held }) {
  if (!removed.length && !held.length) return null;
  const parts = [];
  if (removed.length) parts.push(`removed ${removed.join(", ")}`);
  for (const h of held) parts.push(`${h.name} held (${h.code})${h.holders.length ? ` by ${h.holders.join("; ")}` : ", no process names it"}`);
  return `old payload versions: ${parts.join("; ")}`;
}

/**
 * Sweep now, and again on a timer while anything stays held (a swap's own children and a virus scan release a tree
 * within minutes; a long-lived agent hours later). Stops at the first clean pass or after `maxRuns`. Timers are unref'd.
 */
function sweepUntilClean({ root, log, everyMs = 10 * 60 * 1000, maxRuns = 18, sweep = sweepOldVersions, setTimeoutImpl = setTimeout }) {
  let runs = 0;
  const pass = async () => {
    runs += 1;
    const r = await sweep({ root });
    const line = describeSweep(r);
    if (line) log(line);
    if (r.held.length && runs < maxRuns) {
      const t = setTimeoutImpl(pass, everyMs);
      if (t && t.unref) t.unref();
    }
    return r;
  };
  return pass();
}

module.exports = { keepSet, findHolders, sweepOldVersions, describeSweep, sweepUntilClean };
