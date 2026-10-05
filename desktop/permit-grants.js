"use strict";

// "Always allow, for this session" for Claude's own tools.
//
// The rule is deliberately narrow. Claude's permission prompt tool is called
// for EVERY tool use it would otherwise ask about, and "always" that meant
// "any Bash, ever" would be a standing bypass one click away. So a grant is:
//   Bash / PowerShell — that exact command, nothing similar
//   WebFetch          — that host
//   anything else     — that tool name (Edit, Write, MultiEdit, …)
// and it lives in memory, per run (one console process), never on disk.
// ponytail: no prefix rules ("git status *"); add them if exact-match proves
// too chatty in practice.

const SHELLS = new Set(["Bash", "PowerShell"]);
const MAX_KEYED = 3900; // ask-server bodies are clipped at ~4000 chars a field; a clipped command is not a key

/** The identity a grant is remembered under, or null when this request cannot
 *  be safely generalised (so the card offers no "always"). */
function ruleKey(tool, input) {
  if (typeof tool !== "string" || !tool) return null;
  const inp = input && typeof input === "object" ? input : {};
  if (SHELLS.has(tool)) {
    const cmd = typeof inp.command === "string" ? inp.command : "";
    return cmd && cmd.length < MAX_KEYED ? `${tool}\0${cmd}` : null;
  }
  if (tool === "WebFetch") {
    try {
      return `${tool}\0${new URL(String(inp.url)).host}`;
    } catch {
      return null;
    }
  }
  return tool;
}

function createGrants() {
  const byRun = new Map();
  return {
    allows(run, tool, input) {
      const key = ruleKey(tool, input);
      return key !== null && Boolean(byRun.get(run) && byRun.get(run).has(key));
    },
    grant(run, tool, input) {
      const key = ruleKey(tool, input);
      if (key === null) return false;
      if (!byRun.has(run)) byRun.set(run, new Set());
      byRun.get(run).add(key);
      return true;
    },
    forget(run) {
      byRun.delete(run);
    },
  };
}

module.exports = { ruleKey, createGrants };
