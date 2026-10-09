// Wires masora-runs.js into the app: which folder a run starts in, which console a permit belongs to, who pays.
// main.js calls startMasoraRuns() once from whenReady and passes in what only it owns; everything decidable
// without Electron lives here so it can be tested.
"use strict";

const masoraRuns = require("./masora-runs.js");
const agentSpawn = require("./agent-spawn.js");

/** "acme/app", "git@github.com:acme/app.git", "C:\\x\\app" -> "app" (the folder name Masora's hint ends in). */
function lastSegment(hint) {
  return String(hint || "").split(/[\\/:]/).filter(Boolean).pop()?.replace(/\.git$/i, "") || "";
}

/** The one opened workspace a repo_hint names: {dir}, or {error} (none / ambiguous stay distinct). */
function resolveHint(hint, workspaces) {
  return agentSpawn.resolveRepo(lastSegment(hint), workspaces);
}

/**
 * Whether `consoleId` is waiting on a person. Permits belong to the MCP run of the console that asked
 * (permitRuns: permit id -> run, runConsoles: run -> console id); another console's open prompt is not this one's.
 */
function needsYouFor(consoleId, { pendingPermits, permitRuns, runConsoles }) {
  for (const [permitId, run] of permitRuns) {
    if (!pendingPermits.has(permitId)) permitRuns.delete(permitId);
    else if (runConsoles.get(run) === consoleId) return true;
  }
  return false;
}

/**
 * ctx: masora, safeStorage, readWorkspaces(), storedMode(), startAndBrief({agent,dir,label,prompt,mode}),
 *      stopAgentCore(id), consoleLog, agentApi, payerOf(agent), announceOutcome(id, outcome),
 *      permits {pendingPermits, permitRuns, runConsoles}, isRelaunching()
 */
function startMasoraRuns(ctx) {
  const { masora, safeStorage, consoleLog } = ctx;
  const poller = new masoraRuns.MasoraRunPoller({
    enabled: () => masora.readConfig().runs,
    credential: () => {
      const cfg = masora.readConfig();
      if (!cfg.paired || !safeStorage.isEncryptionAvailable()) return null;
      const token = masora.loadToken((buf) => safeStorage.decryptString(buf));
      return token ? { baseUrl: cfg.url, token } : null;
    },
    // The folder comes from the person's OPENED workspaces only -- Masora never names a path.
    start: async (run) => {
      const found = resolveHint(run.repo_hint, ctx.readWorkspaces());
      if (!found.dir) return { ok: false, error: found.error };
      return ctx.startAndBrief({ agent: "claude", dir: found.dir, label: `Masora run ${run.run_id.slice(0, 8)}`, prompt: run.brief, mode: agentSpawn.safeMode(ctx.storedMode()) });
    },
    getConsole: (id) => consoleLog.get(id),
    stop: (id) => ctx.stopAgentCore(id),
    needsYou: (id) => needsYouFor(id, ctx.permits),
    isRelaunching: ctx.isRelaunching,
    summarize: ctx.agentApi._internals.summarize,
    resultText: (entry) => entry.lastResult || ctx.agentApi._internals.resultTextFrom(entry.events),
    payer: () => ctx.payerOf("claude").label,
    setOutcome: (id, outcome) => {
      consoleLog.updateMeta(id, { masoraRun: outcome });
      ctx.announceOutcome(id, outcome);
    },
  });
  poller.start();
  return poller;
}

module.exports = { startMasoraRuns, lastSegment, resolveHint, needsYouFor };
