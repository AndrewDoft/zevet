// Wires zevet's hook into one repo's .claude/settings.json, on Windows or macOS.
//
//   node client/install.mjs <repo-path>
//   node client/install.mjs <repo-path> --remove
//
// Existing hooks are preserved; ours are stripped and rewritten every run, so
// installing twice leaves one copy rather than two.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, "hook.mjs");
const MARK = "zevet/client/hook.mjs";
const EVENTS = ["UserPromptSubmit", "PreToolUse", "Stop"];

/**
 * Is this hook entry one of ours?
 *
 * MEASURED BUG, Windows only: this compared `h.command.includes(MARK)` against
 * a command holding `C:\dev\GitHub\zevet\client\hook.mjs`. Backslashes never
 * match a forward-slash marker, so the strip below quietly removed nothing and
 * every re-install stacked another copy of all three hooks — after two runs the
 * board double-counted every tool call. On macOS the same code was correct,
 * which is exactly why it survived: the platform that worked was the one being
 * looked at. Normalise the separators before comparing, always.
 */
function isOurs(entry) {
  if (!entry || typeof entry.command !== "string") return false;
  // Collapse repeated separators too: an earlier version built the command
  // with JSON.stringify and then wrote it inside another JSON.stringify, so
  // the stored command held `C:\\dev\\GitHub\\zevet` with doubled backslashes.
  // It ran anyway — Windows collapses repeated separators — which is how a
  // double-encoded path went unnoticed while quietly defeating this match.
  const norm = entry.command.split("\\").join("/").replace(/\/{2,}/g, "/");
  return norm.includes(MARK);
}

/**
 * Quote a path for the shell Claude Code runs hook commands through.
 *
 * NOT JSON.stringify: that escapes backslashes for JSON, and the result then
 * gets JSON-escaped a second time when the settings file is written. Plain
 * double quotes are what both cmd.exe and sh actually want around a path with
 * a space in it.
 */
function shellQuote(p) {
  if (p.includes('"')) {
    console.error(`zevet: refusing to build a command from a path containing a quote: ${p}`);
    process.exit(1);
  }
  return `"${p}"`;
}

const args = process.argv.slice(2);
const remove = args.includes("--remove");
const repo = path.resolve(args.find((a) => !a.startsWith("--")) || process.cwd());

if (!existsSync(repo)) {
  console.error(`zevet: no such directory: ${repo}`);
  process.exit(1);
}
if (!existsSync(HOOK)) {
  console.error(`zevet: hook not found at ${HOOK}`);
  process.exit(1);
}

const dir = path.join(repo, ".claude");
const file = path.join(dir, "settings.json");
mkdirSync(dir, { recursive: true });

let cfg = {};
if (existsSync(file)) {
  const backup = `${file}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(file, backup);
  console.log(`backed up existing settings -> ${backup}`);
  try {
    cfg = JSON.parse(readFileSync(file, "utf8") || "{}");
  } catch (err) {
    console.error(`zevet: ${file} is not valid JSON (${err.message}). Fix or move it first.`);
    process.exit(1);
  }
}

cfg.hooks = cfg.hooks && typeof cfg.hooks === "object" ? cfg.hooks : {};

// Strip ours first, so install is idempotent and --remove is just
// install-without-the-add. This also clears entries from older versions that
// registered events we no longer use.
let removed = 0;
for (const evt of Object.keys(cfg.hooks)) {
  const groups = Array.isArray(cfg.hooks[evt]) ? cfg.hooks[evt] : [];
  for (const g of groups) {
    if (!Array.isArray(g.hooks)) continue;
    const before = g.hooks.length;
    g.hooks = g.hooks.filter((h) => !isOurs(h));
    removed += before - g.hooks.length;
  }
  cfg.hooks[evt] = groups.filter((g) => Array.isArray(g.hooks) && g.hooks.length > 0);
  if (cfg.hooks[evt].length === 0) delete cfg.hooks[evt];
}

if (!remove) {
  // Quoted so a space in "C:\Program Files" or "/Users/kai/My Code" survives
  // instead of splitting into two arguments.
  const command = `${shellQuote(process.execPath)} ${shellQuote(HOOK)}`;
  for (const evt of EVENTS) {
    const entry = { type: "command", command, timeout: 10 };
    const groups = Array.isArray(cfg.hooks[evt]) ? cfg.hooks[evt] : [];
    // PreToolUse takes a matcher; the prompt and stop events do not.
    groups.push(evt.endsWith("ToolUse") ? { matcher: "*", hooks: [entry] } : { hooks: [entry] });
    cfg.hooks[evt] = groups;
  }
}

writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");

if (remove) {
  console.log(`zevet: removed ${removed} hook entr${removed === 1 ? "y" : "ies"} from ${file}`);
} else {
  console.log(`zevet: installed ${EVENTS.length} hooks into ${file} (replaced ${removed})`);
  console.log(`      node:  ${process.execPath}`);
  console.log(`      hook:  ${HOOK}`);
  console.log("");
  console.log("Set these in your shell, then start Claude Code in that repo:");
  console.log(`      ZEVET_HUB=${process.env.ZEVET_HUB || "http://127.0.0.1:8787"}`);
  console.log("      ZEVET_TOKEN=<the shared secret>");
  console.log(`      ZEVET_ACTOR=${process.env.ZEVET_ACTOR || "your-name"}`);
}
