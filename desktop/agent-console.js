// zevet — starting an agent, not just watching one.
//
// Everything else in zevet observes work that somebody else began. This module
// begins it: it finds the `claude`, `codex` or `opencode` binary on this machine,
// spawns it in headless streaming mode, and turns its stdout into a line of
// events the UI can render. It runs in the ELECTRON MAIN PROCESS, on the user's
// own machine, with the user's own credentials — no part of this is reachable
// from the board window, which is a remote origin with no preload and no Node
// (see main.js).
//
// The whole file is shaped by five facts that were MEASURED on Windows, not
// remembered. Each one is documented at the place it forces a decision, because
// every one of them looks like a pointless detour until it bites:
//
//   1. Node refuses to spawn a `.cmd`/`.bat` without a shell, and it refuses by
//      THROWING SYNCHRONOUSLY, not by emitting an `error` event. (§ startConsole)
//   2. `cmd /d /s /c` needs the doubled-quote form, and needs
//      `windowsVerbatimArguments`. Both, not either. (§ buildShimInvocation)
//   3. The Codex install directory is a set of build hashes, and not all of them
//      contain codex. (§ knownLocations)
//   4. `codex exec` reads its prompt from stdin and waits for EOF, which makes
//      it one-shot in a way `claude -p` is not. (§ send)
//   5. `opencode run` does the same: with stdin held open it prints nothing
//      until EOF, then runs and exits 0 — one prompt per process, like codex.
//      With no message argument it reads the prompt from stdin, which is what
//      keeps user text off argv. (§ send, § invocationFor)
//
// SECURITY POSTURE. A user-typed prompt NEVER becomes an argv element, on any
// platform, by any path. Prompts go on stdin, always. That is not a stylistic
// preference: on the `.cmd` fallback the argument vector is re-parsed by
// cmd.exe, where `&` starts a new command, and a prompt is by definition
// attacker-shaped text if the user pastes something they were given. Keeping
// prompts off argv means the shell-quoting question never has to be answered
// correctly for untrusted data — only for our own fixed flags.

"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const IS_WINDOWS = process.platform === "win32";

/** The only agents this module knows how to drive. Not a lookup table to be
 *  extended casually: each entry below encodes flags that were read off the
 *  installed CLI's own `--help`, and inventing a fourth entry from memory is
 *  exactly the failure this project bans. */
const AGENTS = ["claude", "codex", "opencode"];

// Extensions Windows can hand straight to CreateProcess. PATHEXT also lists
// .BAT/.CMD/.VBS/.JS and friends, but those are not executables — they are
// documents that need an interpreter, which is the entire reason for the
// mitigation in fact (1). So this list is deliberately NOT derived from PATHEXT.
const DIRECT_EXTS = IS_WINDOWS ? [".exe", ".com"] : [""];

// Extensions that only a shell can start. Windows-only by construction.
const SHIM_EXTS = IS_WINDOWS ? [".cmd", ".bat"] : [];

// ---------------------------------------------------------------------------
// Finding the binary
// ---------------------------------------------------------------------------

/** True if `file` is a regular file we could plausibly execute.
 *
 *  On POSIX this asks the OS (X_OK); on Windows the execute bit is not a thing
 *  that means anything, so being a file with the right extension IS the test. */
function isRunnableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
  } catch {
    // Missing, or a dangling link, or a directory we cannot stat. All of those
    // mean "not this one" and none of them is worth reporting: resolveAgent is
    // a search, and a candidate that is not there is the normal case.
    return false;
  }
  if (IS_WINDOWS) return true;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    // Present but not executable — a real condition (a partial npm install
    // leaves these behind), and still just "not this one" for search purposes.
    return false;
  }
}

/** Directories on PATH, in order, with the empties dropped.
 *
 *  An empty PATH entry means "the current directory" to some shells. We drop it
 *  rather than honour it: resolving an agent binary out of whatever cwd the user
 *  happens to have open is a way to run a repo's `claude.exe` instead of theirs. */
function pathDirs() {
  const raw = process.env.PATH || process.env.Path || "";
  return raw.split(path.delimiter).filter((d) => d && d.trim());
}

/**
 * Directories that are NOT on PATH but do hold these binaries on real machines.
 *
 * MEASURED, 2026-09-18, on the Windows dev machine this feature was built for:
 *
 *   %LOCALAPPDATA%\OpenAI\Codex\bin\ contained TWO build-hash directories:
 *     52366fb4fdb365a8\  -> rg.exe only
 *     eab8377aebac6c07\  -> codex.exe, codex-command-runner.exe, and others
 *
 * That is fact (3), and it is why this globs the level and then TESTS EACH
 * DIRECTORY for the binary, rather than taking the first one it finds. "Glob one
 * level and use that directory" would have picked the ripgrep directory roughly
 * half the time, depending on readdir order, and failed with "codex not found"
 * on a machine where codex is plainly installed.
 *
 * Neither codex nor its directory was on PATH at all (`where codex` found
 * nothing), so without this list codex is simply unavailable on that machine.
 */
function knownLocations(name) {
  const home = os.homedir();
  const dirs = [];

  if (name === "claude") {
    // The native installer's target. `where claude` resolved to exactly this on
    // the dev machine, so it is usually also on PATH — but it is listed here so
    // that a user whose shell PATH differs from Electron's inherited PATH (a
    // very common macOS and Windows GUI-launch difference) still gets a hit.
    dirs.push(path.join(home, ".local", "bin"));
  }

  if (name === "codex" && IS_WINDOWS) {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const codexBin = path.join(localAppData, "OpenAI", "Codex", "bin");
    try {
      for (const entry of fs.readdirSync(codexBin, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(path.join(codexBin, entry.name));
      }
    } catch {
      // Codex is not installed, or the layout changed. Either way there is
      // nothing here to add and the PATH search still gets its turn.
    }
  }

  if (name === "opencode") {
    // MEASURED 2026-09-19: `where opencode` resolves to %APPDATA%\npm\opencode.cmd
    // (an npm shim — fact 1 applies, so this usually goes down the shell path).
    // The extra locations mirror client/detect.mjs.
    if (IS_WINDOWS) {
      const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
      dirs.push(path.join(appData, "npm"));
    }
    dirs.push(path.join(home, ".opencode", "bin"));
  }

  if (!IS_WINDOWS) {
    // GUI-launched apps on macOS inherit a minimal PATH that frequently omits
    // both of these, which is why a CLI that works in Terminal "disappears"
    // inside an Electron app. Homebrew on Apple silicon is the usual casualty.
    dirs.push("/usr/local/bin", "/opt/homebrew/bin", path.join(home, ".local", "bin"));
  }

  return dirs;
}

/**
 * Locate an agent CLI.
 *
 * Returns { ok:true, file, kind } where `kind` is:
 *   "direct" — a real executable; spawn it with shell:false. Always preferred.
 *   "shim"   — a .cmd/.bat; can only be started through cmd.exe (fact 1).
 *
 * DIRECT WINS EVEN IF A SHIM COMES FIRST ON PATH. The search is done in two
 * complete passes rather than one, precisely so that a `claude.cmd` sitting in
 * an npm bin directory early on PATH cannot force us down the shell path when a
 * `claude.exe` exists further along. The shell path is strictly more dangerous,
 * so it is strictly a last resort.
 */
function resolveAgent(name) {
  if (typeof name !== "string" || !AGENTS.includes(name)) {
    return {
      ok: false,
      error: `Unknown agent ${JSON.stringify(name)}. zevet can start: ${AGENTS.join(", ")}.`,
    };
  }

  const dirs = [...pathDirs(), ...knownLocations(name)];
  const searched = [];

  // Pass 1: directly executable files.
  for (const dir of dirs) {
    for (const ext of DIRECT_EXTS) {
      const file = path.join(dir, name + ext);
      searched.push(file);
      if (isRunnableFile(file)) return { ok: true, file, kind: "direct" };
    }
  }

  // Pass 2: shims. On POSIX SHIM_EXTS is empty, so this loop does nothing and
  // the shell path is unreachable off Windows — which is correct, since the
  // mitigation this works around is Windows-only.
  for (const dir of dirs) {
    for (const ext of SHIM_EXTS) {
      const file = path.join(dir, name + ext);
      searched.push(file);
      if (isRunnableFile(file)) return { ok: true, file, kind: "shim" };
    }
  }

  return {
    ok: false,
    error:
      `Could not find ${name} on this machine. Looked in ${dirs.length} ` +
      `director${dirs.length === 1 ? "y" : "ies"} (PATH plus the usual install ` +
      `locations) across ${searched.length} candidate paths. If it is installed ` +
      `somewhere unusual, add its folder to PATH and restart zevet.`,
  };
}

// ---------------------------------------------------------------------------
// The .cmd fallback, and its guard rail
// ---------------------------------------------------------------------------

// Characters that change the MEANING of a cmd.exe command line rather than
// being data in it. A quote ends our quoting; & | < > start or redirect
// commands; ^ escapes; a newline or carriage return ends the line entirely;
// % and ! expand variables (%USERPROFILE%, and !VAR! under delayed expansion),
// which is not injection but is a way to leak the environment into an argument.
//
// In practice NOTHING we build should ever contain one of these: the argument
// vectors below are fixed literal flags, and a user's prompt never reaches argv
// at all. This check exists to make that a checked invariant rather than a
// claim — if a future edit routes text onto argv, it fails loudly here instead
// of quietly becoming a shell injection on the one platform that has a shell in
// the loop.
const CMD_METACHARACTERS = /["&|<>^\r\n%!]/;

function unsafeForCmd(parts) {
  return parts.filter((p) => CMD_METACHARACTERS.test(p));
}

/**
 * Build the cmd.exe invocation for a shim.
 *
 * MEASURED, 2026-09-18, Node v24.17.0 on Windows 11, against a `.cmd` in a
 * directory whose name contains a space. This is fact (2), and BOTH halves of
 * it were observed failing:
 *
 *   doubled quotes + windowsVerbatimArguments  -> exit 0, "GOT:[hello world]"
 *   single quotes  + windowsVerbatimArguments  -> exit 1, "'C:\...\dir' is not
 *                                                  recognized as an internal or
 *                                                  external command"
 *   doubled quotes + NO verbatim               -> exit 1, "The network path was
 *                                                  not found."
 *
 * Why the doubled pair: `/s` tells cmd to strip the outermost pair of quotes
 * from the rest of the line and treat what remains verbatim. With a single
 * pair, the pair that gets stripped is the one protecting the path, which then
 * splits at the space — the second line above, exactly.
 *
 * Why verbatim: without it Node applies its own MSVCRT-style quoting to the
 * argument before handing it to CreateProcess, which mangles the line we so
 * carefully built. The third result above is what that mangling looks like from
 * cmd's side — it read the leading backslashes as the start of a UNC path.
 */
function buildShimInvocation(file, args) {
  const quoted = [file, ...args].map((p) => `"${p}"`).join(" ");
  return {
    command: "cmd.exe",
    // /d skips any AutoRun command out of the registry — otherwise a machine
    // with a HKCU\...\Command Processor\AutoRun value runs it before our agent
    // and can pollute or hijack stdout.
    args: ["/d", "/s", "/c", `"${quoted}"`],
    options: { windowsVerbatimArguments: true },
  };
}

// ---------------------------------------------------------------------------
// Agent invocations
// ---------------------------------------------------------------------------

/**
 * The argv for each agent, in headless streaming mode.
 *
 * Every flag below was read off the installed CLI's own `--help` in the session
 * that wrote this file. None is remembered, and none is guessed.
 *
 * claude (`claude --help`): -p/--print, --input-format, --output-format,
 *   --verbose, --include-partial-messages and --replay-user-messages all exist
 *   and are documented as requiring --print and stream-json.
 *
 * codex (`codex exec --help`, codex-cli 0.155.0-alpha.2.6):
 *   --json prints "events to stdout as JSONL"; --skip-git-repo-check allows
 *   running outside a git repo; and the PROMPT argument documents itself as
 *   "If not provided as an argument (or if `-` is used), instructions are read
 *   from stdin."
 *
 *   The trailing `-` is therefore the supported, documented way to keep the
 *   prompt off argv. It is NOT an invented flag — it is the CLI's own spelling
 *   of "read it from stdin", and it is what makes codex usable here at all.
 */
/**
 * Model and permission posture, per agent.
 *
 * EVERY FLAG BELOW WAS READ OFF `--help` ON THIS MACHINE, not remembered:
 *
 *   claude   --model <m>
 *            --permission-mode  acceptEdits | auto | bypassPermissions
 *                               | manual | dontAsk | plan
 *            --dangerously-skip-permissions
 *   codex    -m/--model <m>
 *            -s/--sandbox  read-only | workspace-write | danger-full-access
 *            --approve-for-me
 *            --dangerously-bypass-approvals-and-sandbox
 *   opencode run -m/--model <provider/model>
 *            --format default | json
 *            --auto (auto-approve permissions not explicitly denied)
 *            --dir <directory>
 *
 * `opencode run --help` (measured 2026-09-19) has no sandbox, no plan mode
 * and no full bypass: `--auto` is the strongest posture it offers. The mapping
 * below is lossy in both new directions and says so to the caller rather than
 * hiding it: `plan`/`ask` are opencode's default permission behaviour, `auto`
 * and `dangerous` are both `--auto`, with `dangerous` carrying a note that
 * explicit denies still hold.
 *
 * zevet offers four postures because three CLIs with different vocabularies
 * should not make the person translate. The mapping is lossy in one direction
 * and that is stated rather than hidden: codex has no "plan" mode, so `plan`
 * falls back to its most restrictive sandbox and says so to the caller.
 */
const MODES = {
  plan: {
    label: "Plan only",
    claude: ["--permission-mode", "plan"],
    codex: ["--sandbox", "read-only"],
    codexNote: "codex has no plan mode; using its read-only sandbox instead",
    opencode: [],
    opencodeNote: "opencode run has no plan mode; using its default permission behaviour",
  },
  ask: {
    label: "Ask first",
    claude: ["--permission-mode", "manual"],
    codex: ["--sandbox", "workspace-write"],
    opencode: [],
  },
  auto: {
    label: "Auto",
    claude: ["--permission-mode", "acceptEdits"],
    // MEASURED 2026-09-24, codex-cli 0.155.0-alpha.9.2: --approve-for-me carries the
    // workspace-write sandbox itself and exits 2 if --sandbox is also given.
    codex: ["--approve-for-me"],
    opencode: ["--auto"],
  },
  dangerous: {
    label: "Skip permissions",
    claude: ["--dangerously-skip-permissions"],
    codex: ["--dangerously-bypass-approvals-and-sandbox"],
    opencode: ["--auto"],
    opencodeNote: "opencode has no full bypass; --auto still honours explicit denies",
  },
};

function modeFlags(agent, mode) {
  const m = MODES[mode];
  if (!m) return { flags: [], note: null };
  const flags = (agent === "claude" ? m.claude : agent === "opencode" ? m.opencode : m.codex).slice();
  const note =
    agent === "codex" ? m.codexNote || null : agent === "opencode" ? m.opencodeNote || null : null;
  return { flags, note };
}

/**
 * Asking again from a run that already happened.
 *
 * MEASURED 2026-09-21 against claude 2.1.278 and codex-cli 0.155.0-alpha.2.6:
 *
 *   claude --resume <session-id> --fork-session     (--fork-session needs --resume)
 *   codex exec fork <session-id> [PROMPT]           (a subcommand, before the flags)
 *   codex exec resume <session-id> [PROMPT]
 *
 * FORK, NOT RESUME, is what the board offers. Resuming writes more history
 * into the same session, so a second answer would overwrite the first and
 * there would be nothing to compare; forking leaves the original where it is
 * and starts a branch, which is the only shape in which "ask again" and
 * "step between the answers" are both honest.
 *
 * opencode has neither, and is not offered one.
 */
const CAN_FORK = new Set(["claude", "codex"]);

/**
 * Carrying a conversation on, for the two that cannot.
 *
 * MEASURED 2026-09-21. claude keeps stdin open and takes as many prompts as
 * you send it. codex and opencode close it after one — which is why the
 * composer used to refuse a second prompt to those two, and that refusal was
 * honest: the text would have gone to a closed pipe.
 *
 * It is no longer the only option. Both can RESUME a session by id, so a
 * follow-up is a new process that picks the conversation up where it stopped:
 *
 *   claude   --resume <session-id>            (without --fork-session)
 *   codex    exec resume <session-id> [PROMPT]
 *   opencode run -s <session-id>
 *
 * RESUME, NOT FORK, is the difference that matters here. A fork starts a
 * branch and leaves the original alone, which is what "ask that again" wants.
 * A follow-up is the same conversation continuing, so it appends — and the
 * agent keeps everything it already read.
 *
 * All three report a session id, each spelling it differently: claude
 * `session_id`, codex `thread_id`, opencode `sessionID` on every event.
 */
const CAN_RESUME = new Set(["claude", "codex", "opencode"]);

/**
 * `codex exec resume` takes neither --sandbox nor --approve-for-me (measured
 * 2026-09-24, codex-cli 0.155.0-alpha.9.2: exit 2, "unexpected argument"); it
 * takes -m, --dangerously-bypass-approvals-and-sandbox and -c key=value. So the
 * postures become the config keys those flags set. The value is left a bare
 * string, which codex reads as a literal when it is not TOML, so no quote ever
 * reaches a cmd.exe shim's argv.
 */
function resumeSafe(extra) {
  const out = [];
  for (let i = 0; i < extra.length; i++) {
    if (extra[i] === "--sandbox") out.push("-c", `sandbox_mode=${extra[++i]}`);
    else if (extra[i] === "--approve-for-me") out.push("-c", "sandbox_mode=workspace-write", "-c", "approval_policy=never");
    else out.push(extra[i]);
  }
  return out;
}

function invocationFor(agent, opts) {
  const o = opts || {};
  const extra = [];
  // A model is only passed when one was chosen; the CLI's own default is a
  // better answer than a value zevet guessed.
  if (typeof o.model === "string" && o.model.trim()) extra.push(agent === "claude" ? "--model" : "-m", o.model.trim());
  extra.push(...modeFlags(agent, o.mode).flags);

  const forkFrom =
    typeof o.forkFrom === "string" && o.forkFrom.trim() && CAN_FORK.has(agent) ? o.forkFrom.trim() : null;
  const resumeFrom =
    !forkFrom && typeof o.resumeFrom === "string" && o.resumeFrom.trim() && CAN_RESUME.has(agent)
      ? o.resumeFrom.trim()
      : null;

  if (agent === "claude") {
    // Standing instructions for this repo, if the person set any. claude is
    // the only one of the three with a flag for it; see desktop/main.js's
    // `local:agentSettings`, which is where the text comes from.
    if (typeof o.systemPrompt === "string" && o.systemPrompt.trim()) {
      extra.push("--append-system-prompt", o.systemPrompt.trim());
    }
    // zevet's own MCP server, when the console was started with a capability
    // that needs it. A path, written by main.js for this console only.
    if (typeof o.mcpConfig === "string" && o.mcpConfig.trim()) {
      extra.push("--mcp-config", o.mcpConfig.trim());
    }
    // The tool claude calls when it wants permission. Without it a headless
    // run denies anything that would prompt; with it, the board is asked and
    // the agent genuinely waits for the answer.
    if (typeof o.permissionTool === "string" && o.permissionTool.trim()) {
      extra.push("--permission-prompt-tool", o.permissionTool.trim());
    }
    return [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      /* ⚠️ NO --include-partial-messages. It makes claude wrap every raw SSE
       * event in a `stream_event` payload, and zevet has never had a reader
       * for one: each arrived at transcript.mjs's "unknown but real" branch
       * and was printed as the literal text `[claude: stream_event]` INTO THE
       * ASSISTANT'S MESSAGE. Measured in the running app 2026-09-21 — a
       * one-sentence question answered with dozens of them, and nothing else.
       *
       * Asking for them buys nothing either way: the same content arrives
       * complete as an `assistant` payload PER CONTENT BLOCK, which is what
       * the board renders and what it rendered before this flag was added.
       * The partials would only be useful token-by-token, and using them that
       * way means de-duplicating against the block that follows. */
      "--replay-user-messages",
      ...(forkFrom ? ["--resume", forkFrom, "--fork-session"] : resumeFrom ? ["--resume", resumeFrom] : []),
      ...extra,
    ];
  }
  if (agent === "opencode") {
    // MEASURED 2026-09-19: `opencode run -m <model> --format json` with no
    // message argument reads the prompt from stdin and emits one JSON object
    // per line ({type:"step_start"|"text"|"tool_use"|"step_finish"|"error"}).
    // No trailing prompt argument: the prompt goes on stdin (§ send), so user
    // text never reaches argv and the shim-shell check below stays trivially
    // clean.
    // `-s <id>` continues that session; without it opencode starts a new one.
    return ["run", "--format", "json", ...(resumeFrom ? ["-s", resumeFrom] : []), ...extra];
  }
  // codex. The trailing `-` must stay last: it is the positional PROMPT arg.
  //
  // `fork` is a SUBCOMMAND and takes the session id as its first positional,
  // so it goes immediately after `exec` — before the flags and before the `-`,
  // which is still the prompt and still last.
  if (forkFrom) return ["exec", "fork", forkFrom, "--skip-git-repo-check", "--json", ...extra, "-"];
  if (resumeFrom) return ["exec", "resume", resumeFrom, "--skip-git-repo-check", "--json", ...resumeSafe(extra), "-"];
  return ["exec", "--skip-git-repo-check", "--json", ...extra, "-"];
}

/**
 * Turn a prompt into the bytes that agent expects on stdin.
 *
 * claude's stream-json input is one JSON object per line, in the user-message
 * shape. THE TRAILING NEWLINE IS LOAD-BEARING: the CLI reads stdin line by
 * line, so a prompt written without it sits in the CLI's buffer indefinitely
 * and the UI shows an agent that accepted the work and never started it —
 * indistinguishable from a hang, and the most expensive kind of bug to chase
 * because nothing has failed.
 *
 * codex takes the prompt as plain text, because `-` means "the prompt IS
 * stdin". There is no envelope to put it in.
 *
 * opencode takes the prompt as plain text for the same reason: with no message
 * argument, `run` reads stdin to EOF as the prompt (fact 5).
 */
function encodePrompt(agent, text) {
  if (agent === "claude") {
    return (
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      }) + "\n"
    );
  }
  return text.endsWith("\n") ? text : text + "\n";
}

// ---------------------------------------------------------------------------
// Line buffering
// ---------------------------------------------------------------------------

/**
 * Split a byte stream into lines across arbitrary chunk boundaries.
 *
 * A pipe hands you whatever happened to be in the kernel buffer. A single JSON
 * object routinely arrives as three chunks, and two objects routinely arrive as
 * one. Parsing per-chunk instead of per-line is the classic way to get a stream
 * reader that works on a developer's machine and corrupts under load, so this
 * keeps a remainder and only ever emits complete lines.
 */
function makeLineSplitter(onLine) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let cut;
      while ((cut = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, cut).replace(/\r$/, "");
        buffer = buffer.slice(cut + 1);
        if (line.length) onLine(line);
      }
    },
    /** Called at exit: a process that dies mid-line still said something. */
    flush() {
      const rest = buffer.replace(/\r$/, "");
      buffer = "";
      if (rest.length) onLine(rest);
    },
  };
}

// ---------------------------------------------------------------------------
// Killing it
// ---------------------------------------------------------------------------

/**
 * Kill the whole process tree.
 *
 * Both agents spawn children — that is their job; they run builds and tests.
 * `child.kill()` signals only the process we started, so on Windows the
 * grandchildren are reparented and keep running, holding file locks and burning
 * tokens with nothing left to display their output. `taskkill /T` walks the
 * tree; `/F` is needed because a console app that is mid-syscall will not
 * otherwise go.
 *
 * On POSIX the same problem is solved by spawning detached (which makes the
 * child a process-group leader) and signalling the negative pid, which delivers
 * to every member of the group.
 */
function killTree(child, spawnFn) {
  const pid = child.pid;

  if (IS_WINDOWS) {
    if (typeof pid !== "number") {
      // No pid means it never really started; there is no tree to walk.
      try {
        child.kill();
      } catch (err) {
        return { ok: false, error: `kill failed: ${err.message}` };
      }
      return { ok: true };
    }
    try {
      // taskkill.exe is a genuine executable, so this is a direct spawn and
      // needs no shell — fact (1) does not apply to it.
      const killer = spawnFn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      // taskkill failing is not worth crashing over (the usual reason is that
      // the tree already exited and there is nothing left to kill), but it is
      // worth not letting an EventEmitter rethrow an unhandled 'error'.
      if (killer && typeof killer.on === "function") killer.on("error", () => {});
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `taskkill could not be started: ${err.message}` };
    }
  }

  try {
    process.kill(-pid, "SIGTERM");
    return { ok: true };
  } catch (err) {
    // ESRCH means the group is already gone, which is the outcome we wanted.
    if (err && err.code === "ESRCH") return { ok: true };
    try {
      child.kill("SIGTERM");
      return { ok: true };
    } catch (inner) {
      return { ok: false, error: `kill failed: ${inner.message}` };
    }
  }
}

// ---------------------------------------------------------------------------
// startConsole
// ---------------------------------------------------------------------------

/**
 * Start an agent and stream it.
 *
 * Returns { ok:true, id, stop, send } or { ok:false, error }. It does not
 * throw — see fact (1) below for why that is an active decision rather than a
 * sentiment.
 *
 * opts.spawn — INJECTABLE BY DESIGN, not a testing hack.
 *   The alternative is a test suite that can only be run by someone who is
 *   logged in to both vendors and willing to spend their own quota on every
 *   `npm test`. That suite would be run rarely and trusted anyway, which is the
 *   worst of both. With a fake process we can drive the parts that are actually
 *   ours — chunk-boundary buffering, malformed JSON, double stop, spawn failure
 *   — deterministically, offline, for free, on a machine with no agent
 *   installed at all. The seam is the product of that requirement.
 *
 * opts.env — passed straight through to BOTH spawn sites below as the
 *   child's environment. Omitted (undefined), the child inherits
 *   process.env exactly as it always has. The caller (desktop/main.js) is
 *   what decides whether to pass `{...process.env, ANTHROPIC_API_KEY: key}` —
 *   this function has no opinion and does no fetching of its own.
 *
 * onEvent receives, in order of arrival:
 *   { type:"agent",       payload }   a parsed JSONL object from the agent
 *   { type:"stdout-line", line }      a stdout line that was not JSON
 *   { type:"stderr",      text }      raw stderr, unbuffered and unparsed
 *   { type:"exit",        code, signal, error?, stopped? }  exactly once, ever
 *                                    (`stopped`: we killed it — see stop())
 *
  * All three emit JSONL on stdout in the modes used here (claude via
  * --output-format stream-json, codex via --json, opencode via --format json,
  * all read off their own --help), so all three get "agent" events. Anything
  * that is not JSON is still
  * delivered, as "stdout-line" — never dropped and never thrown.
  */
function startConsole(opts) {
  const options = opts || {};
  const agent = options.agent;
  const onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
  const spawnFn = typeof options.spawn === "function" ? options.spawn : childProcess.spawn;

  const resolved = resolveAgent(agent);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  // Zevet Chat hands its own argv (desktop/chat.js § chatArgs); everything
  // below — the shim check, the spawn, the line splitting — still applies.
  const args = Array.isArray(options.args) ? options.args : invocationFor(agent, opts);

  // The invariant from CMD_METACHARACTERS, checked. On the shim path these
  // strings are about to be re-parsed by a shell, so anything that could change
  // the command's meaning must stop the launch rather than be escaped — we
  // would rather tell the user we refuse than get the escaping subtly wrong.
  if (resolved.kind === "shim") {
    const bad = unsafeForCmd([resolved.file, ...args]);
    if (bad.length) {
      return {
        ok: false,
        error:
          `Refusing to start ${agent}: it is only installed as a .cmd shim, which ` +
          `must go through cmd.exe, and ${bad.length} of the values involved ` +
          `contain shell metacharacters (${bad.map((b) => JSON.stringify(b)).join(", ")}). ` +
          `Starting it would risk running something other than what was asked for.`,
      };
    }
  }

  // --- spawn -------------------------------------------------------------
  //
  // FACT (1), MEASURED 2026-09-18 on Node v24.17.0 / Windows 11: spawning a
  // `.cmd` with shell:false does NOT emit an 'error' event. It throws
  // synchronously, out of child_process.spawn, with:
  //
  //     Error: spawn EINVAL  { errno: -4071, code: 'EINVAL', syscall: 'spawn' }
  //
  // That is the CVE-2024-27980 mitigation: Node will not hand a batch file to
  // CreateProcess, because the command line is re-parsed by cmd.exe and argument
  // escaping cannot be made safe. The consequence for this function is that a
  // try/catch is mandatory and an 'error' listener is not sufficient — a caller
  // in the Electron main process would otherwise take an uncaught exception and
  // lose the window, on nothing worse than a user who installed via npm.
  let child;
  try {
    if (resolved.kind === "shim") {
      const inv = buildShimInvocation(resolved.file, args);
      child = spawnFn(inv.command, inv.args, {
        cwd: options.cwd,
        // undefined when the caller did not supply one, which node treats the
        // same as omitting the option entirely: the child inherits
        // process.env, exactly as it did before this existed.
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...inv.options,
      });
    } else {
      child = spawnFn(resolved.file, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // POSIX only: become a process-group leader so stop() can signal the
        // whole group. On Windows `detached` means "own console window", which
        // is not what we want, and windowsHide above suppresses it anyway.
        detached: !IS_WINDOWS,
        shell: false,
      });
    }
  } catch (err) {
    return {
      ok: false,
      error: `Could not start ${agent} (${resolved.file}): ${err && err.message ? err.message : String(err)}`,
    };
  }

  if (!child) {
    return { ok: false, error: `Could not start ${agent}: spawn returned nothing.` };
  }

  const id = randomUUID();
  let exited = false;
  let stopped = false;
  // Set before the kill, not after: taskkill /F ends the process with code 1,
  // which without this reads as a crash and draws an error under a turn the
  // person stopped themselves, or that a follow-up replaced.
  let killing = false;

  const stdout = makeLineSplitter((line) => {
    // Defensive by contract: a line that is not JSON is DATA, not an error.
    // All three CLIs print human-readable notices to stdout in some conditions
    // (update banners, auth prompts), and a stream reader that throws on the
    // first one is a stream reader that dies on a Tuesday.
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      onEvent({ type: "stdout-line", line });
      return;
    }
    // A bare JSON scalar — `null`, `7`, `"hi"` — parses fine but is not an
    // event object, and passing it on as one would hand the UI something it
    // cannot render. Treated as a line, which is what it looks like.
    if (payload === null || typeof payload !== "object") {
      onEvent({ type: "stdout-line", line });
      return;
    }
    onEvent({ type: "agent", payload });
  });

  /** `exit` is emitted at most once. Node can fire both 'error' and 'close' for
   *  one failed spawn, and a UI that gets two exits for one console shows a
   *  session ending twice. */
  function emitExit(payload) {
    if (exited) return;
    exited = true;
    stdout.flush();
    onEvent({ type: "exit", ...payload });
  }

  if (child.stdout) {
    if (typeof child.stdout.setEncoding === "function") child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stdout.on("error", (err) => {
      onEvent({ type: "stderr", text: `[zevet] stdout stream error: ${err.message}\n` });
    });
  }

  if (child.stderr) {
    if (typeof child.stderr.setEncoding === "function") child.stderr.setEncoding("utf8");
    // stderr is NOT line-split or parsed. It is diagnostics: progress bars,
    // partial lines and ANSI, none of which survives being cut at newlines.
    child.stderr.on("data", (chunk) => onEvent({ type: "stderr", text: String(chunk) }));
    child.stderr.on("error", (err) => {
      onEvent({ type: "stderr", text: `[zevet] stderr stream error: ${err.message}\n` });
    });
  }

  // The ASYNCHRONOUS spawn failure — a binary that resolved but could not be
  // executed (deleted between resolve and spawn, or not really executable).
  // Unlike fact (1) this one does arrive as an event, and an EventEmitter with
  // no 'error' listener rethrows, which in the main process is fatal. So it is
  // caught here and reported down the same channel as any other ending.
  child.on("error", (err) => {
    emitExit({ code: null, signal: null, error: err && err.message ? err.message : String(err) });
  });

  child.on("exit", (code, signal) => emitExit({ code, signal, ...(killing ? { stopped: true } : {}) }));

  // stdin breaks when the agent exits while we are mid-write. That is an EPIPE
  // and it is expected, not exceptional; swallowing it here is not a bare catch
  // that hides a failure, because the death it signals is reported by the exit
  // event above — this only stops the stream rethrowing it a second time.
  if (child.stdin && typeof child.stdin.on === "function") child.stdin.on("error", () => {});

  return {
    ok: true,
    id,

    /**
     * Send a prompt. The text goes on STDIN, never on argv.
     *
     * FACT (4), MEASURED 2026-09-18 against codex-cli 0.155.0-alpha.2.6: with
     * `codex exec --skip-git-repo-check --json -` and stdin held OPEN, codex
     * produced zero bytes on both stdout and stderr for four seconds. It is
     * waiting for EOF, because `-` means "the prompt is the whole of stdin".
     * (That measurement was taken with stdin never closed, deliberately, so
     * that no turn was ever submitted and no quota was spent.)
     *
     * FACT (5), MEASURED 2026-09-19 against the installed opencode: `opencode
     * run -m <model> --format json` with stdin held open likewise prints
     * nothing; ending stdin submits the prompt, emits
     * step_start/text/tool_use/step_finish JSONL, and exits 0.
     *
     * So codex and opencode are ONE-SHOT: the prompt must be followed by
     * end-of-stream, and there is no second prompt for that process. A
     * follow-up means a new console. claude, by contrast, reads stream-json
     * line by line and stays open for as many prompts as you send it.
     *
     * This asymmetry is reported honestly to the caller rather than papered
     * over with a queue that would silently never deliver.
     */
    send(text) {
      if (typeof text !== "string" || !text.length) {
        return { ok: false, error: "Nothing to send." };
      }
      if (exited) return { ok: false, error: "That agent has already exited." };
      if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
        return {
          ok: false,
          error:
            agent === "codex"
              ? "codex takes one prompt per run and its input is already closed. Start a new console to continue."
              : agent === "opencode"
                ? "opencode takes one prompt per run and its input is already closed. Start a new console to continue."
                : "That agent's input is closed.",
        };
      }
      try {
        child.stdin.write(encodePrompt(agent, text));
        // See facts (4) and (5): for codex and opencode the prompt is not
        // submitted until EOF.
        if (agent === "codex" || agent === "opencode") child.stdin.end();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: `Could not send to ${agent}: ${err.message}` };
      }
    },

    /**
     * Stop the agent and everything it started.
     *
     * Idempotent on purpose: the UI calls this from a button, from window close,
     * and from app quit, and those overlap routinely. A second call after the
     * tree is already gone must be a no-op, not a throw and not a second
     * taskkill against a pid that may by then belong to somebody else.
     */
    stop() {
      if (stopped) return { ok: true, alreadyStopped: true };
      if (exited) {
        stopped = true;
        return { ok: true, alreadyStopped: true };
      }
      /* NOTE: `stopped` is NOT set here. It used to be, one line above the
         kill attempt, which made a FAILED kill permanent: killTree returning
         {ok:false} — taskkill not spawnable, or process.kill failing for
         anything other than ESRCH — left `stopped` true, so the button, the
         window close and app quit all short-circuited to
         {ok:true, alreadyStopped:true} from then on while the agent tree was
         still running. Unkillable from every entry point at once, reported as
         success, and still spending. Only a kill that worked closes the
         door. */
      try {
        if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      } catch {
        // Closing stdin on a process that is already dying fails, and that is
        // fine — we are about to kill it anyway. The kill result is what gets
        // reported to the caller.
      }
      killing = true;
      const killed = killTree(child, spawnFn);
      if (!killed || killed.ok !== false) stopped = true;
      return killed;
    },
  };
}

module.exports = {
  MODES,
  modeFlags,
  invocationFor,
  resolveAgent,
  startConsole,
  // Exported for the suite, which tests these directly rather than inferring
  // them through a spawned process. They are the parts most likely to be
  // changed by someone who has not read the measurements above.
  _internals: {
    AGENTS,
    CMD_METACHARACTERS,
    buildShimInvocation,
    encodePrompt,
    invocationFor,
    makeLineSplitter,
    unsafeForCmd,
  },
};
