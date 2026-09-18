// Which coding agents are on this machine, and are they signed in?
//
// The point is that a teammate should not have to tell zevet what they use.
// Andrew runs Claude Code, Michael and Kai run Codex; nobody should be typing
// that into a form.
//
// WHAT THIS KNOWS AND HOW IT KNOWS IT. PATH is the primary mechanism and the
// only one that is portable. The extra directories below are there because
// MEASURED on this machine, two of the three agents are NOT on PATH:
//
//   claude    C:\Users\andre\.local\bin\claude.exe          (on PATH)
//   codex     %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe   (NOT on PATH)
//   opencode  %APPDATA%\npm\opencode.cmd                    (on PATH, .cmd only)
//
// The Codex path contains a build hash, so it is globbed rather than named.
// The macOS equivalents are listed as candidates, not as facts — they are
// unverified on this machine, and `signedIn` reports what was actually found
// rather than asserting a login state it could not check.
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const WIN = process.platform === "win32";

/** Extensions Windows can execute. A .cmd shim still counts as installed. */
const EXE_EXTS = WIN ? [".exe", ".cmd", ".bat", ""] : [""];

function isFile(p) {
  try {
    return existsSync(p) && !statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function onPath(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of EXE_EXTS) {
      const candidate = path.join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** One level of globbing, for install directories named after a build hash. */
function firstUnder(dir, leaf) {
  try {
    for (const entry of readdirSync(dir)) {
      for (const ext of EXE_EXTS) {
        const candidate = path.join(dir, entry, leaf + ext);
        if (isFile(candidate)) return candidate;
      }
    }
  } catch {
    // Directory absent or unreadable: not installed there.
  }
  return null;
}

function firstExisting(candidates) {
  for (const c of candidates) {
    for (const ext of EXE_EXTS) {
      if (isFile(c + ext)) return c + ext;
    }
  }
  return null;
}

const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");

/**
 * The agents zevet knows how to watch.
 *
 * `hooks` says whether zevet can actually instrument it. Claude Code and Codex
 * both have a hook mechanism; opencode is detected and reported so you can see
 * who is running what, but there is no hook contract for it here, and saying
 * so is better than implying coverage that does not exist.
 */
const AGENTS = [
  {
    id: "claude-code",
    label: "Claude Code",
    bin: "claude",
    hooks: true,
    extraPaths: () => [path.join(HOME, ".local", "bin", "claude")],
    // Either file means an account has been set up. Presence only — nothing
    // here ever reads a credential.
    authFiles: () => [path.join(HOME, ".claude", ".credentials.json"), path.join(HOME, ".claude.json")],
  },
  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    // OBSERVED FIRING 2026-09-18 on codex-cli 0.155.0-alpha.2.6. A real turn in
    // C:\dev\GitHub\zevet produced `prompt` and `turn_end` on the live hub,
    // tagged agent=codex. The earlier "never seen to fire" had two causes, both
    // now fixed and both ours:
    //   1. the block was written to <repo>/.codex/config.toml, which Codex does
    //      not read for hooks -- it reads $CODEX_HOME/config.toml;
    //   2. the command named the program as a quoted path with a space
    //      ("C:/Program Files/nodejs/node.exe" -- with backslashes in real life),
    //      and Codex resolves the program from the first whitespace-delimited
    //      token WITHOUT honouring quotes, so it never found node. Spaces in an
    //      ARGUMENT quote fine; only the program name is affected.
    //      quotes, so it never found node.
    //
    // Still `true` with a caveat rather than bare `true`: hooks do not run
    // until hook trust is granted, and `codex exec` neither prompts nor warns.
    // See docs/contracts/codex-hooks.md.
    hooks: true,
    extraPaths: () => [
      path.join(HOME, ".codex", "bin", "codex"),
      path.join(APPDATA, "npm", "codex"),
      "/usr/local/bin/codex",
      "/opt/homebrew/bin/codex",
    ],
    // The Windows installer drops the binary under a build-hash directory.
    globPaths: () => [{ dir: path.join(LOCALAPPDATA, "OpenAI", "Codex", "bin"), leaf: "codex" }],
    authFiles: () => [path.join(HOME, ".codex", "auth.json")],
  },
  {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode",
    hooks: false,
    extraPaths: () => [path.join(APPDATA, "npm", "opencode"), path.join(HOME, ".opencode", "bin", "opencode")],
    authFiles: () => [
      path.join(HOME, ".local", "share", "opencode", "auth.json"),
      path.join(HOME, ".config", "opencode", "auth.json"),
    ],
  },
];

/** Everything found, whether or not it is usable. */
export function detectAgents() {
  return AGENTS.map((a) => {
    let bin = onPath(a.bin);
    let where = bin ? "PATH" : null;

    if (!bin && a.extraPaths) {
      bin = firstExisting(a.extraPaths());
      if (bin) where = "known install location";
    }
    if (!bin && a.globPaths) {
      for (const g of a.globPaths()) {
        bin = firstUnder(g.dir, g.leaf);
        if (bin) {
          where = "known install location";
          break;
        }
      }
    }

    const authFile = (a.authFiles() || []).find((f) => isFile(f)) || null;
    return {
      id: a.id,
      label: a.label,
      installed: Boolean(bin),
      bin,
      foundVia: where,
      // "signed in" is inferred from the presence of the file the CLI writes
      // when an account is configured. It is not a liveness check: a stale or
      // expired credential looks the same from here, and claiming otherwise
      // would be asserting something never verified.
      signedIn: Boolean(authFile),
      authFile,
      hooks: a.hooks,
      /** Can zevet wire it at all? "unverified" still installs. */
      wireable: a.hooks === true || a.hooks === "unverified",
    };
  });
}

/** The ones zevet can actually instrument on this machine. */
export function watchableAgents() {
  return detectAgents().filter((a) => a.installed && a.wireable);
}

// Run directly for a human-readable report: `node client/detect.mjs`
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const found = detectAgents();
  for (const a of found) {
    const state = !a.installed
      ? "not installed"
      : a.signedIn
        ? "installed, signed in"
        : "installed, no account found";
    console.log(`${a.label.padEnd(12)} ${state}`);
    if (a.bin) console.log(`             ${a.bin}  (${a.foundVia})`);
    if (a.installed && !a.hooks) console.log("             zevet can see it, but has no hook contract for it");
    if (a.hooks === "unverified") console.log("             hooks install, but have not been seen to fire — see the note on install");
  }
  const watchable = found.filter((a) => a.installed && a.wireable);
  console.log("");
  console.log(
    watchable.length
      ? `zevet will watch: ${watchable.map((a) => a.label).join(", ")}`
      : "zevet has nothing to watch here — install Claude Code or Codex.",
  );
}
