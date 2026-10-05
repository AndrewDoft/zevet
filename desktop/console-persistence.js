"use strict";

const fs = require("node:fs");

const FILE = "console-resume.json";
/** All three CLIs resume a session by id (agent-console.js CAN_RESUME). */
const AGENTS = new Set(["claude", "codex", "opencode"]);

function resumable(entry) {
  return Boolean(entry && entry.running && AGENTS.has(entry.agent) && entry.sessionId);
}

function resumableEntries(entries) {
  return entries.filter(resumable).map((e) => ({
    id: e.id, agent: e.agent, cwd: e.cwd || e.root, root: e.root, worktree: e.worktree || null,
    model: e.model || "", mode: e.mode || "auto", engine: e.engine || "", label: e.label || "",
    worktreeRecord: e.worktreeRecord || null, sessionId: String(e.sessionId), inFlight: e.state === "working",
  }));
}

function write(file, entries, writeFileSync = fs.writeFileSync, renameSync = fs.renameSync, mkdirSync = fs.mkdirSync) {
  const temp = `${file}.${process.pid}.tmp`;
  mkdirSync(require("node:path").dirname(file), { recursive: true });
  writeFileSync(temp, JSON.stringify({ version: 1, consoles: resumableEntries(entries) }, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(temp, file);
}

function read(file, readFileSync = fs.readFileSync, unlinkSync = fs.unlinkSync) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(value.consoles) ? value.consoles.filter((e) => e && e.id && e.sessionId && AGENTS.has(e.agent)) : [];
  } catch { return []; }
  finally { try { unlinkSync(`${file}.${process.pid}.tmp`); } catch {} }
}

module.exports = { FILE, AGENTS, resumable, resumableEntries, write, read };
