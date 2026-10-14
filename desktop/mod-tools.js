"use strict";
// The tool seam: every `mods/tools/*.js` is an MCP tool agents can call, with no edit to
// zevet-mcp.js (which lists it) or agent-tools.js (which runs it).
//
// `module.exports = { name, description, inputSchema, scope?, run(args, ctx, deps) }`.
//   scope "team" (default) is offered when the desktop is signed in to a team, like the four
//   coordination tools; "always" is offered in every run. `run` executes in the desktop (same
//   process as agent-tools.js, so `deps` is its injected dependencies) and returns a string or
//   `{ text, isError }`. Anything a teammate wrote that `run` returns is DATA: wrap it with
//   asData() from agent-tools.js. A file that is malformed is skipped with a warning, never fatal.
const fs = require("node:fs");
const path = require("node:path");

const TOOLS_DIR = path.join(__dirname, "mods", "tools");
const NAME = /^[a-z][a-z0-9_]{0,63}$/;

function loadModTools({ dir = TOOLS_DIR, reserved = [], log = console } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".js")).sort();
  } catch {
    return [];
  }
  const taken = new Set(reserved);
  const tools = [];
  for (const n of names) {
    try {
      const t = require(path.join(dir, n));
      if (!t || !NAME.test(t.name || "")) throw new Error("name must be lower_snake_case");
      if (taken.has(t.name)) throw new Error(`name "${t.name}" is already taken`);
      if (typeof t.description !== "string" || !t.description) throw new Error("description is required");
      if (!t.inputSchema || t.inputSchema.type !== "object") throw new Error("inputSchema must be an object schema");
      if (typeof t.run !== "function") throw new Error("run(args, ctx, deps) is required");
      if (t.scope !== undefined && t.scope !== "team" && t.scope !== "always") throw new Error('scope must be "team" or "always"');
      taken.add(t.name);
      tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema, scope: t.scope || "team", run: t.run });
    } catch (err) {
      log.warn(`zevet: mods/tools/${n} skipped: ${err.message}`);
    }
  }
  return tools;
}

/** What tools/list shows: the definition without `run` or `scope`. */
const publicDef = ({ name, description, inputSchema }) => ({ name, description, inputSchema });

module.exports = { loadModTools, publicDef, TOOLS_DIR };
