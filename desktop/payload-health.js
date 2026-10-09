"use strict";

// Shell-owned diagnostics. Never changes the client's signature, sequence, rollout or activation rules.
const fs = require("node:fs");
const path = require("node:path");
const DAY_MS = 24 * 60 * 60 * 1000;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function resolveChannel(root, env, log) {
  if (env.ZEVET_PAYLOAD_CHANNEL) return env.ZEVET_PAYLOAD_CHANNEL;
  const file = path.join(root, "channel");
  let saved;
  try { saved = fs.readFileSync(file, "utf8").trim(); } catch (err) {
    if (err.code !== "ENOENT") log(`reading payload channel failed (${err.code}); using stable`);
    return "stable";
  }
  if (saved && saved !== "stable") {
    const label = /^[a-z0-9_-]{1,64}$/i.test(saved) ? saved : JSON.stringify(saved);
    log(`channel ${label} is retired; using stable`);
    try { fs.writeFileSync(file, "stable"); } catch (err) {
      log(`rewriting retired payload channel failed (${err.code}); using stable for this launch`);
    }
  }
  return "stable";
}

function seqOf(build) {
  const m = /^(\d+)\.(\d{1,3})\.(\d{1,3})$/.exec(String(build));
  return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1000 + Number(m[3]) : null;
}

function createPayloadHealth({ root, channel, platform, pulseUrl, stableUrl, verify, runningBuild, report, log, now = Date.now, fetchImpl = (...args) => fetch(...args) }) {
  const stateFile = path.join(root, "update-health.json");
  let state = readJson(stateFile);
  let stable = null;
  let lastLog = null;
  let lastDiagnostic = null;
  const diagnostic = (message) => {
    if (message !== lastDiagnostic) log(message);
    lastDiagnostic = message;
  };
  const persist = (next) => {
    state = next;
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(next));
      fs.renameSync(`${stateFile}.tmp`, stateFile);
    } catch (err) { diagnostic(`persisting payload health failed (${err.code})`); }
  };
  async function observe(res) {
    if (!res.ok) return;
    try {
      const body = await res.clone().json();
      verify(body.signed, body.signature);
      const doc = body.signed;
      if (doc.app !== "zevet" || doc.channel !== "stable" || doc.platform !== platform ||
          seqOf(doc.build) === null || doc.seq !== seqOf(doc.build)) throw new Error("wrong stable pulse identity or sequence");
      stable = doc;
    } catch (err) { diagnostic(`payload health observation failed: ${err.message}`); }
  }
  async function observedFetch(url, options) {
    const res = await fetchImpl(url, options);
    if (channel === "stable" && String(url) === pulseUrl) await observe(res);
    return res;
  }
  function record(payload, result) {
    const current = readJson(path.join(root, "current.json"));
    const running = runningBuild();
    const highSeq = current?.high_seq ?? seqOf(running);
    const status = { status: result.status, build: result.build || null, reason: result.reason || null };
    const key = JSON.stringify([channel, highSeq, status]);
    // Include the floor even when the kit returns only {status:"none"} for a lower-seq pulse.
    if (result.status !== "staged" && key !== lastLog) {
      log(`payload check ${JSON.stringify({ channel, high_seq: highSeq, ...status })}`);
    }
    lastLog = key;
    if (!stable) return;
    const runningSeq = seqOf(running);
    if (runningSeq === null || stable.seq <= runningSeq || payload.staged()) {
      if (state) persist(null);
      return;
    }
    // Continuous lag, not the pulse's publication age. A newer target does not restart the clock.
    if (!state || state.running !== running || !Number.isFinite(state.since) || state.since > now()) {
      persist({ running, since: now(), reported: false });
    }
    if (!state.reported && now() - state.since > DAY_MS) {
      try {
        const sent = report({ channel, high_seq: highSeq, running_build: running, stable_build: stable.build, last_status: status });
        if (sent) persist({ ...state, reported: true });
      } catch (err) { diagnostic(`reporting stuck payload failed: ${err.message}`); }
    }
  }
  return {
    fetch: observedFetch,
    instrument(payload) {
      const check = payload.check.bind(payload);
      payload.check = async (...args) => {
        let result;
        try { result = await check(...args); } catch (err) {
          result = { status: "error", reason: err.message };
          await finish(result);
          throw err; // desktop-kit's existing error logging remains intact
        }
        await finish(result);
        return result;
      };
      async function finish(result) {
        try {
          // Explicit developer channels still need to reveal that stable has left them behind.
          if (channel !== "stable") {
            try { await observe(await fetchImpl(stableUrl, { cache: "no-store", signal: AbortSignal.timeout(10000) })); }
            catch (err) { diagnostic(`stable payload health probe failed: ${err.message}`); }
          }
          record(payload, result);
        } catch (err) { diagnostic(`payload health check failed: ${err.message}`); }
      }
    },
  };
}

module.exports = { resolveChannel, createPayloadHealth, DAY_MS };
