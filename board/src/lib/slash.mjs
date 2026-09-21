/**
 * The composer's `/` menu: which commands exist, and which of them zevet
 * handles itself.
 *
 * WHERE THE LIST COMES FROM. claude announces every command it will accept —
 * built-ins, skills and plugin commands — as `slash_commands` in its init line
 * (verified against claude 2.1.278, 2026-09-21), and in headless stream-json
 * mode it RUNS them: `/compact`, `/clear` (answered with a `conversation_reset`
 * line) and `/cost` all executed when sent as an ordinary prompt. So for claude
 * the menu is that list and sending is unchanged.
 *
 * codex and opencode announce nothing, and zevet cannot vouch for a command
 * they have not shown it. They get only the commands zevet implements itself.
 *
 * WHY .mjs: the gate runs `node --test` straight against the source tree.
 */

/** What a person is looking at when a command's name is not enough. Only
 *  commands whose behaviour was checked or is unambiguous are described; the
 *  rest show as what they are (a skill, a plugin command). */
const DESCRIPTIONS = {
  clear: "Start over: drop the conversation and its context",
  compact: "Summarise the conversation to free up context",
  context: "Show what is filling the context window",
  cost: "Show usage and spend for this session",
  usage: "Show plan usage and limits",
  model: "Show or change the model",
  effort: "Set how hard the model thinks",
  fast: "Toggle fast mode",
  init: "Create a CLAUDE.md for this repo",
  mcp: "Manage MCP servers",
  config: "Open settings",
  rename: "Rename this session",
  doctor: "Check the installation",
  agents: "Manage subagents",
  recap: "Recap what happened so far",
  "security-review": "Review pending changes for security problems",
  "code-review": "Review code changes",
  simplify: "Review changed code for reuse and simplicity",
  loop: "Run a prompt on a recurring interval",
  schedule: "Create or manage scheduled agents",
};

/** Commands zevet answers itself, for every agent. `claudeToo` = zevet handles
 *  it even for claude (nothing in the CLI does the same thing). */
const LOCAL = [
  { name: "stop", description: "Stop the running agent", local: true, claudeToo: true },
  { name: "new", description: "Start another agent (opens the launcher)", local: true, claudeToo: true },
  // claude runs /clear itself; the others cannot, so zevet ends the run and
  // the next Send starts a fresh one.
  { name: "clear", description: "Start over with a fresh conversation", local: true, claudeToo: false },
];

/** Shown before any console has announced its own list. */
const CLAUDE_FALLBACK = ["clear", "compact", "context", "cost", "usage", "model", "effort", "init", "mcp", "config", "rename", "recap"];

const describe = (name) =>
  DESCRIPTIONS[name] || (name.includes(":") ? `${name.split(":")[0]} plugin` : "");

/**
 * @param {string | null | undefined} agent  the console's agent, or the one the launcher names
 * @param {readonly string[] | undefined} announced  the console's `slashCommands`
 * @returns {{ name: string, description: string, local: boolean }[]}
 */
export function commandsFor(agent, announced) {
  const out = [];
  const seen = new Set();
  const add = (c) => {
    if (seen.has(c.name)) return;
    seen.add(c.name);
    out.push(c);
  };
  const isClaude = agent === "claude";
  for (const c of LOCAL) if (!isClaude || c.claudeToo) add({ name: c.name, description: c.description, local: true });
  if (isClaude) {
    const names = announced && announced.length ? announced : CLAUDE_FALLBACK;
    // Known built-ins first, then the rest alphabetically: a long tail of
    // skills should not bury `/compact`.
    const order = Object.keys(DESCRIPTIONS);
    const known = names.filter((n) => DESCRIPTIONS[n]).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const rest = names.filter((n) => !DESCRIPTIONS[n]).sort();
    for (const n of known.concat(rest)) add({ name: n, description: describe(n), local: false });
  }
  return out;
}

/** The commands a half-typed `/xyz` could mean. Empty unless the whole
 *  composer is one slash token — `/compact focus on tests` is an argument,
 *  and a menu over it would eat the space bar. */
export function matchSlash(text, commands) {
  const m = /^\/([^\s/]*)$/.exec(text || "");
  if (!m) return [];
  const q = m[1].toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const inside = commands.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
  return starts.concat(inside);
}

/** `/name rest` -> the zevet-local command it names, if any. */
export function parseLocal(text, agent) {
  const m = /^\/([^\s/]+)\s*$/.exec((text || "").trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  const hit = LOCAL.find((c) => c.name === name);
  if (!hit) return null;
  if (agent === "claude" && !hit.claudeToo) return null;
  return name;
}
