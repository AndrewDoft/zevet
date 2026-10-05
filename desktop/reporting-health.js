"use strict";
// Is this machine's activity actually reaching the team's hub? Teammates see
// your agents only if the hook posts events and the hub accepts them, and the
// hook is deliberately silent about failing (it must never disturb a turn).
// So the app checks, repairs what it can, and says ONE line when it can't.
//
// Everything here takes its io as arguments so test/reporting-health.test.mjs
// drives it without a hub, a disk or Electron.

const fs = require("node:fs");
const path = require("node:path");

const MARK = "--zevet-hook";

/** The hook script a repo's marked Claude hook points at, for each marked command. */
function hookPaths(settings) {
  const out = [];
  for (const groups of Object.values((settings && settings.hooks) || {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g.hooks) ? g.hooks : []) {
        if (!h || typeof h.command !== "string" || !h.command.includes(MARK)) continue;
        const m = /"([^"]*hook\.mjs)"/.exec(h.command) || /(\S*hook\.mjs)/.exec(h.command);
        // Only an absolute path can be judged; a relative one resolves against wherever the agent runs.
        if (m && path.isAbsolute(m[1])) out.push(m[1]);
      }
    }
  }
  return out;
}

/** True when the repo's settings carry a zevet hook whose script is gone. */
function hasStaleHook(settings, exists = fs.existsSync) {
  return hookPaths(settings).some((p) => !exists(p));
}

function readSettings(repo) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repo, ".claude", "settings.json"), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

/**
 * Rewrite every stale zevet hook in `repos` (install.mjs strips ours and writes
 * the current one, so this is the same repair "Connect folder" makes). Returns
 * the repos it could not repair.
 */
async function repairStaleHooks(repos, { install, read = readSettings, exists = fs.existsSync } = {}) {
  const failed = [];
  for (const repo of repos) {
    const s = read(repo);
    if (!s || !hasStaleHook(s, exists)) continue;
    const r = await install(repo);
    if (!r || !r.ok) failed.push(repo);
  }
  return failed;
}

/**
 * The one line to show in Settings, or "" when all is well.
 * `agentStartedAt` is when this app last started an agent (0 = none yet): if
 * one started a while ago and the hub has still not heard an event from this
 * person since, events are not getting through.
 */
async function reportingProblem({ hub, token, fetchImpl = fetch, agentStartedAt = 0, now = Date.now(), failedRepos = [] }) {
  if (failedRepos.length) return `Could not repair the agent hook in ${path.basename(failedRepos[0])}.`;
  let res;
  try {
    res = await fetchImpl(`${String(hub).replace(/\/+$/, "")}/auth/whoami`, { headers: { "x-zevet-token": token }, signal: AbortSignal.timeout(6000) });
  } catch {
    return "Hub not reachable.";
  }
  if (res.status === 401) return "Signed out of the hub. Sign in again.";
  if (!res.ok) return "";
  const who = await res.json().catch(() => null);
  if (!who) return "";
  if (who.shared) return "Not signed in. Your team cannot see your agents.";
  const seen = who.me && who.me.presence && who.me.presence.eventAt;
  if (agentStartedAt && now - agentStartedAt > 3 * 60 * 1000 && (!seen || seen < agentStartedAt)) {
    return "No event from this machine has reached the hub since your last agent started.";
  }
  return "";
}

module.exports = { hookPaths, hasStaleHook, repairStaleHooks, reportingProblem };
