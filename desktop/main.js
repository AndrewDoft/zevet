// zevet desktop — the thing you send your friends.
//
// Two windows and one job each. Setup collects the three values nobody can
// guess (hub, the team's master secret, name), writes ~/.zevet/config.json and
// wires a repo. The board is the hub's own page, loaded remotely.
//
// That used to say "token" and it is worth the correction: what the config
// holds is now the master SECRET, and the hub is only ever shown
// `SHA-256("zevet-auth\0" || S)` — see client/secret.mjs. Everything in this
// file that talks to the hub sends the derived token, never the secret, and
// `zevet:config` refuses to hand either back to a renderer.
//
// SECURITY POSTURE. Both windows get a preload, and neither gets Node.
//
// This USED to say the board window had no preload at all, which was true and
// is no longer, so it is rewritten rather than left to rot: a comment claiming
// a protection the code stopped providing is worse than no comment.
//
// What holds now: no window has nodeIntegration, contextIsolation is on
// everywhere, and the bridge exposes named calls rather than `require`. The
// board's bridge can list a tree under a folder the USER picked with a native
// dialog, read one text file from it and write one text file back to it —
// nothing else, and never a path the main process has not re-checked against
// that root. See openBoard() for why the board is allowed a bridge at all
// despite loading a remote origin, and local:write below for why a WRITE over
// that same bridge is a bigger thing to hand out than a read.
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu, safeStorage, session, powerMonitor, net } = require("electron");
const { createReconnect } = require("./reconnect.js");
const { openSafe } = require("./open-safe.js");
const { createLog, createIpcRegistry } = require("@masora/desktop-kit");
// bootstrap.js (the asar entry) loaded this file; what only it can hand over is on this object.
const bootShell = globalThis.__zevetShell;
/** The payload build running, which is NOT app.getVersion() (that is the installer's). */
const APP_VERSION = bootShell.build;
// A packaged app has no console to read: warnings and errors from every module,
// plus the updater's own lines, also go to a size-capped rotating file (logs/zevet.log, 3 x 1 MB).
const fileLog = createLog({ dir: app.getPath("logs"), name: "zevet" });
for (const level of ["warn", "error"]) {
  const orig = console[level].bind(console);
  console[level] = (...a) => { orig(...a); fileLog[level](...a); };
}
// Must run before the first ipcMain.handle below. readConfig is a hoisted function declaration.
require("./ipc-guard.js").guardIpc(ipcMain, () => (readConfig() || {}).hub);
// Every bridge handler below is registered through the IPC table (ipc-table.js), which also generates
// preload.js: a channel that is not in the table is refused, and bridge.assertComplete() (after the last
// handler) fails startup if a table call has no handler. ipcMain.handle is looked up per registration, so
// the guard above still wraps each one.
const bridge = createIpcRegistry(ipcMain, require("./ipc-table.js").tables);
const localFs = require("./local-fs.js");
const agentConsole = require("./agent-console.js");
const repoStats = require("./repo-stats.js");
const schedule = require("./schedule.js");
const statusSources = require("./status-sources.js");
const crypto = require("node:crypto");
const indexCapability = require("./index-capability.js");
const embedder = require("./embedder.js");
const { classifyOverlap } = require("./overlap-check.js");
const codeIndex = require("./code-index.js");
const { FileWatch } = require("./file-watch.js");
const { AppUpdater, loopbackProofKeys, INSTALL_ARGS, winInstallArgs } = bootShell.require("./app-update.js");
const { createRollback } = bootShell.require("./update-rollback.js");
const { familyIndexKeys } = bootShell.require("./update-signing.js");
const runtime = require("./runtime.js");
const { observePayload, settleChannel, createSwapper, confirmWhenHealthy, awaitHealthy, WINDOWLESS_ARG } = require("./payload-swap.js");
const { createIdleInstaller, CHECK_MS: IDLE_CHECK_MS } = require("./idle-install.js");
const askServer = require("./ask-server.js");
const agentApi = require("./agent-api.js");
const { createBoardAsk } = require("./board-ask.js");
const { GithubSignIn } = require("./github-signin.js");
const { resolveHub, hostedHub, DOMAIN_HUB, LEGACY_HUB } = require("./hub-target.js");
const { GoogleSignIn } = require("./google-signin.js");
const masoraVoice = require("./zevet-voice.js");
const agentSessions = require("./agent-sessions.js");
const { resolveKnown } = require("./workspace-root.js");
const { createApiRootLease } = require("./api-root-lease.js");
const agentCatalogs = require("./agent-catalogs.js");
const { createConsoleLog } = require("./console-log.js");
const consolePersistence = require("./console-persistence.js");
const { createAgentWorktrees } = require("./agent-worktree.js");
const { integrateAgent, runAgentChecks, killChecks } = require("./agent-integration.js");
const autoTitle = require("./auto-title.js");
const masora = require("./masora.js");
const { MasoraLink } = require("./masora-link.js");
const { Family, familyDir, frameable, FRAME_URLS } = require("./family.js");
const { Sso } = require("./sso.js");
const reportingHealth = require("./reporting-health.js");
const credentials = require("./credentials.js");
const credentialLadder = require("./credential-ladder.js");
const credentialUsage = require("./credential-usage.js");
const agentEngine = require("./agent-engine.js");
const masoraPush = require("./masora-push.js");
const masoraConnect = require("./masora-connect.js");
const chats = require("./chat.js");
const { createClaudeCli } = require("./chat-claude.js");
const { createCli: createChatCli } = require("./chat-cli.js");
const { createZevetChat } = require("./chat-zevet.js");
const sentry = require("./sentry.js");
const userReport = require("./user-report.js");
const Sentry = require("@sentry/electron/main");
// doc-sync.js is NOT required at the top. It resolves and loads the crypto
// modules at construction time, and on a checkout where those are missing that
// is a throw — at the top of this file that throw happens before any window
// exists and the app simply never starts, with the message going to a console
// nobody is looking at. Required lazily in ensureDocSync() instead, where the
// failure becomes an error string a person can read in the editor.
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const os = require("node:os");
const { zevetHome, atomicWriteJson } = require("./zevet-home.js");

// Node, npm agent shims and the tools those agents launch need the same PATH
// whether zevet was opened from Finder or from Terminal.
const runtimeReady = runtime.preparePath();

const HOME = zevetHome();
const CONFIG = path.join(HOME, "config.json");
const AGENT_API_FILE = path.join(HOME, "agent-api.json");

/**
 * D-NEXT-NOPOPUP: automated runs never put a window on a person's screen.
 * Every harness launch sets ZEVET_TEST_HOOKS=1 (scripts/drive); those windows are created hidden and
 * show/focus are no-ops, unless ZEVET_TEST_VISIBLE=1 asks for a visible one. ZEVET_TEST_HEADLESS=1 forces
 * hidden on its own. Each window is logged to HOME/windows.jsonl (test hooks only) so a test can prove it.
 */
const HIDE_WINDOWS =
  process.env.ZEVET_TEST_HEADLESS === "1" ||
  (process.env.ZEVET_TEST_HOOKS === "1" && process.env.ZEVET_TEST_VISIBLE !== "1");
function windowOptions(kind, opts) {
  // A hidden page is throttled by Chromium (timers, rAF); the harness waits on those, so keep it running.
  return HIDE_WINDOWS
    ? { ...opts, show: false, skipTaskbar: true, paintWhenInitiallyHidden: true, webPreferences: { ...opts.webPreferences, backgroundThrottling: false } }
    : opts;
}
function trackWindow(kind, win) {
  if (process.env.ZEVET_TEST_HOOKS !== "1") return win;
  const log = (event) => {
    try {
      fs.mkdirSync(HOME, { recursive: true });
      fs.appendFileSync(path.join(HOME, "windows.jsonl"), `${JSON.stringify({ kind, event, visible: win.isDestroyed() ? false : win.isVisible(), hidden: HIDE_WINDOWS, at: Date.now() })}
`);
    } catch { /* a harness that cannot read this notices from its assertion */ }
  };
  if (HIDE_WINDOWS) {
    for (const m of ["show", "showInactive", "focus", "restore", "moveTop"]) win[m] = () => log(`blocked-${m}`);
    win.on("show", () => log("shown"));
  }
  log("created");
  win.webContents.on("did-finish-load", () => log("loaded"));
  return win;
}

/**
 * Error reporting, wired before anything else -- including the two windows --
 * so a crash during startup is not a crash nobody hears about. What actually
 * gets scrubbed and tagged lives in desktop/sentry.js; this only supplies the
 * release name and the tags this MACHINE knows before any window exists.
 * `member` is corrected the moment a real one is known (writeConfig, below).
 */
{
  const startupCfg = readConfig();
  sentry.initMain({
    sentryMain: Sentry,
    release: sentry.releaseName(APP_VERSION),
    tags: {
      platform: process.platform,
      arch: process.arch,
      member: (startupCfg && (startupCfg.actor || startupCfg.login)) || "unknown",
    },
  });
}
// ZEVET_SENTRY_TEST=1: one deliberate event proving the pipe works, distinct
// from a real failure by its exact, unmistakable text.
if (process.env.ZEVET_SENTRY_TEST === "1") sentry.sendTestMessage(Sentry);

/**
 * Every agent launch, Code's and Chat's alike, reports a failed run to Sentry
 * without each of desktop/main.js's five call sites having to remember to —
 * see desktop/sentry.js's own comment on `withAgentFailureCapture` for why
 * this is one wrapper applied once rather than five copies of the same
 * capture call.
 */
const startConsoleWithCapture = sentry.withAgentFailureCapture(agentConsole.startConsole, {
  sentryMain: Sentry,
  invocationFor: agentConsole.invocationFor,
});

/** When this app last started an agent — what reporting-health.js measures "events should have arrived by now" from. */
let lastAgentStartAt = 0;
function instrumentedStartConsole(...args) {
  lastAgentStartAt = Date.now();
  return startConsoleWithCapture(...args);
}

/**
 * Test hook: record every `shell.openExternal` call instead of actually
 * opening a browser, so a driving harness can ask "did clicking this button
 * open the browser, and with what URL?" without a real browser popping up on
 * every run. Gated on an env var that is never set by the installer or by a
 * person launching the app normally — see scripts/drive/README.md.
 */
if (process.env.ZEVET_TEST_HOOKS === "1") {
  const openedLog = path.join(HOME, "opened-external.jsonl");
  shell.openExternal = (url) => {
    try {
      fs.mkdirSync(HOME, { recursive: true });
      fs.appendFileSync(openedLog, `${JSON.stringify({ url: String(url), at: Date.now() })}\n`);
    } catch {
      // Best effort — a harness that cannot read this file will notice from
      // the assertion that fails, not from a crashed app.
    }
    return Promise.resolve();
  };
}

/**
 * The Windows application identity. MUST match `build.appId` in package.json.
 *
 * Without it, Windows treats the running window and the installed shortcut as
 * two different applications: the taskbar shows a second, generic entry while
 * the app runs, "Pin to taskbar" pins something that does not launch it back,
 * and the Start Menu entry never links up with the live window. Electron
 * defaults the model ID to the ELECTRON executable on Windows, which is why an
 * unset one looks like a packaging fault rather than a missing line.
 *
 * Harmless on macOS and Linux, where the call is a no-op.
 */
const APP_ID = "com.andrewdoft.zevet";
app.setAppUserModelId(APP_ID);

/** The window icon (taskbar, title bar, Alt-Tab). Windows gets the multi-size .ico, whose 16/24/32 frames are
 *  drawn for those sizes (desktop/make-icon.mjs); a 512px PNG would be shrunk on the fly. Both ship in the payload
 *  (package.json payload.files), so a payload-only release carries the current mark even though the installed
 *  exe's own embedded icon only changes with a new installer. */
const ICON = path.join(__dirname, "build", process.platform === "win32" ? "icon.ico" : "icon.png");
/** The preload lives in the payload, outside the asar: it finds @sentry/electron from the shell's directory (see ipc-table.js). */
const SHELL_DIR_ARG = `--zevet-shell-dir=${bootShell.dir}`;
const iconOption = fs.existsSync(ICON) ? { icon: ICON } : {};
const CLIENT_DIR = path.join(HOME, "client");
// The eggshell the board is painted on. Used as the window background so there
// is no white — or, as it was until now, near-black — flash before first paint.
const PAPER = "#eae7e2";
const INK = "#2c2f44";
/** The dark ground, and it must match `:root[data-theme="dark"] --paper` in
 *  hub/public/index.html. Two copies of one colour is a thing to dislike, but
 *  the alternative is the main process fetching a stylesheet from the hub to
 *  learn what to paint a window, which is worse. The renderer sends its real
 *  computed values on every theme change (see `ui:chrome`), so these two are
 *  only the pre-paint guess. */
const PAPER_DARK = "#24252c";

/**
 * The window chrome, per theme.
 *
 * ⚠️ WHY THE TITLE BAR IS OURS NOW. Andrew's complaint: *"the outline of the
 * app is in the blue of my machine and is always visible, even on full
 * screen"*. That is Windows painting the caption and the window border in the
 * system accent colour, and a web page cannot touch either.
 *
 * `titleBarStyle: "hidden"` with a `titleBarOverlay` hands the caption area to
 * us while KEEPING the native minimise/maximise/close buttons — the middle
 * ground between living with the accent bar and `frame: false`, which would
 * mean drawing and maintaining three window buttons and their hover states on
 * every platform.
 *
 * ⚠️ WHAT THIS STILL DOES NOT FIX, and it should not be claimed: the 1px
 * window BORDER on Windows 11. That is `DWMWA_BORDER_COLOR`, set by the
 * desktop window manager, and Electron exposes no API for it. If it is still
 * the machine's accent blue after this, that is why, and the only remaining
 * lever is `frame: false`. NOT VERIFIED either way — the border cannot be seen
 * in a page screenshot, which is the only kind taken here.
 */
/* ---------------------------------------------------------------------------
 * ZOOM
 *
 * There was none. buildMenu() registered appMenu, a custom zevet menu, editMenu
 * and windowMenu, and Electron's zoom accelerators come from the viewMenu role
 * — so Ctrl+=, Ctrl+- and Ctrl+0 were never bound to anything. Ctrl+wheel is
 * off by default and nothing turned it on. The board also could not survive
 * being zoomed, because #root had no height and the shell collapsed; that half
 * is fixed in masora.css.
 *
 * Electron's zoomLevel is logarithmic: each step is a factor of 1.2, so level 3
 * is 1.2^3 = 1.73x. The range below is the same one Chrome offers (25%..500%),
 * clamped so a stray Ctrl+wheel cannot leave the window unreadable.
 * ------------------------------------------------------------------------- */
const ZOOM_MIN = -7;
const ZOOM_MAX = 9;
const ZOOM_STEP = 0.5;

const TITLE_BAR_HEIGHT = 46;

function clampZoom(level) {
  if (!Number.isFinite(level)) return 0;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level));
}

/** zoomLevel -> the multiplier Chrome applies. */
const zoomFactor = (level) => Math.pow(1.2, level);

function chromeFor(theme, level = 0) {
  const dark = theme === "dark";
  return {
    color: dark ? PAPER_DARK : PAPER,
    symbolColor: dark ? "#eae7e2" : INK,
    // THE OVERLAY DOES NOT SCALE. On Windows the title bar overlay is drawn by
    // the OS in device pixels while the page beneath it is scaled by
    // zoomFactor, so a zoomed-in board grows its own .pane-title past the
    // window controls and the drag region stops lining up with the buttons.
    // Scaling the height back keeps the two in agreement.
    height: Math.round(TITLE_BAR_HEIGHT * zoomFactor(level)),
  };
}

/** The remembered zoom level, or 0. Kept in the config beside the hub. */
function storedZoom() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    return clampZoom(typeof cfg.zoom === "number" ? cfg.zoom : 0);
  } catch {
    return 0;
  }
}

/**
 * The permission posture an agent starts with when nobody picks one.
 *
 * ⚠️ THIS IS A PER-USER SETTING AND IT LIVES IN THE CONFIG, NOT IN THE BOARD.
 * localStorage would have been one line, and it is scoped to the hub origin —
 * so it is cleared with site data, lost when the hub moves, and separate in
 * every window. A default that decides whether an agent asks before it edits
 * must not be able to quietly revert. It sits beside `zoom` in
 * ~/.zevet/config.json, which is this machine, which is this user.
 *
 * VALIDATED AGAINST agent-console.js's OWN TABLE, never a list copied here:
 * that module is what turns the id into real flags — `dangerous` is
 * `--dangerously-skip-permissions` for claude and
 * `--dangerously-bypass-approvals-and-sandbox` for codex — and a second
 * spelling of the same four names is how a setting starts meaning nothing.
 */
function storedMode() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    const m = cfg && typeof cfg.mode === "string" ? cfg.mode : "";
    return Object.prototype.hasOwnProperty.call(agentConsole.MODES, m) ? m : "";
  } catch {
    return "";
  }
}

/** Remember it, the same best-effort way zoom is remembered — but this one
 *  REPORTS rather than swallowing, because a permission default that silently
 *  failed to save is the one setting you must not have to guess about. */
function rememberMode(mode) {
  const next = Object.prototype.hasOwnProperty.call(agentConsole.MODES, mode) ? mode : "";
  if (!next) return { ok: false, error: "not a permission mode", mode: storedMode() };
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    if (!cfg || typeof cfg !== "object") return { ok: false, error: "no config to write to", mode: "" };
    if (cfg.mode !== next) {
      cfg.mode = next;
      writeConfig(cfg);
    }
    return { ok: true, mode: next };
  } catch (err) {
    return { ok: false, error: err.message, mode: storedMode() };
  }
}

/** Remember it. Best effort: a window that cannot persist its zoom is still a
 *  window, and this must never be able to take the app down. */
function rememberZoom(level) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    if (!cfg || typeof cfg !== "object") return;
    if (cfg.zoom === level) return;
    cfg.zoom = level;
    writeConfig(cfg);
  } catch {
    // No config yet, or unwritable. Zoom is a preference, not state.
  }
}

/** Apply a level to a window, persist it, and re-colour the overlay to match. */
function applyZoom(win, level) {
  if (!win || win.isDestroyed()) return;
  const next = clampZoom(level);
  win.webContents.setZoomLevel(next);
  rememberZoom(next);
  if (process.platform !== "darwin" && typeof win.setTitleBarOverlay === "function") {
    try {
      win.setTitleBarOverlay(chromeFor(lastChromeTheme, next));
    } catch {
      // Only valid on a window created with titleBarStyle: hidden + overlay.
    }
  }
}

/** The zoom a key means, or undefined if it means nothing. 0 is "actual
 *  size", which is why the caller tests for undefined and not falsiness. */
function onZoomKey(key) {
  if (key === "+" || key === "=" || key === "Add") return ZOOM_STEP;
  if (key === "-" || key === "_" || key === "Subtract") return -ZOOM_STEP;
  if (key === "0") return 0;
  return undefined;
}

function stepZoom(win, delta) {
  if (!win || win.isDestroyed()) return;
  applyZoom(win, win.webContents.getZoomLevel() + delta);
}

/** The theme the overlay was last painted for, so a zoom change does not
 *  repaint it in the wrong colours. */
let lastChromeTheme = "light";

let boardWindow = null;
let setupWindow = null;
let watcher = null;

/**
 * `client/secret.mjs`, which is the ONE place that decides what credential a
 * machine has.
 *
 * ⚠️ NEVER FROM `~/.zevet/client`, and this is the same rule doc-sync.js states
 * at greater length: that directory is the hub's update channel, so a hub that
 * could put a `secret.mjs` there could make `deriveAuthToken` return anything
 * it liked — including the master secret itself, spelled as a token. The
 * resolution order below deliberately does not include it and must not grow one.
 *
 * ⚠️ THIS DUPLICATES doc-sync.js's `cryptoModulePaths`, knowingly. That module
 * keeps its loader private and belongs to another author; importing from it
 * would mean widening its exports. The two orders must stay identical — if one
 * of them ever resolves a different copy of secret.mjs than the other, the
 * board and the editor will authenticate as different teams and the symptom
 * will be a 401 nobody can explain. Flagged rather than solved.
 *
 * Node 22 (what Electron 38 embeds) can `require()` an ES module with no
 * top-level await; secret.mjs has none, deliberately, and doc-sync.js already
 * relies on exactly this.
 */
let secretModule;
function loadSecretModule() {
  if (secretModule !== undefined) return secretModule;
  const candidates = [];
  candidates.push(path.join(__dirname, "client", "secret.mjs")); // the payload's own copy
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "client", "secret.mjs"));
  candidates.push(path.join(__dirname, "..", "client", "secret.mjs"));
  secretModule = null;
  for (const p of candidates) {
    try {
      secretModule = require(p);
      break;
    } catch {
      // Try the next; the failure is reported by callers as an auth error, so
      // it reaches a person rather than a console nobody has open.
    }
  }
  return secretModule;
}

/**
 * The credential this machine presents to the hub, for a config as saved.
 *
 * A config with a `secret` derives `SHA-256("zevet-auth\0" || S)`; a config with
 * only a `token` — an install from before the master secret existed — presents
 * it verbatim and says `legacy`. That branch is not dead weight: there are
 * installs in the field with exactly that shape, and dropping them would take
 * the board away from everyone the moment they updated, before the hub's own
 * env had been cut over. See the header of client/secret.mjs for why the two
 * cannot both be right against one hub, and that the fallback buys an ordering
 * rather than a coexistence.
 *
 * ⚠️ `env: {}` — THE ENVIRONMENT IS IGNORED ON PURPOSE, even though secret.mjs
 * lets it win for the hook and the doctor. Those are command-line tools a
 * person runs in a shell they control. This is a GUI app: on Windows it is
 * launched from a Start Menu shortcut with no shell at all, so a `ZEVET_SECRET`
 * that happened to be set for one launch and not the next would make the app
 * authenticate as a different team depending on how it was started. Worse,
 * doc-sync.js also passes `env: {}`, so honouring it here would let the board
 * and the editor disagree about who this machine is. Same rule, same reason.
 */
function authFor(cfg) {
  const secret = loadSecretModule();
  if (!secret) {
    return {
      token: "",
      secret: "",
      legacy: false,
      error: "this install is missing client/secret.mjs, so it cannot prove who it is — reinstall zevet",
    };
  }
  // ⚠️ `session` HAS TO BE PASSED. This is an allowlist of three fields, not
  // a spread, so a credential added to the config and not added here is simply
  // never seen -- and the symptom is not an error, it is the app quietly
  // authenticating with the OLD credential while the settings pane reports the
  // new one.
  return secret.resolveAuth({ env: {}, file: { secret: cfg.secret, token: cfg.token, session: cfg.session } });
}

/**
 * Which env var a spawned agent reads a credential from, by (provider,
 * kind). DUPLICATED from hub/server.mjs's own copy of this table — see its
 * comment for why: the hub must not import out of `client/`, the one
 * directory it and this app could otherwise both load from, and there is no
 * other shared module. Four lines twice beats a package for four lines.
 */
const CREDENTIAL_ENV = {
  "anthropic:api_key": "ANTHROPIC_API_KEY",
  "anthropic:subscription_token": "CLAUDE_CODE_OAUTH_TOKEN",
  "openai:api_key": "OPENAI_API_KEY",
  // Meta's Model API (Muse Spark) — docs/contracts/meta-model-api.md. Stored
  // the same as any other provider's key; nothing spawns using it yet, since
  // zevet has no execution adapter for it (see that note).
  "meta:api_key": "MODEL_API_KEY",
};

/** Every env var ANY entry in CREDENTIAL_ENV could set, deleted from the
 *  child's env before the chosen one (if any) is applied. Without this, a
 *  stray ANTHROPIC_API_KEY the person already had in their shell would
 *  silently outrank the credential they just picked in Settings — same
 *  bug shape as authFor's `env: {}`, a few lines up, and the same fix. */
const ALL_CREDENTIAL_ENV_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "MODEL_API_KEY"];

/**
 * One credential id, resolved to `{provider, kind, key}` — or null if it
 * exists in neither store, or fetching/decrypting it fails.
 *
 * `scope`, when given, skips straight to that store. Omitted (the ladder's
 * case: a step only carries a bare `credentialId`, never a scope), it tries
 * the personal store first — cheap and local — then falls back to the team
 * one. A team lookup is two hub round trips (list, then the id's own
 * `/secret`) rather than one, because the list route is what the board's
 * settings pane also calls and this reuses it instead of inventing a
 * "give me one credential's metadata" route for a single caller.
 */
async function resolveCredential(id, cfg, scope) {
  if (!id) return null;

  if (scope !== "team") {
    const meta = credentials.listCredentials().find((c) => c.id === id);
    if (meta) {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const key = credentials.credentialKey(id, (b) => safeStorage.decryptString(b));
      return key ? { provider: meta.provider, kind: meta.kind, key } : null;
    }
    if (scope === "personal") return null;
  }

  const auth = authFor(cfg || {});
  const hub = String((cfg && cfg.hub) || "").replace(/\/+$/, "");
  if (auth.error || !auth.token || !hub) return null;
  try {
    const listRes = await fetch(`${hub}/team/credentials`, { headers: { "x-zevet-token": auth.token }, signal: AbortSignal.timeout(8000) });
    const list = listRes.ok ? await listRes.json() : null;
    const meta = list && Array.isArray(list.credentials) ? list.credentials.find((c) => c.id === id) : null;
    if (!meta) return null;
    const secretRes = await fetch(`${hub}/team/credentials/${encodeURIComponent(id)}/secret`, {
      headers: { "x-zevet-token": auth.token },
      signal: AbortSignal.timeout(8000),
    });
    if (!secretRes.ok) return null;
    const body = await secretRes.json();
    return typeof body.key === "string" && body.key ? { provider: meta.provider, kind: meta.kind, key: body.key } : null;
  } catch (err) {
    console.log(`zevet: could not reach the server for a team credential (${err.message})`);
    return null;
  }
}

/**
 * The env to spawn an agent with, from this member's chosen default
 * (`cfg.defaultCredential: {scope: "personal"|"team", id}`, or
 * `{scope: "auto"}` to walk `cfg.credentialLadder` — see
 * credential-ladder.js) — or undefined (spawn exactly as before, inheriting
 * process.env) when nothing is chosen, or anything about resolving it fails.
 *
 * A team credential and an Auto probe are both fetched fresh on every call
 * rather than cached at this layer — the owner may have rotated or removed
 * a credential since the last agent started, and one extra request per
 * launch is nothing. (The Auto path's utilization READING is cached, for
 * 60s, but that is credential-usage.js's concern, not this function's.) A
 * personal credential never leaves this machine: it is decrypted locally via
 * safeStorage, the same as masora.js's own token.
 *
 * Any failure (no config, no default set, the hub down, an older hub
 * without the route, decryption failing) is treated the same as "no
 * credential chosen": the agent still starts, and only a one-line note says
 * why — never the key itself, in that note or anywhere else logged.
 */
async function credentialEnvFor() {
  const cfg = readConfig();
  const def = cfg && cfg.defaultCredential;
  if (!def || !def.scope) return undefined;

  let cred = null;
  if (def.scope === "auto") {
    const ladder = Array.isArray(cfg.credentialLadder) ? cfg.credentialLadder : [];
    if (!ladder.length) return undefined;

    const usageById = {};
    const probed = new Set();
    for (const step of ladder) {
      if (probed.has(step.credentialId)) continue; // a rung can reuse an earlier id (Andrew's own ladder does)
      probed.add(step.credentialId);
      const c = await resolveCredential(step.credentialId, cfg);
      if (!c) continue; // no such credential, or it could not be fetched — the choice below just skips this rung
      const u = await credentialUsage.utilizationFor(step.credentialId, c, { fetchImpl: fetch });
      if (u !== undefined) usageById[step.credentialId] = u;
    }
    const chosenId = credentialLadder.choose(ladder, usageById);
    cred = chosenId ? await resolveCredential(chosenId, cfg) : null;
  } else if (def.scope === "personal" || def.scope === "team") {
    if (!def.id) return undefined;
    cred = await resolveCredential(def.id, cfg, def.scope);
  } else {
    return undefined;
  }
  if (!cred) return undefined;

  const envVar = CREDENTIAL_ENV[`${cred.provider}:${cred.kind}`];
  if (!envVar) return undefined;

  const env = { ...process.env };
  for (const v of ALL_CREDENTIAL_ENV_VARS) delete env[v];
  env[envVar] = cred.key;
  return env;
}

/**
 * The env to spawn an agent with, and which engine it ended up on --
 * `{ok: true, env, engine}` or `{ok: false, error}`.
 *
 * A per-launch `engine` request (desktop/agent-engine.js: "engine1" |
 * "engine2" | "auto") is a DIFFERENT axis from `credentialEnvFor`'s saved
 * default above -- that one picks a hub-shared credential for this
 * workspace; this one picks which of Andrew's own two Claude Max accounts
 * runs the process. When a caller names an engine it wins outright, because
 * it was asked for explicitly; with none named this is unchanged from
 * before engine selection existed -- `credentialEnvFor()`'s own default.
 */
async function agentEnvFor(engine) {
  if (!engine) return { ok: true, env: await credentialEnvFor(), engine: undefined };
  return agentEngine.resolveEngine(engine, process.env);
}

/**
 * The saved config, or null.
 *
 * ⚠️ EITHER CREDENTIAL COUNTS. This used to demand a `token`, which was right
 * until the setup scripts started writing `{hub, secret, actor}` and stopped
 * writing a token at all — at which point this said "not configured" about a
 * perfectly good install and sent the user back through setup, forever, with
 * setup then writing the same config it had just rejected. The validity
 * question here is only "is there a hub and SOMETHING to authenticate with";
 * which one it is, and whether it is well-formed, is `authFor`'s to answer.
 */
function readConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    if (!cfg || typeof cfg.hub !== "string" || !cfg.hub) return null;
    const hasSecret = typeof cfg.secret === "string" && cfg.secret.length > 0;
    const hasToken = typeof cfg.token === "string" && cfg.token.length > 0;
    // A GitHub session counts on its own. It normally arrives WITH a secret,
    // but the two are separate credentials for separate jobs (hub access
    // versus the document key) and a config carrying only the first is a
    // working install with no editor -- not an install to send back to setup.
    const hasSession = typeof cfg.session === "string" && cfg.session.length > 0;
    if (hasSecret || hasToken || hasSession) return cfg;
  } catch {
    // No config yet, or unreadable — treated the same: run setup.
  }
  return null;
}

/** The hub for this machine: see hub-target.js. Never taken from a renderer. */
function targetHub() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch {
    // No config yet: the hosted default.
  }
  return resolveHub({ env: process.env, cfg: raw });
}

function writeConfig(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  atomicWriteJson(CONFIG, cfg);
  try {
    // Best effort: the token is a shared secret sitting in a home directory.
    fs.chmodSync(CONFIG, 0o600);
  } catch {
    // Windows uses ACLs; there is nothing to do here and nothing to report.
  }
  // The startup tag (above) is a guess made before anyone had signed in; a
  // sign-in during THIS run corrects it immediately rather than waiting for
  // the next launch.
  Sentry.setTag("member", cfg.actor || cfg.login || "unknown");
}

/**
 * D-0NN: hub.usemasora.com replaces the sslip.io address as HOSTED_HUB, so a
 * network that blocks bare sslip.io domains (some corporate/school DNS
 * filters do, on principle) is not the only way to reach the hub. The sslip
 * address (LEGACY_HUB) is never decommissioned — Caddy serves the same hub
 * on both names permanently — so this is a courtesy rewrite, never a cutover
 * an install is forced through.
 *
 * Only fires when `cfg.hub` is EXACTLY the old default: a hub the user or an
 * admin configured on purpose (self-hosting, `ZEVET_HUB`, a typed address) is
 * never touched. And only rewrites once the new host actually answers — a
 * quick, short-timeout probe, because DNS for a domain this fresh may not
 * have reached this machine's resolver yet, and a slow or hanging network
 * check has no business delaying the board opening. A probe that fails for
 * any reason (no DNS yet, no route, a redirect, a non-200) leaves `cfg`
 * untouched; the sslip address keeps working exactly as it always has.
 */
async function migrateHubDomain(cfg) {
  if (!cfg || ![LEGACY_HUB, DOMAIN_HUB].includes(String(cfg.hub || "").replace(/\/+$/, ""))) return cfg;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2000);
    let res;
    try {
      res = await fetch(`${hostedHub()}/healthz`, { signal: ac.signal, redirect: "error" });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return cfg;
  } catch {
    return cfg;
  }
  const migrated = { ...cfg, hub: hostedHub() };
  writeConfig(migrated);
  return migrated;
}

/** Bootstrap the bundled client on the first install; keep its hook path stable. */
function installerPath() {
  return runtime.installerPath({ clientDir: CLIENT_DIR });
}

function openBoard(cfg) {
  if (boardWindow && !boardWindow.isDestroyed()) {
    boardWindow.focus();
    return;
  }
  // Background, after onboarding: never awaited, so it cannot gate the window.
  masoraLink.start();
  boardWindow = new BrowserWindow(windowOptions("board", {
    width: 1240,
    height: 820,
    minWidth: 720,
    minHeight: 420,
    backgroundColor: PAPER, // no white flash before the page paints
    title: "zevet",
    ...iconOption,
    // Expose the native controls' bounds on Mac too, so the board can reserve
    // their space as zoom and fullscreen change. Windows/Linux colour the overlay.
    titleBarStyle: "hidden",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", titleBarOverlay: true }
      : { titleBarOverlay: chromeFor("light", storedZoom()) }),
    autoHideMenuBar: true,
    webPreferences: {
      // THE BOARD NOW GETS A PRELOAD, and that is a real decision rather than
      // a convenience, because this window loads a REMOTE origin.
      //
      // The argument for it: the hub is already trusted with code execution on
      // every teammate's machine. It is the update server — it hands out the
      // hook that Claude Code runs before every tool call. A hub that wanted
      // to read your files could already do it that way. So exposing a narrow
      // file-read bridge to its page adds no new class of trust; it only makes
      // the capability visible and bounded instead of implicit.
      //
      // The argument against it is still real, and is why the bridge is narrow,
      // why every path is re-checked against the chosen root in the main
      // process, and why `will-navigate` below refuses to carry this window to
      // any other origin — a hub that redirects must not hand the bridge to
      // whoever it redirected to.
      preload: path.join(__dirname, "preload.js"),
      additionalArguments: [SHELL_DIR_ARG],
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  }));
  trackWindow("board", boardWindow);

  // Restore the remembered zoom. It has to be set per load, not once: a reload
  // or a navigation resets zoomLevel to 0, and a board that silently springs
  // back to 100% every time you refresh is the same bug reported differently.
  boardWindow.webContents.on("did-finish-load", () => {
    applyZoom(boardWindow, storedZoom());
  });

  // Ctrl/Cmd + wheel. Electron reports the gesture and leaves the decision to
  // the app; without this handler the event fires and nothing moves.
  boardWindow.webContents.on("zoom-changed", (_event, direction) => {
    stepZoom(boardWindow, direction === "in" ? ZOOM_STEP : -ZOOM_STEP);
  });

  // The spellings the menu accelerator cannot cover: Ctrl+Shift+= (the "+"
  // most keyboards actually produce) and the numpad's own +, - and 0. An
  // accelerator string names a character; this names the key.
  boardWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (!(process.platform === "darwin" ? input.meta : input.control)) return;
    const delta = onZoomKey(input.key);
    if (delta === undefined) return;
    event.preventDefault();
    if (delta === 0) applyZoom(boardWindow, 0);
    else stepZoom(boardWindow, delta);
  });

  const hubOrigin = new URL(cfg.hub).origin;
  boardWindow.webContents.on("will-navigate", (e, target) => {
    try {
      if (new URL(target).origin !== hubOrigin) {
        e.preventDefault();
        openSafe(target).catch(() => {});
      }
    } catch {
      e.preventDefault();
    }
  });

  // THE DERIVED TOKEN, never the master secret. The board URL ends up in the
  // renderer's own `location`, which is the hub's page — putting `cfg.secret`
  // here would hand the document key to the one party the encryption exists to
  // keep out, and would do it in a string that also lands in proxy logs.
  //
  // A master secret that is not hex, or an install with no secret.mjs to derive
  // with, is named rather than pointed at the hub and left to 401: an
  // authentication failure the user cannot act on looks exactly like a hub that
  // is down, and the two have nothing in common. Not an early return — the
  // window's own handlers below, `closed` above all, still have to be wired up
  // or the app is left holding a window it thinks is open.
  // ZEVET_SENTRY_TEST=1: board/src's own Sentry init reads this off its URL
  // and fires one captureMessage, since a remote-origin page has no other way
  // to learn it should.
  const sentryTestParam = process.env.ZEVET_SENTRY_TEST === "1" ? "&sentryTest=1" : "";

  const auth = authFor(cfg);
  if (auth.error) {
    boardWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(credentialPage(auth.error)));
  } else {
    boardWindow.loadURL(`${cfg.hub.replace(/\/+$/, "")}/?token=${encodeURIComponent(auth.token)}&build=${encodeURIComponent(APP_VERSION)}${sentryTestParam}`);
  }

  // A failed load (Wi-Fi still associating, a VPN coming up, the hub mid-deploy) shows Zevet's own waiting page
  // at once and retries on a short capped backoff until it works; waking the machine or the network coming back
  // retries immediately (reconnect.js). No address is shown: there is nothing for the person to do with one.
  let probing = false;
  const reconnect = createReconnect({
    // Probe first: navigating to a dead hub would swap Chromium's own error page in over ours on every attempt.
    load: async () => {
      if (probing) return;
      probing = true;
      const up = await hubAnswers(cfg.hub);
      probing = false;
      if (!boardWindow || boardWindow.isDestroyed()) return reconnect.stop();
      if (up) boardWindow.loadURL(`${cfg.hub.replace(/\/+$/, "")}/?token=${encodeURIComponent(auth.token)}&build=${encodeURIComponent(APP_VERSION)}${sentryTestParam}`);
      else reconnect.failed();
    },
    showPage: () => boardWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(reconnectingPage())),
    isOnline: () => net.isOnline(),
  });
  boardWindow.webContents.on("did-fail-load", (_e, code, _desc, _url, isMainFrame) => {
    if (code === -3 || isMainFrame === false || auth.error) return; // aborted by a normal navigation, a subframe, or the credential page
    reconnect.failed();
  });
  boardWindow.webContents.on("did-finish-load", () => {
    if (!boardWindow.webContents.getURL().startsWith("data:")) reconnect.loaded();
  });
  const nudge = () => reconnect.nudge();
  powerMonitor.on("resume", nudge);
  powerMonitor.on("unlock-screen", nudge);
  boardWindow.once("closed", () => {
    reconnect.stop();
    powerMonitor.removeListener("resume", nudge);
    powerMonitor.removeListener("unlock-screen", nudge);
  });

  // Anything that wants a new window is a link to the outside world.
  boardWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    openSafe(target).catch(() => {});
    return { action: "deny" };
  });

  // A RELOAD IS A NEW RENDERER, so it gets a new set of these. Pressing the
  // reload key, or the hub redeploying under a page that is already open,
  // destroys the Y.Docs and the listeners that were driving all of this while
  // leaving the window — and therefore every socket and every OS watch handle —
  // alive in this process. Without this the rooms joined by the previous page
  // stay joined forever, their updates are relayed to a renderer that never
  // asked for them, and a person who reloads ten times is holding ten times
  // the watchers.
  //
  // `did-start-loading` rather than `did-navigate`: it runs BEFORE the new
  // document's scripts do, so there is no window in which the fresh page's
  // `join` could be torn down by the teardown of the page it replaced. It also
  // fires for the very first load, where there is nothing to release and this
  // is a no-op.
  boardWindow.webContents.on("did-start-loading", () => releaseBoardResources());

  boardWindow.on("closed", () => {
    boardWindow = null;
    // Everything the board owned goes with the board. A DocSync left behind
    // holds an open socket per room and keeps sealing and relaying updates for
    // a window that no longer exists; a FileWatch left behind holds an OS watch
    // handle per directory.
    releaseBoardResources();
    // A reload re-attaches to the running agents; a CLOSE does not, because
    // there is no page left to re-attach them to.
    stopAllConsoles();
  });

  startCollisionWatch(cfg);
  startSteerChannel(cfg);
}

function statusPageStyle() {
  // Data pages cannot load file:// fonts. Bundle the small local face so an
  // offline error uses the same typography without making a network request.
  let face = "";
  try {
    const font = fs.readFileSync(path.join(__dirname, "fonts", "space-grotesk-variable.woff2"));
    face = `@font-face{font-family:Space Grotesk;src:url(data:font/woff2;base64,${font.toString("base64")}) format('woff2');font-weight:300 700}`;
  } catch { /* System typography remains available if a local asset is missing. */ }
  return `<style>${face}
    *{box-sizing:border-box}body{background:${PAPER};color:${INK};font:400 15px/1.6 'Space Grotesk',-apple-system,Segoe UI,sans-serif;
      margin:0;display:grid;place-items:center;min-height:100vh;padding:64px 32px 32px}
    body:before{content:'';position:fixed;inset:0 0 auto;height:46px;-webkit-app-region:drag}
    main{width:100%;max-width:52ch}h1{font-size:24px;font-weight:500;margin:24px 0 12px;letter-spacing:-.03em}
    .brand{display:flex;align-items:center;gap:9px;font-size:16px;font-weight:500}
    p{color:#5f6274;margin:0 0 12px}code{font-family:ui-monospace,monospace;font-size:12px;
      background:#dbdae1;border:1px solid #cfccc6;border-radius:4px;padding:2px 6px;overflow-wrap:anywhere}
  </style>`;
}

const STATUS_BRAND = `<div class="brand"><svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true" fill="currentColor"><circle cx="16" cy="8.2" r="3.5"/><circle cx="7" cy="23.8" r="3.5"/><circle cx="25" cy="23.8" r="3.5"/></svg>Zevet</div>`;

/** Does the hub answer at all (any non-5xx: a proxy's 502 is "down")? Never throws. */
async function hubAnswers(hub) {
  try {
    const r = await net.fetch(`${String(hub).replace(/\/+$/, "")}/healthz`, { signal: AbortSignal.timeout(4000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

function reconnectingPage() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Reconnecting</title>${statusPageStyle()}
  <style>@keyframes z{to{transform:rotate(360deg)}}i{display:inline-block;width:14px;height:14px;margin-right:8px;vertical-align:-2px;border:2px solid #cfccc6;border-top-color:${INK};border-radius:50%;animation:z .9s linear infinite}@media(prefers-reduced-motion:reduce){i{animation:none}}</style>
  <main>${STATUS_BRAND}<h1><i></i>Reconnecting</h1>
  <p>Your work is safe. Zevet picks up again by itself as soon as it can.</p></main></html>`;
}

/**
 * The page shown when this machine cannot prove who it is.
 *
 * Separate from `reconnectingPage` on purpose: that one says "the hub may be
 * off, nothing is wrong with your install", which is a comforting and, here,
 * false thing to tell somebody whose config holds a mistyped secret. The
 * remedies are opposite — wait versus re-run setup — so the pages are too.
 *
 * `why` is secret.mjs's own wording ("master secret must be hex", and so on),
 * which names the fault without ever containing the value.
 */
function credentialPage(why) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Signed out</title>${statusPageStyle()}
  <main>${STATUS_BRAND}<h1>Signed out</h1>
  <p>${String(why).replace(/[<&]/g, "")}</p>
  <p>zevet &rsaquo; Team…</p></main></html>`;
}

function openSetup(existing) {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow(windowOptions("setup", {
    width: 620,
    height: 820,
    resizable: false,
    backgroundColor: PAPER,
    title: "Set up zevet",
    ...iconOption,
    // The same frame as the board (openBoard): no accent-coloured outline. The
    // page draws a drag bar; Windows keeps its native buttons through the
    // overlay and macOS keeps its traffic lights.
    titleBarStyle: "hidden",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" }
      : { titleBarOverlay: chromeFor("light", 0) }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      additionalArguments: [SHELL_DIR_ARG],
      nodeIntegration: false,
      contextIsolation: true,
      // The shared preload requires @sentry/electron, which a sandboxed
      // preload cannot load: without this window.zevet never exists and every
      // button on this page is dead (same as the board window above).
      sandbox: false,
    },
  }));
  trackWindow("setup", setupWindow);
  setupWindow.loadFile(path.join(__dirname, "setup.html"), {
    query: {
      ...(existing ? { actor: existing.actor || "" } : {}),
      ...(process.env.ZEVET_SENTRY_TEST === "1" ? { sentryTest: "1" } : {}),
    },
  });
  setupWindow.on("closed", () => {
    setupWindow = null;
    // Closing setup with nothing configured means there is nothing to show.
    if (!readConfig() && !boardWindow) app.quit();
  });
}

/**
 * Native notifications for the one thing worth interrupting somebody over:
 * a teammate touching a file they are also in.
 *
 * Read in the main process rather than in the board page, so it works while
 * the window is in the background — which is the only time a notification is
 * worth anything — and so a remote page never needs notification permission.
 */
async function startCollisionWatch(cfg) {
  stopCollisionWatch();
  // The same derived token the board window is loaded with. A machine whose
  // credential cannot be resolved has nothing to present, and retrying an SSE
  // stream forever against a 401 is a loop that achieves nothing — the board
  // window is already showing the reason.
  const auth = authFor(cfg);
  if (auth.error || !auth.token) return;
  const controller = new AbortController();
  watcher = controller;
  const base = cfg.hub.replace(/\/+$/, "");
  const me = (cfg.actor || "").toLowerCase();
  const announced = new Set();

  while (!controller.signal.aborted) {
    try {
      const res = await fetch(`${base}/events?token=${encodeURIComponent(auth.token)}`, {
        signal: controller.signal,
        headers: { accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) throw new Error(`server answered ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const evt = /^event:\s*(.+)$/m.exec(frame);
          const data = /^data:\s*(.+)$/m.exec(frame);
          if (!evt || !data) continue;
          let payload;
          try {
            payload = JSON.parse(data[1]);
          } catch {
            continue;
          }
          const collisions = evt[1].trim() === "hello" ? payload.collisions || [] : [];
          for (const c of collisions) {
            const names = (c.actors || []).map((a) => a.actor);
            if (!names.some((n) => String(n).toLowerCase() === me)) continue;
            const key = `${c.target}:${names.slice().sort().join(",")}`;
            if (announced.has(key)) continue;
            announced.add(key);
            const others = names.filter((n) => String(n).toLowerCase() !== me);
            if (!others.length) continue;
            new Notification({
              title: "Same file",
              body: `${others.join(" and ")} edited ${c.target}, which you have open.`,
              silent: false,
            }).show();
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      // The hub being down is normal and not worth a dialog. Back off and retry.
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function stopCollisionWatch() {
  if (watcher) {
    watcher.abort();
    watcher = null;
  }
}

function buildMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "zevet",
      submenu: [
        {
          label: "Connect a folder…",
          click: () => wireRepoFromMenu(),
        },
        {
          label: "Team…",
          click: () => openSetup(readConfig()),
        },
        { type: "separator" },
        menuOffersRestart
          ? { label: "Restart to update", click: () => appUpdater.install() }
          : { label: "Check for Updates…", click: () => appUpdater.check() },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    // THE MISSING MENU. Its roles are where Ctrl+=, Ctrl+- and Ctrl+0 come
    // from; zevet had no viewMenu, so none of them were bound. The items are
    // spelled out rather than taking { role: "viewMenu" } wholesale because
    // that role also carries reload and devtools, which the zevet menu above
    // already has, and because the zoom items have to go through applyZoom so
    // the level is remembered and the title bar overlay follows.
    {
      label: "View",
      submenu: [
        {
          label: "Zoom In",
          // The UNSHIFTED spelling. "CommandOrControl+Plus" matches only
          // Ctrl+Shift+=, which is not what anyone presses; the other
          // spellings are handled in onZoomKey below.
          accelerator: "CommandOrControl+=",
          click: () => stepZoom(BrowserWindow.getFocusedWindow(), ZOOM_STEP),
        },
        {
          label: "Zoom Out",
          accelerator: "CommandOrControl+-",
          click: () => stepZoom(BrowserWindow.getFocusedWindow(), -ZOOM_STEP),
        },
        {
          label: "Actual Size",
          accelerator: "CommandOrControl+0",
          click: () => applyZoom(BrowserWindow.getFocusedWindow(), 0),
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function wireRepoFromMenu() {
  const parent = boardWindow || setupWindow;
  const picked = await dialog.showOpenDialog(parent, {
    title: "Choose a project folder",
    properties: ["openDirectory"],
  });
  if (picked.canceled || !picked.filePaths[0]) return;
  const result = await installHooks(picked.filePaths[0]);
  dialog.showMessageBox(parent, {
    type: result.ok ? "info" : "error",
    message: result.ok ? "Connected." : "Could not connect this folder.",
    detail: result.detail,
  });
}

async function installHooks(repo) {
  await runtimeReady;
  return new Promise((resolve) => {
    let installer;
    try {
      installer = installerPath();
    } catch (err) {
      resolve({ ok: false, detail: `Could not install the bundled client: ${err.message}` });
      return;
    }
    if (!installer) {
      resolve({ ok: false, detail: "Finish setup before connecting a folder." });
      return;
    }
    execFile(process.execPath, [installer, repo], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, detail: (stderr || err.message).trim().slice(0, 600) });
        return;
      }
      // The installer also reports missing Codex hook trust. Hiding stdout
      // turned an installed-but-inert hook into an unconditional success.
      resolve({ ok: true, detail: `${repo}\n\n${stdout.trim() || "Start your agent in this folder."}` });
    });
  });
}

// ---- IPC, from the setup window only -------------------------------------

/**
 * The saved settings, WITH THE CREDENTIALS TAKEN OUT.
 *
 * ⚠️ THIS IS A SECURITY BOUNDARY AND NOT A TIDYING-UP. It used to return the
 * parsed config object whole. `preload.js` exposes this call as
 * `window.zevet.config()` on EVERY window, and the board window loads a REMOTE
 * origin — the hub's own page, with this preload attached (see openBoard). So
 * the hub could serve one line of JavaScript, call `window.zevet.config()`, and
 * read the team's master secret out of its own page.
 *
 * That is not one leaked credential, it is the whole design: the document key
 * is derived from the master secret, and the hub is deliberately given only
 * `SHA-256("zevet-auth" || secret)` so that it can relay traffic it cannot
 * read. Hand it the secret and every document on the team is readable by the
 * one party the encryption exists to keep out. desktop/doc-sync.js keeps the
 * key and the socket in this process for exactly this reason; returning the
 * secret through a different call would have made that effort pointless.
 *
 * So: `hub` and `actor` cross, because they are not credentials and the board
 * needs `actor` to label a remote cursor with a person's name. `secret` and
 * `token` never cross, in any form — not truncated, not hashed, not "just the
 * first four characters for the UI". The only questions a renderer may ask
 * about them are whether one is configured and whether it is the legacy kind,
 * and both are answered here as booleans.
 *
 * SETUP DOES NOT NEED THEM BACK EITHER. desktop/setup.html reads `c.hub` and
 * `c.actor` from this call and nothing else; it only ever WRITES a credential.
 * That was checked, not assumed.
 */
bridge.handle("zevet:config", () => {
  const cfg = readConfig();
  if (!cfg) return null;
  const hasSecret = typeof cfg.secret === "string" && cfg.secret.length > 0;
  return {
    hub: cfg.hub,
    actor: cfg.actor || "",
    // Same identity as hook events; actor names can be shared across machines.
    machine: os.hostname().slice(0, 60),
    hasSecret,
    // Who is signed in, for the settings pane to show. A login is a public
    // name, not a credential -- it is on every commit this person has ever
    // pushed -- so unlike the secret and the session it is safe to hand back.
    login: typeof cfg.login === "string" ? cfg.login : "",
    // The posture an agent starts with unless the composer says otherwise.
    // "" means nobody has chosen, and the board falls back to its own default.
    mode: storedMode(),
    session: typeof cfg.session === "string" && cfg.session.length > 0,
    // A machine set up before the master secret existed: a raw shared token and
    // nothing to derive a document key from. The editor cannot work there and
    // says so; see doc:join.
    legacy: !hasSecret,
    // Not a credential -- electron-builder's own version string, read for the
    // board's own Sentry release tag (board/src/lib/sentry.ts) so a renderer
    // report reads "zevet@0.2.85" the same as a main-process one.
    version: APP_VERSION,
  };
});

/**
 * Does this hub accept this credential?
 *
 * ⚠️ WHAT THE SETUP WINDOW'S FIELD NOW HOLDS IS THE TEAM'S MASTER SECRET, not
 * the hub's token. The two are different values — the hub holds
 * `SHA-256("zevet-auth\0" || S)` and never S — so what is TYPED is derived
 * before it is sent, and what is SENT is never what was typed. A setup window
 * that posted the field verbatim would authenticate against a hub that had not
 * been cut over and then save a config the editor cannot use.
 *
 * A malformed secret is reported with secret.mjs's own words rather than being
 * sent as an empty token and coming back as "the hub rejected that token" —
 * which would be true, useless, and point at the wrong end of the problem.
 */
bridge.handle("zevet:test", async (_e, { token }) => {
  const auth = authFor({ secret: String(token || "") });
  if (auth.error) return { ok: false, why: `That secret is not usable: ${auth.error}` };
  // An empty field resolves cleanly to an empty token — `resolveAuth` has
  // nothing to complain about — and would go to the hub as a 401 reported as
  // "it rejected that token", which is true and points at the wrong end.
  if (!auth.token) return { ok: false, why: "There is no secret to check yet." };
  try {
    const base = targetHub();
    const res = await fetch(`${base}/dist/manifest.json`, {
      headers: { "x-zevet-token": auth.token },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) return { ok: false, why: "Rejected" };
    if (!res.ok) return { ok: false, why: `Server error ${res.status}` };
    const m = await res.json();
    return { ok: true, version: m.version };
  } catch (err) {
    return { ok: false, why: `Could not reach it: ${err.message}` };
  }
});

/**
 * Write ~/.zevet/config.json.
 *
 * ⚠️ A MASTER SECRET IS SAVED AS `secret`, NOT AS `token`, and the difference is
 * the whole scheme: the document key is derived from `secret` and the hub is
 * only ever shown the derived auth token. A config that stored the typed value
 * under `token` would look identical to a legacy install, so `resolveAuth`
 * would present it to the hub verbatim AND the editor would refuse to run for
 * want of a secret — one mistake producing both failures at once.
 *
 * ⚠️ THE LEGACY BRANCH IS DELIBERATE AND IS NOT A GUESS ABOUT THE VALUE. A raw
 * token generated the way the README says (`openssl rand -hex 24`) is 48 hex
 * characters, which is *exactly* what a master secret looks like — the two are
 * textually indistinguishable and no amount of sniffing will separate them. So
 * nothing here tries: anything that parses as a master secret is saved as one,
 * because that is what the current setup scripts hand out. The legacy spelling
 * is preserved only for a value that CANNOT be a master secret (not hex, or too
 * short) on a machine that already had a raw token — the install that is
 * re-running setup to change its hub, not to change its credential.
 *
 * The consequence, said plainly: a legacy user who re-runs setup and pastes
 * their old hex token gets it saved as a secret, and the derived token will not
 * match a hub that has not been cut over. `zevet:test` runs first and fails
 * with a 401 before this is ever reached, so they find out at the check button
 * rather than at a blank board — but they are not TOLD which of the two it was,
 * because nothing here can know.
 */
bridge.handle("zevet:save", (_e, cfg) => {
  const hub = targetHub();
  const actor = String(cfg.actor);
  // `token` is what setup.html still calls the field; what it holds is now the
  // master secret. The field name is not worth a coordinated rename across a
  // file another author is holding.
  const typed = String(cfg.token || "");

  const existing = readConfig();

  const auth = typed ? authFor({ secret: typed }) : { error: "empty" };
  if (!auth.error && auth.secret) {
    // A pasted secret REPLACES a GitHub session deliberately: somebody typing a
    // master secret into the fallback field is telling us the session is not
    // the credential they want to use, and keeping both would leave
    // `resolveAuth` preferring a session they were trying to get away from.
    writeConfig({ hub, secret: auth.secret, actor });
    return true;
  }

  /* ⚠️ WHATEVER WAS TYPED DID NOT PRODUCE A NEW, USABLE SECRET — empty, or
   * garbage — KEEP THE ONE ALREADY THERE, WHICHEVER SHAPE IT IS.
   *
   * Since GitHub sign-in, the credential is established BEFORE the name is
   * typed rather than at the same time, so setup calls this a second time with
   * the manual key field untouched purely to save an edited display name.
   * Treating a merely-empty field as "clear it" would sign the machine out at
   * the last click of setting it up — and treating a NON-empty-but-invalid
   * field the same as a deliberate new credential is worse: MEASURED, a stale
   * value already sitting in that field (Chromium's own password-manager
   * autofill reaches `type="password"` inputs even with autocomplete="off" —
   * see setup.html's `signedIn()`, which now clears it) survived a GitHub
   * sign-in that had just written a working `session`, and the old separate
   * branch here (`existing.token ? writeConfig({hub, token, actor}) : ...`)
   * threw that session away in favour of a legacy token field the OAuth path
   * never even writes — a signed-in Finish click that quietly signed nobody
   * in. Spreading `existing` wholesale is the fix: nothing already on disk is
   * ever dropped by a Finish click that typed nothing new. */
  if (existing && (existing.session || existing.secret || existing.token)) {
    writeConfig({ ...existing, hub, actor: actor || existing.actor || "" });
    return true;
  }

  // Neither a usable secret nor a machine with anything to keep. Writing it
  // anyway would produce a config that cannot authenticate and an editor
  // that cannot start, and `readConfig` would call it valid — the worst of
  // the available outcomes. Refused instead; `zevet:test` has already told
  // the user why in the same words.
  return false;
});

/* ── Sign in with GitHub ─────────────────────────────────────────────────────
 *
 * Three calls rather than one, because the flow has to paint a code and then
 * sit for up to a quarter of an hour: `start` returns what to show, `wait`
 * resolves when GitHub answers, `cancel` gives the window a way out.
 *
 * ⚠️ ONE ATTEMPT AT A TIME, ENFORCED. Two overlapping flows would each hold a
 * device code and each try to write the config, and the loser would overwrite
 * the winner with a session the hub had already superseded. Starting a second
 * one cancels the first.
 */
let signIn = null;

bridge.handle("zevet:githubStart", async (_e, { team } = {}) => {
  try {
    if (signIn) signIn.cancel();
    signIn = new GithubSignIn({ hub: targetHub(), team });
    const r = await signIn.start();
    // Opened from the MAIN process, never by the renderer. The board window
    // loads remote HTML from the hub, and a renderer that could open arbitrary
    // URLs in the system browser is a hub that can too.
    // No browser, or none that would take it: the code is on screen, that is the
    // entire reason it is on screen, and `opened` lets the window say so.
    const opened = await openSafe(r.verificationUriComplete).then(() => true, () => false);
    return { ok: true, userCode: r.userCode, url: r.verificationUriComplete, expiresIn: r.expiresIn, opened };
  } catch (err) {
    signIn = null;
    return { ok: false, error: err.message };
  }
});

/* ── Signing in with Google ────────────────────────────────────────────────
 *
 * The same three calls, against a flow that never shows the person a code:
 * Google's web flow sends them to a browser, and the browser lands back on the
 * HUB rather than here. `start` therefore returns a URL and nothing to read
 * out; what `wait` polls is the hub's pairing code, not Google. See
 * desktop/google-signin.js.
 *
 * ⚠️ THE SAME `signIn` SLOT AS GITHUB, DELIBERATELY. One attempt at a time was
 * already enforced for two overlapping GitHub flows; a GitHub flow and a Google
 * flow racing is the same bug with two names, and each would try to write the
 * config over the other.
 */
const startWebSignIn = (provider) => async (_e, { team } = {}) => {
  try {
    if (signIn) signIn.cancel();
    signIn = new GoogleSignIn({ hub: targetHub(), team, provider });
    const r = await signIn.start();
    // Opened from the MAIN process, never by the renderer — same rule as the
    // GitHub flow above, and it matters more here: this URL carries the pairing
    // code that a completed sign-in will be handed over for.
    // No browser, or none that would take it: the URL goes back to the window
    // with `opened: false` so it can say so rather than wait on nothing.
    const opened = await openSafe(r.authUrl).then(() => true, () => false);
    // No `userCode`: there is nothing for the person to read or type, which is
    // the whole reason this flow is the web one and not Google's device flow.
    return { ok: true, url: r.authUrl, expiresIn: r.expiresIn, domain: r.domain, opened };
  } catch (err) {
    signIn = null;
    return { ok: false, error: err.message };
  }
};
bridge.handle("zevet:googleStart", startWebSignIn("google"));
bridge.handle("zevet:microsoftStart", startWebSignIn("microsoft"));

/** The team's name from the hub, for the setup window. "" when the hub is an
 *  older build, or slow: the name is a label, never a reason to fail sign-in. */
async function fetchTeamName(hub, token) {
  try {
    const res = await fetch(`${String(hub).replace(/\/+$/, "")}/auth/whoami`, {
      headers: { "x-zevet-token": token },
      signal: AbortSignal.timeout(4000),
    });
    const body = res.ok ? await res.json() : null;
    return body && typeof body.teamName === "string" ? body.teamName : "";
  } catch {
    return "";
  }
}

/** D-603: the team name family.js sends to Masora at pairing time -- same
 *  `fetchTeamName` the setup window uses, cached for a few minutes so a 60s
 *  connect attempt is not a whoami round trip every tick. The heartbeat's own
 *  team_name/people come from a separate, roster-verified path (readHubAuth,
 *  below).
 *  ponytail: a module-level cache, not an LRU -- one machine has one team. */
let teamNameCache = { at: 0, name: "" };
async function currentTeamName() {
  if (Date.now() - teamNameCache.at < 5 * 60 * 1000) return teamNameCache.name;
  const cfg = readConfig();
  const auth = authFor(cfg);
  if (auth.error || !auth.token || !cfg.hub) return teamNameCache.name;
  const name = await fetchTeamName(cfg.hub, auth.token);
  teamNameCache = { at: Date.now(), name };
  return name;
}

/**
 * What happens once a sign-in succeeds — ONE implementation, both providers.
 *
 * ⚠️ THIS IS THE PART THAT PRODUCES A HALF-WORKING INSTALL WHEN IT IS WRONG,
 * and two copies of it would be two chances to get it wrong in different ways.
 * The providers differ in how they ASK. They do not differ in what an answer
 * means, and nothing below reads the provider.
 */
async function awaitSignIn(what) {
  if (!signIn) return { ok: false, error: `Start ${what} sign-in first.` };
  const attempt = signIn;
  try {
    const r = await attempt.wait();

    /* ⚠️ THE SECRET IS WRITTEN, THE SESSION IS WRITTEN, AND THE HUB IS KEPT.
     * `secret` is what the editor derives its document key from and `session`
     * is what authenticates to the hub — see resolveAuth in client/secret.mjs,
     * which prefers the session precisely so that revoking somebody has an
     * effect. Dropping either one produces a half-working install: no secret
     * means a board with a dead editor, no session means a machine that cannot
     * be revoked. */
    const existing = readConfig() || {};
    const hub = String((attempt.base || existing.hub || "")).replace(/\/+$/, "");
    writeConfig({
      hub,
      secret: r.secret || existing.secret || "",
      session: r.token,
      // The login is a far better actor name than a hostname, and it is the
      // name teammates will recognise on the board. An actor already chosen by
      // hand is not overwritten. A Google login is an email address, so the
      // local part is used — a board of rows reading "name@usemasora.com"
      // repeats the domain on every line and hides the part that identifies.
      actor: existing.actor || String(r.login || "").split("@")[0],
      login: r.login,
      provider: what.toLowerCase(),
    });
    sso.publish("signed_in");
    return { ok: true, login: r.login, owner: r.owner, teamName: await fetchTeamName(hub, r.token) };
  } catch (err) {
    return { ok: false, error: err.message, cancelled: err.message === "cancelled" };
  } finally {
    if (signIn === attempt) signIn = null;
  }
}

bridge.handle("zevet:githubWait", () => awaitSignIn("GitHub"));
bridge.handle("zevet:googleWait", () => awaitSignIn("Google"));
bridge.handle("zevet:microsoftWait", () => awaitSignIn("Microsoft"));

/* Cancelling is provider-blind — there is one attempt in flight and this ends
 * it, whichever kind it is. Registered under both names so the renderer can
 * call the one that matches the button it is next to. */
const cancelSignIn = () => {
  if (signIn) signIn.cancel();
  signIn = null;
  return true;
};
bridge.handle("zevet:githubCancel", cancelSignIn);
bridge.handle("zevet:googleCancel", cancelSignIn);
bridge.handle("zevet:microsoftCancel", cancelSignIn);

/* ── Creating a team ───────────────────────────────────────────────────────
 *
 * A first-run person has no team address to type and, until now, no way to
 * get one: the setup window offered only "join", never "create". This asks
 * the hub to mint a brand new, independently-owned team (hub/server.mjs's
 * `/team/create`) and hands back its slug; the renderer then passes it to
 * `githubStart`/`googleStart` so the sign-in that follows claims that team
 * (trust-on-first-use, exactly like an unclaimed hub) rather than the
 * hub's default one. Unauthenticated on the hub side — this call decides
 * nothing by itself, same as the sign-in "start" calls above.
 */
bridge.handle("zevet:teamCreate", async (_e, { name } = {}) => {
  const base = targetHub();
  const teamName = String(name || "").trim();
  if (!teamName) return { ok: false, error: "Name the team." };
  try {
    const res = await fetch(`${base}/team/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: teamName }),
      signal: AbortSignal.timeout(15000),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: `Server error ${res.status}` };
    }
    if (!res.ok || !body || !body.ok) {
      return { ok: false, error: res.status === 409 ? "Taken" : (body && body.error) || `HTTP ${res.status}`, ...(body && body.suggest ? { suggest: body.suggest } : {}) };
    }
    return { ok: true, team: body.team, name: body.name || teamName };
  } catch {
    return { ok: false, error: "Offline" };
  }
});

/** Does a team by this name exist on the hub? `{ ok, exists, team }`. */
bridge.handle("zevet:teamResolve", async (_e, { name } = {}) => {
  const base = targetHub();
  if (!String(name || "").trim()) return { ok: false, error: "Name?" };
  try {
    const res = await fetch(`${base}/team/resolve?name=${encodeURIComponent(String(name))}`, { signal: AbortSignal.timeout(15000) });
    const body = await res.json();
    if (!res.ok) return { ok: false, error: "Failed" };
    return { ok: true, exists: body.exists === true, team: body.team || "" };
  } catch {
    return { ok: false, error: "Offline" };
  }
});

/**
 * Redeem an invite key — hub/server.mjs's `/team/join`. Mints a session and
 * hands back the team's master secret exactly like a completed GitHub/Google
 * sign-in (`awaitSignIn`, above), so this writes the config the same way and
 * returns the same shape a caller already knows how to handle: a login and a
 * yes, never the secret or the session (same bridge rule as
 * `githubWait`/`googleWait`, and for the same reason — see preload.js).
 *
 * Factored out of the IPC handler (D-615) so `desktop/setup.html`'s own Join
 * button and a relayed `team.join` from Masora's onboarding (family.js's
 * `joinTeam`, below) run the identical call and config write — a machine
 * cannot tell the two apart afterwards.
 */
async function teamJoin(team, key) {
  const base = targetHub();
  const t = String(team || "").trim();
  const k = String(key || "").trim();
  if (!t) return { ok: false, error: "Team?" };
  if (!k) return { ok: false, error: "Key?" };
  try {
    const res = await fetch(`${base}/team/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team: t, key: k }),
      signal: AbortSignal.timeout(15000),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: `Server error ${res.status}` };
    }
    if (!res.ok || !body || !body.ok) return { ok: false, error: (body && body.error) || `HTTP ${res.status}` };

    const existing = readConfig() || {};
    writeConfig({
      hub: base,
      secret: body.secret || existing.secret || "",
      session: body.token,
      actor: existing.actor || String(body.login || "").split("@")[0],
      login: body.login,
    });
    sso.publish("signed_in");
    return { ok: true, login: body.login, owner: Boolean(body.owner), teamName: await fetchTeamName(base, body.token) };
  } catch {
    return { ok: false, error: "Offline" };
  }
}

bridge.handle("zevet:teamJoin", (_e, { team, key } = {}) => teamJoin(team, key));

/* One login for everyone: Masora's signed assertion (family.js, zevet.credentials.json `hub`) in place of a team key.
 * The hub answers like /team/join, so the same config lands: this machine cannot tell the two apart afterwards. */
async function hubSignInFromMasora(hubUrl, assertion) {
  try {
    const res = await fetch(`${hubUrl}/auth/masora`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assertion }),
      signal: AbortSignal.timeout(15000),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: `Server error ${res.status}` };
    }
    if (!res.ok || !body || !body.ok) return { ok: false, error: (body && body.error) || `HTTP ${res.status}` };
    const existing = readConfig() || {};
    writeConfig({
      ...existing,
      hub: hubUrl,
      secret: body.secret || existing.secret || "",
      session: body.token,
      actor: existing.actor || String(body.login || "").split("@")[0],
      login: body.login,
    });
    sso.publish("signed_in"); // Masora -> Zevet -> Voice: the same session reaches Voice through sso.json
    return { ok: true, login: body.login, owner: Boolean(body.owner) };
  } catch {
    return { ok: false, error: "Offline" };
  }
}

/* ── Sign out of GitHub, from Settings ─────────────────────────────────────
 *
 * The counterpart to the three calls above, for a machine that signed in
 * during setup and wants out without re-running it. Ends the hub session
 * first (so a stolen config stops working promptly, not at the idle TTL),
 * then drops `session` — and only `session` — from the local config. The
 * secret, hub and actor stay: this machine goes back to team-key exactement
 * as it was before signing in, which is what makes the operation safe to
 * offer with one click and no confirmation. Reconnecting is the same click
 * in reverse.
 */
const signOut = async () => {
  const r = await endSession();
  if (r.hadSession) sso.publish("signed_out"); // and every other app in the family (sso.js)
  return { ok: r.ok, loggedOut: r.loggedOut };
};
/** signOut without telling the family: also what a sign-out adopted FROM the family runs. */
async function endSession() {
  const cfg = readConfig() || {};
  const session = typeof cfg.session === "string" ? cfg.session : "";
  if (!session) return { ok: true, loggedOut: false, hadSession: false };
  const hub = String(cfg.hub || "").replace(/\/+$/, "");
  let loggedOut = false;
  if (hub) {
    try {
      const res = await fetch(`${hub}/auth/logout`, {
        method: "POST",
        headers: { "x-zevet-token": session },
        signal: AbortSignal.timeout(8000),
      });
      loggedOut = res.ok;
    } catch {
      // The hub is unreachable or an older build without the route. The local
      // session is still dropped below: a credential this machine will not
      // present again is as good as revoked from this side, and keeping it
      // would leave the user signed in after asking out.
    }
  }
  const rest = { ...cfg };
  delete rest.session;
  writeConfig(rest);
  return { ok: true, loggedOut, hadSession: true };
}
// Signing out ends a SESSION, and a session does not remember which provider
// minted it — so this is one function, under the name each button expects.
bridge.handle("zevet:githubLogout", signOut);

// Setup's "Send": the text is the person's; the log is read, bounded and scrubbed here (user-report.js).
bridge.handle("zevet:sendReport", (_e, { text } = {}) =>
  userReport.send(Sentry, {
    text,
    version: APP_VERSION,
    log: userReport.readTail(path.join(app.getPath("logs"), "zevet.log")),
  }));

/* ── Sign out of the TEAM, from Settings (or the setup screen) ────────────
 *
 * `signOut` above ends one identity's session and keeps the team key
 * working. This is the bigger button: it ends the hub session too, then
 * drops `session`, `secret` AND `hub` — so `readConfig()` sees no hub and
 * this machine falls straight back to first-run (Team + Key). The config is
 * copied aside first, unconditionally, so "I signed into the wrong team" is
 * recoverable by reading a file rather than by re-inviting the person.
 */
const signOutTeam = async () => {
  const cfg = readConfig() || {};
  const session = typeof cfg.session === "string" ? cfg.session : "";
  const hub = String(cfg.hub || "").replace(/\/+$/, "");
  if (session && hub) {
    try {
      await fetch(`${hub}/auth/logout`, {
        method: "POST",
        headers: { "x-zevet-token": session },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      // Hub unreachable, or an older build without the route — the local
      // config is cleared below regardless.
    }
  }
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.copyFileSync(CONFIG, path.join(HOME, `config.json.bak-${Date.now()}`));
  } catch {
    // No existing config file to back up.
  }
  const rest = { ...cfg };
  delete rest.session;
  delete rest.secret;
  delete rest.hub;
  writeConfig(rest);
  if (session) sso.publish("signed_out");
  if (boardWindow && !boardWindow.isDestroyed()) boardWindow.close();
  openSetup(null);
  return { ok: true };
};
bridge.handle("zevet:signOutTeam", signOutTeam);
bridge.handle("zevet:googleLogout", signOut);
bridge.handle("zevet:microsoftLogout", signOut);

bridge.handle("zevet:pickRepo", async () => {
  const picked = await dialog.showOpenDialog(setupWindow, {
    title: "Choose a project folder",
    properties: ["openDirectory"],
  });
  pickedRepo = picked.canceled ? null : path.resolve(picked.filePaths[0]);
  return picked.canceled ? null : picked.filePaths[0];
});

// Only a folder the user opened as a workspace, or just picked in setup, may be
// handed to the installer — never a path the renderer made up (audit B7).
let pickedRepo = null;
bridge.handle("zevet:install", async (_e, repo) => {
  const root = knownRoot(repo) || (pickedRepo && path.resolve(String(repo || "")) === pickedRepo ? pickedRepo : null);
  if (!root) return { ok: false, detail: "That folder is not one you opened in Zevet." };
  return installHooks(root);
});

bridge.handle("zevet:done", () => {
  const cfg = readConfig();
  if (!cfg) return false;
  openBoard(cfg);
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
  return true;
});

/* ── Linking with Masora (T5, docs/contracts/cross_app_context.md) ─────────
 *
 * The device-code pairing against masora2's /api/connector/register runs in
 * the BACKGROUND (masora-link.js), started by openBoard() and never awaited by
 * onboarding. Settings reads `masoraLinkStatus`; the only browser open is
 * `masoraLinkApprove`, from a click. The token ends in safeStorage
 * (desktop/masora.js) -- never handed to a renderer.
 */
const masoraLink = new MasoraLink({
  readConfig: () => masora.readConfig(),
  MasoraPair: masora.MasoraPair,
  saveToken: (token) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("This machine's OS keychain is unavailable.");
    masora.saveToken(token, (s) => safeStorage.encryptString(s));
  },
  openExternal: (url) => openSafe(url),
  host: os.hostname(),
  platform: process.platform,
});

/* ── The family: Masora, Zevet and Voice find each other (desktop/family.js) ──
 * Pairs with a Masora on this machine with no click; the device-code flow above
 * stays the fallback for one on another machine. */
/* Single sign-in (sso.js, docs/specs/2026-10-07-single-sign-in.md): a hub sign-in or sign-out here is published,
 * encrypted, to the family dir; one Zevet Voice published is adopted here on the next poll, no click. The adopted
 * session lands exactly where awaitSignIn puts one, so nothing downstream can tell the two apart. */
const sso = new Sso({
  dir: familyDir(),
  hub: () => targetHub(),
  session: () => {
    const cfg = readConfig();
    if (!cfg || typeof cfg.session !== "string" || !cfg.session) return null;
    return { token: cfg.session, login: cfg.login, provider: cfg.provider, secret: cfg.secret };
  },
  adopt: (p, who) => {
    const existing = readConfig() || {};
    writeConfig({
      ...existing,
      hub: targetHub(),
      // The envelope's secret belongs to the session's team; a key-only machine's own one is kept otherwise.
      secret: (typeof p.secret === "string" && p.secret) || existing.secret || "",
      session: p.token,
      actor: existing.actor || String(who.login).split("@")[0],
      login: who.login,
      ...(typeof p.provider === "string" && p.provider ? { provider: p.provider } : {}),
    });
    teamNameCache = { at: 0, name: "" };
  },
  endSession: () => endSession(),
  log: (m) => console.log(`[family] ${m}`),
});
const SSO_POLL_MS = 3000;
let ssoTimer = null;

const family = new Family({
  dir: familyDir(),
  readMasora: () => masora.readConfig(),
  saveUrl: (url) => masora.saveUrl(url),
  saveToken: (token, member, canonical) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("This machine's OS keychain is unavailable.");
    masora.saveToken(token, (s) => safeStorage.encryptString(s), member, canonical);
    masoraLink.cancel(); // paired: the code flow has nothing left to wait for
  },
  clearToken: () => masora.unpair(),
  openExternal: (url) => openSafe(url),
  // Zevet's OWN hub session — same readConfig()/authFor() the main process
  // already uses for its own hub calls (see resolveCredential, above). Masora
  // never receives this: the roster it reads is only the heartbeat's output.
  readHubAuth: () => {
    const cfg = readConfig();
    if (!cfg) return null;
    const auth = authFor(cfg);
    if (auth.error || !auth.token) return null;
    return { hub: cfg.hub.replace(/\/+$/, ""), token: auth.token };
  },
  // The one identity Zevet genuinely knows: whoever `cfg.login` says signed
  // in to ITS OWN hub (awaitSignIn, above) -- a GitHub username, or a Google
  // account's email (google-auth.mjs's `login: email`). Nothing else here
  // is known reliably enough to send, and an empty login sends nothing.
  readIdentity: () => {
    const cfg = readConfig();
    const login = cfg && typeof cfg.login === "string" ? cfg.login.trim() : "";
    if (!login) return null;
    return login.includes("@") ? { email: login } : { github_login: login };
  },
  // The normal self-update: look, and if a build is ready, install it.
  runUpdate: async () => {
    const s = await appUpdater.check();
    if (s && s.phase === "ready" && s.canInstall) await appUpdater.install();
  },
  // The signed family index (family-index.js) names a newer Zevet: look now, never install. The keys are the
  // shell's (a payload cannot change what it trusts); none pinned yet means the poll stays off.
  indexKeys: familyIndexKeys(),
  onIndexNewer: () => {
    const phase = appUpdater.state.phase;
    return phase === "ready" || phase === "downloading" || phase === "checking" ? undefined : appUpdater.check();
  },
  readTeam: () => currentTeamName(),
  // D-615: Masora's onboarding relays a {team, key} invite via team.join;
  // this runs the identical call/config-write desktop/setup.html's own Join
  // button makes (teamJoin, above) — no separate hub credential of any kind
  // is ever held by or sent to Masora.
  joinTeam: (team, key) => teamJoin(team, key),
  joinHub: hubSignInFromMasora,
  version: APP_VERSION,
  installPath: path.dirname(app.getPath("exe")),
});
bridge.handle("zevet:familyStatus", () => family.status());

/* ── Is this machine's activity reaching the hub? ──────────────────────────────
 * Repairs a Claude hook whose script has gone missing in any folder this
 * machine has opened, then asks the hub whether it accepts this credential and
 * has heard from this person since the last agent started. One line, or "". */
let reportingLine = "";
async function checkReporting() {
  const cfg = readConfig();
  if (!cfg) return;
  const auth = authFor(cfg);
  if (auth.error || !auth.token) {
    reportingLine = "This machine's credential is unusable. Sign in again.";
    return;
  }
  try {
    const failedRepos = await reportingHealth.repairStaleHooks(readWorkspaces(), { install: installHooks });
    reportingLine = await reportingHealth.reportingProblem({ hub: cfg.hub, token: auth.token, fetchImpl: net.fetch.bind(net), agentStartedAt: lastAgentStartAt, failedRepos });
  } catch (err) {
    reportingLine = "";
  }
}
function startReportingHealth() {
  setTimeout(() => void checkReporting(), 15000).unref();
  setInterval(() => void checkReporting(), 5 * 60 * 1000).unref();
}
bridge.handle("zevet:reportingStatus", async () => {
  if (lastAgentStartAt) await checkReporting();
  return { problem: reportingLine };
});
bridge.handle("zevet:familyAct", (_e, { app: which, action } = {}) => family.act(String(which), String(action)));

bridge.handle("zevet:masoraConfig", () => masora.readConfig());

bridge.handle("zevet:masoraSaveUrl", (_e, { url } = {}) => {
  const cfg = masora.saveUrl(url);
  masoraLink.cancel();
  masoraLink.start(); // a new address is a new attempt
  return cfg;
});

bridge.handle("zevet:masoraLinkStatus", () => masoraLink.status());
bridge.handle("zevet:masoraLinkStart", () => {
  masoraLink.start();
  return masoraLink.status();
});
bridge.handle("zevet:masoraLinkApprove", () => masoraLink.approve());

bridge.handle("zevet:masoraUnpair", () => {
  masora.unpair();
  masoraLink.cancel();
  return true;
});

bridge.handle("masora:sources", async () => {
  const cfg = masora.readConfig();
  if (!cfg.paired) return { sources: [] };
  const token = masora.loadToken((b) => safeStorage.decryptString(b));
  if (!token) return { error: "Could not decrypt token" };
  try {
    const url = cfg.url;
    const res = await fetch(`${url.replace(/\/+$/, "")}/api/sources`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401) void family.repair(); // a revoked token: pair again
    if (!res.ok) return { error: "token" }; // 401/403 → auth issue
    const data = await res.json();
    if (!Array.isArray(data)) return { sources: [] };
    return {
      sources: data.map((s) => ({
        kind: s.kind || s.type || "unknown",
        status: s.status || "unknown",
      })),
    };
  } catch {
    return { error: "network" };
  }
});

bridge.handle("masora:connect", async (_e, { provider } = {}) => {
  const cfg = masora.readConfig();
  if (!cfg.paired) {
    return { error: "Not paired with Masora" };
  }
  const token = masora.loadToken((b) => safeStorage.decryptString(b));
  if (!token) return { error: "Could not decrypt token" };
  return masoraConnect.connectProvider({
    provider,
    baseUrl: cfg.url,
    token,
    shell,
    fetchImpl: fetch,
  });
});

/* ── Model credentials (D-0NN) ──────────────────────────────────────────
 *
 * Team credentials live on the hub (hub/accounts.mjs + its /team/credentials
 * routes) and are reached over HTTP, same as everything else authFor()
 * gates. Personal credentials never leave this machine (desktop/credentials.js,
 * safeStorage-encrypted like masora.js's own token) and are reached only
 * through these IPC calls — the board never sees a personal secret, only its
 * metadata, same rule zevet:config already follows for the hub secret.
 *
 * `credentialEnvFor()`, a few hundred lines up, is what actually reads the
 * chosen default at spawn time; these four handlers are Settings' CRUD on
 * top of the same two stores.
 */

/** List, tagged by scope, plus the member's own default (if any). A team
 *  fetch that fails (no hub, no auth, hub down) degrades to "no team
 *  credentials" rather than failing the whole call — the personal list is
 *  still useful on its own. */
bridge.handle("zevet:listCredentials", async () => {
  const cfg = readConfig() || {};
  const personal = credentials.listCredentials().map((c) => ({ ...c, scope: "personal" }));

  let team = [];
  const auth = authFor(cfg);
  const hub = String(cfg.hub || "").replace(/\/+$/, "");
  if (!auth.error && auth.token && hub) {
    try {
      const res = await fetch(`${hub}/team/credentials`, { headers: { "x-zevet-token": auth.token }, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const body = await res.json();
        if (Array.isArray(body.credentials)) team = body.credentials.map((c) => ({ ...c, scope: "team" }));
      }
    } catch {
      // Hub unreachable or too old for the route — team list stays empty.
    }
  }

  return { ok: true, credentials: [...team, ...personal], default: cfg.defaultCredential || null };
});

/** Add a credential in the given scope. Team validation (provider/kind,
 *  Anthropic key shape, subscription tokens refused) all happens on the hub,
 *  same as it does for a board client talking to it directly — this is a
 *  second caller of the same route, not a second copy of the rule. */
bridge.handle("zevet:addCredential", async (_e, { scope, label, provider, kind, key } = {}) => {
  if (scope === "personal") {
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: "This machine's OS keychain is unavailable." };
    const { id } = credentials.addCredential({ label, provider, kind, key }, (s) => safeStorage.encryptString(s));
    return { ok: true, id };
  }
  if (scope === "team") {
    const cfg = readConfig() || {};
    const auth = authFor(cfg);
    const hub = String(cfg.hub || "").replace(/\/+$/, "");
    if (auth.error || !auth.token || !hub) return { ok: false, error: auth.error || "not connected" };
    try {
      const res = await fetch(`${hub}/team/credentials`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-zevet-token": auth.token },
        body: JSON.stringify({ label, provider, kind, key }),
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
      return { ok: true, id: body.id };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }
  return { ok: false, error: `unknown scope: ${scope}` };
});

bridge.handle("zevet:removeCredential", async (_e, { scope, id } = {}) => {
  if (scope === "personal") return { ok: credentials.removeCredential(id) };
  if (scope === "team") {
    const cfg = readConfig() || {};
    const auth = authFor(cfg);
    const hub = String(cfg.hub || "").replace(/\/+$/, "");
    if (auth.error || !auth.token || !hub) return { ok: false, error: auth.error || "not connected" };
    try {
      const res = await fetch(`${hub}/team/credentials/${encodeURIComponent(String(id || ""))}`, {
        method: "DELETE",
        headers: { "x-zevet-token": auth.token },
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }
  return { ok: false, error: `unknown scope: ${scope}` };
});

/** Which credential this member's agents spawn with: `{scope, id}`, or
 *  `{scope: "auto"}` to walk `credentialLadder` (below) instead of a single
 *  fixed choice. `null`/omitted clears it — spawn exactly as today,
 *  inheriting process.env — see credentialEnvFor. */
bridge.handle("zevet:setDefaultCredential", (_e, arg) => {
  const cfg = readConfig() || {};
  const next = { ...cfg };
  if (arg && arg.scope === "auto") next.defaultCredential = { scope: "auto" };
  else if (arg && arg.scope && arg.id) next.defaultCredential = { scope: arg.scope, id: arg.id };
  else delete next.defaultCredential;
  writeConfig(next);
  return { ok: true, default: next.defaultCredential || null };
});

/**
 * The "Auto" rotation ladder: an ordered list of `{credentialId, untilPct}`.
 * Saved and read back verbatim — credential-ladder.js's `choose()` is the
 * only thing that interprets it, at spawn time, and it does not run here so
 * that a member can edit the ladder while offline or before either
 * credential it names has been probed even once.
 */
bridge.handle("zevet:credentialLadder", () => (readConfig() || {}).credentialLadder || []);

bridge.handle("zevet:setCredentialLadder", (_e, ladder) => {
  const cfg = readConfig() || {};
  const clean = Array.isArray(ladder)
    ? ladder
        .filter((s) => s && typeof s.credentialId === "string" && s.credentialId && Number.isFinite(s.untilPct))
        .map((s) => ({ credentialId: s.credentialId, untilPct: Math.max(0, Math.min(100, s.untilPct)) }))
    : [];
  writeConfig({ ...cfg, credentialLadder: clean });
  return { ok: true, ladder: clean };
});

// ---- the local workspace ---------------------------------------------------

/** Folders this machine has opened. Stored beside the config, never on the hub. */
function workspacesPath() {
  return path.join(HOME, "workspaces.json");
}
function readWorkspaces() {
  try {
    const list = JSON.parse(fs.readFileSync(workspacesPath(), "utf8").replace(/^﻿/, ""));
    return Array.isArray(list) ? list.filter((d) => typeof d === "string" && fs.existsSync(d)) : [];
  } catch {
    return [];
  }
}
function writeWorkspaces(list) {
  fs.mkdirSync(HOME, { recursive: true });
  atomicWriteJson(workspacesPath(), list);
}

/**
 * A renderer may only name a root it has already been given.
 *
 * Without this, `tree("C:\\")` from a compromised page walks the whole disk.
 * The allowlist is the folders the user picked with the native dialog, which
 * is the only place a new root can come from.
 */
function knownRoot(root) {
  return resolveKnown(root, readWorkspaces(), agentSessions.originOf);
}

/**
 * The `knownRoot` guard exists because the RENDERER is untrusted: a compromised
 * web page could otherwise ask the main process to start a process anywhere on
 * disk. The local control API (desktop/agent-api.js) is authenticated by a
 * bearer secret only a user-only file on this machine holds, which is the same
 * trust level as someone with a shell already has — so its `spawn` may target
 * any directory that exists, not only a workspace opened through the UI.
 */
function trustedDir(root) {
  const want = path.resolve(String(root || ""));
  try {
    return fs.statSync(want).isDirectory() ? want : null;
  } catch {
    return null;
  }
}

bridge.handle("local:workspaces", () =>
  readWorkspaces().map((dir) => ({ dir, name: path.basename(dir), repo: localFs.isProbablyRepo(dir) })),
);

bridge.handle("local:addWorkspace", async () => {
  const picked = await dialog.showOpenDialog(boardWindow || setupWindow, {
    title: "Open a folder",
    properties: ["openDirectory"],
  });
  if (picked.canceled || !picked.filePaths[0]) return null;
  const dir = picked.filePaths[0];
  const list = readWorkspaces().filter((d) => path.resolve(d) !== path.resolve(dir));
  list.unshift(dir);
  writeWorkspaces(list.slice(0, 12));
  return { dir, name: path.basename(dir), repo: localFs.isProbablyRepo(dir) };
});

/** Per-repo opt-in for pushing agent sessions to Masora (C1: `zevet.masoraRepos`,
 *  default none -- nothing is sent for a folder until this returns true for it). */
bridge.handle("local:masoraRepos", () => masora.reposFor());

bridge.handle("local:masoraRepoToggle", (_e, { root, on } = {}) => {
  const dir = knownRoot(root);
  if (!dir) return { ok: false, error: "not an opened workspace" };
  return { ok: true, repos: masora.setRepoOpted(dir, Boolean(on)) };
});

bridge.handle("local:tree", async (_e, root) => {
  const dir = knownRoot(root);
  if (!dir) return { ok: false, error: "not an opened workspace" };
  // `origin`: a worktree's events are filed under its origin repo (hook.mjs),
  // so the tree matches them by the origin's name and fingerprint.
  const r = await localFs.listTreeAsync(dir, {});
  return r && r.ok ? { ...r, origin: agentSessions.originOf(dir) || dir } : r;
});

bridge.handle("local:read", (_e, { root, relPath }) => {
  const dir = knownRoot(root);
  if (!dir) return { ok: false, error: "not an opened workspace" };
  return localFs.readTextFile(dir, String(relPath || ""), {});
});

/**
 * The write half, and the first time this app changes a file on somebody's
 * disk on a renderer's say-so.
 *
 * `knownRoot` FIRST, exactly as local:tree and local:read do it, and for a
 * sharper reason: without it a compromised page names `C:\` as the root and
 * every containment check in local-fs.js then passes, because everything is
 * inside `C:\`. The allowlist is what makes "inside the workspace" mean
 * anything at all, and it is a folder the user chose from a native dialog.
 *
 * `opts` is FILTERED and not forwarded. A renderer may say how it wants its
 * newlines and its BOM spelled, because that is fidelity to a file it already
 * opened. It may not pass `maxBytes` (it would set its own size limit) and it
 * may not pass `exclude` (it would shorten its own skip list, and a shorter
 * skip list is a path into `.git/hooks`). Building a fresh object rather than
 * spreading theirs is the whole guard: anything not named here cannot arrive.
 *
 * The board window that calls this loads a REMOTE origin. openBoard() argues
 * why it gets a bridge at all; that argument is unchanged and is not revisited
 * here, but it was made about reading, and this is a write.
 */
bridge.handle("local:write", (_e, { root, relPath, text, opts }) => {
  const dir = knownRoot(root);
  if (!dir) return { ok: false, error: "not an opened workspace" };
  if (typeof text !== "string") return { ok: false, error: "nothing to write" };
  const given = opts && typeof opts === "object" ? opts : {};
  return localFs.writeTextFile(dir, String(relPath || ""), text, {
    bom: typeof given.bom === "boolean" ? given.bom : undefined,
    eol: given.eol === "crlf" || given.eol === "lf" ? given.eol : undefined,
  });
});

/**
 * ONE LineCounter for the life of the app, and that is the entire point of it.
 *
 * It caches a count against (size, mtimeMs), so a tree that is re-statted every
 * few seconds reads each file once and then only when it actually changes.
 * Constructing one per call would keep the API and throw the cache away —
 * thousands of file reads a second on the main process while an agent works,
 * which is the freeze this module was written to avoid. Said explicitly
 * because "new LineCounter()" inside the handler looks tidier and is the bug.
 *
 * It is never cleared. The cache is keyed by absolute path and bounded in
 * practice by how many files a person opens; a workspace that is closed leaves
 * its entries behind, at roughly 50 bytes each. `forget(root)` exists for when
 * that stops being true and nothing calls it yet.
 */
const lineCounter = new repoStats.LineCounter();

/**
 * How many files one `local:stats` call will count.
 *
 * 2000 is half of local-fs.js's DEFAULT_MAX_ENTRIES (4000), which is the most
 * a tree can hold, so a renderer asking about its whole visible tree is inside
 * the cap unless that tree is at its own limit. The number matters because
 * counting is SYNCHRONOUS on the main process: every path is an lstat and, on
 * a cache miss, a read of up to 512 KiB. A renderer that could ask about 50k
 * paths could freeze the window — including its own close button — for
 * seconds, and a renderer is the one input this process treats as hostile.
 *
 * Over the cap the call still answers, for the first 2000, rather than
 * refusing: a tree with no badges at all is a worse answer than a tree with
 * most of them. `truncated` says so rather than leaving the renderer to infer
 * it from missing keys.
 */
const MAX_STAT_PATHS = 2000;

/* ==========================================================================
 * THE STATUS STRIP
 *
 * One call, on a timer from the board, for the things that have no event to
 * subscribe to: the vault graph, the code index, the branch, hook health, and
 * what zevet's own agents have spent.
 *
 * ⚠️ NOTHING HERE IS ANTHROPIC'S RATE LIMIT. `burn` is zevet's own accounting
 * of agents IT launched on THIS machine since the app opened. The real 5h/7d
 * windows reach a status line because Claude Code hands them to it; a headless
 * agent's stream-json does not carry them. desktop/status-sources.js says this
 * twice and the renderer labels it "spent". Do not relabel it.
 * ======================================================================== */

/** Read once at startup. The paths come out of the user's own statusline.py so
 *  that zevet and that status line cannot end up describing different vaults —
 *  see discoverStatusPaths. A person who moves their vault restarts the app. */
const STATUS_PATHS = statusSources.discoverStatusPaths(os.homedir(), process.env);

const burn = new statusSources.BurnWindows();

function noteBurn(payload, sessionKey) {
  const u = statusSources.usageFrom(payload);
  const cost = statusSources.costFrom(payload);
  if (!u && cost == null) return;
  burn.add({
    tokens: u ? u.context : 0,
    // Cumulative snapshots (Claude) count only their increase over the
    // session high-water mark inside BurnWindows; per-step deltas (opencode)
    // add as-is. See usageFrom().
    cumulative: u ? u.cumulative !== false : true,
    cost: cost == null ? undefined : cost,
    // opencode reports cost per step, not a running total — summed per console.
    accumulateCost: statusSources.costAccumulates(payload),
    // Keyed per console, because total_cost_usd is a RUNNING SESSION TOTAL and
    // replaces rather than accumulates. Without a key, two consoles overwrite
    // each other's figure and the cheaper one wins.
    sessionId: String(sessionKey || "-"),
  });
}

/**
 * `root` is optional and is only used for the branch segment. It goes through
 * `knownRoot` like every other path this process accepts from a renderer: a
 * status readout is not a reason to relax the one rule that stops a renderer
 * naming `C:\` and having git walk the disk.
 */
/* ==========================================================================
 * THE CODE INDEX
 *
 * Semantic search over the opened workspace: chunk the files, embed them, and
 * rank by cosine similarity. It is the one feature in zevet that can genuinely
 * be too much for a machine — it loads an ONNX model into memory and holds a
 * vector store — so Andrew's requirement was explicit: *"make sure it only runs
 * on boxes that can handle it, otherwise zevet should still work"*.
 *
 * ⚠️ THE ENTIRE FEATURE IS BEHIND TWO GATES, AND BOTH FAIL CLOSED.
 *
 *   1. `index-capability.assess()` decides whether this machine qualifies. If
 *      it says no, nothing below ever runs: no model is fetched, no CPU is
 *      spent, no directory is created. The renderer is told why, in words a
 *      person can act on, and shows nothing else.
 *   2. Nothing starts BY ITSELF even on a machine that qualifies. Enabling it
 *      downloads ~86MB, and a desktop app that quietly pulls 86MB because you
 *      opened a folder is a bad neighbour. `local:indexEnable` is a button.
 *
 * ⚠️ EVERY FAILURE HERE IS LOCAL TO THIS FEATURE. A missing native runtime, a
 * failed download, a corrupt store: each returns `{ok:false, error}` and leaves
 * the board, the editor and the agents exactly as they were. The optional
 * dependency is `optionalDependencies` for the same reason — on a platform with
 * no prebuild, npm shrugs and the guarded require answers MODULE_NOT_FOUND
 * rather than failing the user's whole install.
 * ======================================================================== */

/** One index per workspace root, kept open for the life of the app. Opening is
 *  not free (it reads the store) and a search should not pay for it. */
const openIndexes = new Map();
/** The shared embedder. One model in memory, not one per workspace. */
let sharedEmbedder = null;
let embedderPromise = null;
/** Roots currently refreshing, so a second click does not start a second pass
 *  over the same tree. */
const refreshing = new Set();

/**
 * Where one root's store lives. Hashed, because a path is not a directory name
 * -- it contains separators and, on Windows, a colon -- and because two roots
 * with the same basename must not share a store.
 */
function indexDirFor(root) {
  const hash = crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16);
  return path.join(HOME, "index", "stores", hash);
}

function indexProgress(payload) {
  toBoard("local:indexEvent", payload);
}

async function ensureEmbedder() {
  if (sharedEmbedder) return sharedEmbedder;
  if (embedderPromise) return embedderPromise;
  embedderPromise = embedder
    .createEmbedder({
      modelDir: indexCapability.modelDir(),
      onProgress: (p) => indexProgress({ kind: "model", ...p }),
    })
    .then((r) => {
      embedderPromise = null;
      if (r && r.ok) sharedEmbedder = r;
      return r;
    });
  return embedderPromise;
}

/** The capability answer, the model's state, and what this root's index holds.
 *  Cheap enough to poll: assess() is a few syscalls and the rest is in memory. */
/**
 * The renderer telling the main process what colour it just painted itself.
 *
 * The page owns the palette -- it is defined once in `:root` and the renderer
 * reads its own computed values back rather than repeating hexes -- but the
 * window frame is the main process's to set. So the theme change travels one
 * way: the page decides, and this follows.
 *
 * Deliberately not the reverse. Asking the main process for the system theme
 * and pushing it into the page would make the app's appearance depend on an OS
 * setting the person did not touch, and the toggle they did touch would lose.
 */
bridge.handle("ui:chrome", (_e, arg) => {
  const theme = arg && arg.theme === "dark" ? "dark" : "light";
  lastChromeTheme = theme;
  const w = boardWindow;
  if (!w || w.isDestroyed()) return { ok: false };
  const paper = typeof arg.paper === "string" && /^#[0-9a-f]{3,8}$/i.test(arg.paper.trim())
    ? arg.paper.trim()
    : chromeFor(theme).color;
  // ⚠️ VALIDATED, NOT TRUSTED. This value comes from a page served by the hub,
  // and it is handed to a native API. A hex colour is the only shape accepted;
  // anything else falls back to our own constant rather than being passed on.
  try {
    w.setBackgroundColor(paper);
    if (typeof w.setTitleBarOverlay === "function" && process.platform !== "darwin") {
      const ink = typeof arg.ink === "string" && /^#[0-9a-f]{3,8}$/i.test(arg.ink.trim())
        ? arg.ink.trim()
        : chromeFor(theme).symbolColor;
      // The height tracks the zoom for the same reason applyZoom sets it: the
      // OS draws this overlay unscaled over a page that is scaled.
      w.setTitleBarOverlay({
        color: paper,
        symbolColor: ink,
        height: Math.round(TITLE_BAR_HEIGHT * zoomFactor(w.webContents.getZoomLevel())),
      });
    }
  } catch {
    // setTitleBarOverlay throws on a window that was not created with an
    // overlay -- a macOS window, or one from before this existed. Nothing to
    // do and nothing worth telling the user.
    return { ok: false };
  }
  return { ok: true };
});

bridge.handle("local:indexStatus", async (_e, arg) => {
  const root = arg && typeof arg.root === "string" ? arg.root : null;
  const dir = root ? knownRoot(root) : null;
  const cap = indexCapability.assess({});
  const model = embedder.modelState({ modelDir: indexCapability.modelDir() });
  const idx = dir ? openIndexes.get(path.resolve(dir)) : null;
  return {
    ok: true,
    capable: cap.capable,
    reasons: cap.reasons,
    measured: cap.measured,
    budget: cap.budget,
    model: { present: model.present, bytes: model.bytes },
    // `null` means "no index for this root", which is different from an index
    // with zero chunks -- one has never been built, the other found nothing.
    stats: idx ? idx.stats() : null,
    building: dir ? refreshing.has(path.resolve(dir)) : false,
  };
});

/**
 * Build or refresh this root's index. Fetches the model on first use.
 *
 * ⚠️ REFUSES ON AN INCAPABLE MACHINE even though the renderer already knows,
 * because the renderer is the one input this process does not trust and a UI
 * that has gone stale must not be able to start an 86MB download.
 */
bridge.handle("local:indexEnable", async (_e, arg) => {
  const root = arg && typeof arg.root === "string" ? arg.root : null;
  const dir = root ? knownRoot(root) : null;
  if (!dir) return { ok: false, error: "not an opened workspace" };

  const cap = indexCapability.assess({});
  if (!cap.capable) {
    return { ok: false, error: cap.reasons[0] || "this machine cannot run the index", reasons: cap.reasons };
  }

  const key = path.resolve(dir);
  if (refreshing.has(key)) return { ok: false, error: "already building" };
  refreshing.add(key);
  try {
    const emb = await ensureEmbedder();
    if (!emb || !emb.ok) return { ok: false, error: (emb && emb.error) || "the embedding runtime would not load" };

    let idx = openIndexes.get(key);
    if (!idx) {
      idx = await codeIndex.openIndex({
        root: key,
        dir: indexDirFor(key),
        embedder: emb,
        budget: cap.budget,
      });
      openIndexes.set(key, idx);
    }
    const result = await idx.refresh({
      onProgress: (p) => indexProgress({ kind: "index", root: key, ...p }),
    });
    indexProgress({ kind: "done", root: key, ...result });
    return { ok: true, ...result, stats: idx.stats() };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    refreshing.delete(key);
  }
});

/** A caller-supplied path filter, as a literal. See its use below for why it
 *  is never compiled as a pattern. */
function pathFilter(raw) {
  if (typeof raw !== "string" || !raw) return undefined;
  const text = raw.slice(0, 200);
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

bridge.handle("local:indexSearch", async (_e, arg) => {
  const root = arg && typeof arg.root === "string" ? arg.root : null;
  const dir = root ? knownRoot(root) : null;
  if (!dir) return { ok: false, error: "not an opened workspace", hits: [] };
  const idx = openIndexes.get(path.resolve(dir));
  if (!idx) return { ok: false, error: "no index for this workspace yet", hits: [] };
  const q = arg && typeof arg.query === "string" ? arg.query.trim() : "";
  if (!q) return { ok: true, hits: [] };
  try {
    const hits = await idx.search(q, {
      k: Number(arg.k) || 8,
      /* ⚠️ A PATH FILTER, NOT A REGEX. This forwarded the renderer's string
         straight through, and code-index.js compiles a string with
         `new RegExp(...)` and runs it against every chunk in the index —
         thousands of `.test()` calls, synchronously, on the main process. A
         catastrophically backtracking pattern such as `^(\w+\/)+\.x$`
         against a deep path therefore hangs the entire app, with no timeout
         to end it and no way back: Node cannot interrupt a regex.

         Nothing has ever passed this, so narrowing it costs nothing. It is
         escaped to a literal now, which is what "filter by path" means
         anyway, and capped. `search()` still takes a real RegExp object for
         callers inside the main process, which are ours. */
      filter: pathFilter(arg.filter),
    });
    return { ok: true, hits };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), hits: [] };
  }
});

/* Advisory path claims (D-070). `myClaims` are this machine's, shared with the
 * team as one sealed frame per session (desktop/claims.js, relayed by the hub
 * on the steer channel); `teamClaims` are the teammates' frames, opened here
 * with the document key. Nothing here ever blocks a write. */
const claimsLib = require("./claims.js");
const shareClaim = async (actor, session, entry) => {
  try {
    const a = steerAuth(readConfig());
    const docCrypto = agentSteer.loadDocCrypto();
    if (!a.hub || !a.token || !a.key || !docCrypto) return;
    await fetch(`${a.hub}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": a.token },
      body: JSON.stringify(claimsLib.claimBody(docCrypto, a.key, actor, session, entry)),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // Local claims still work; teammates see them at the next change.
  }
};
const myClaims = new claimsLib.ClaimStore({
  broadcast: (actor, session, entry) => {
    void shareClaim(actor, session, entry);
    pushClaims();
  },
});
const teamClaims = new claimsLib.ClaimStore();
/* Who pays (D-073, desktop/payer.js). `teamPayers` are the teammates' sealed
 * frames, opened here with the document key; `myPayers` is what I shared, so my
 * own frames coming back round are dropped. Identity only, never a token. */
const payerLib = require("./payer.js");
const teamPayers = new Map();
const myPayers = new Map();
function payerOf(agent, { model = "", engine = "" } = {}) {
  const def = readConfig()?.defaultCredential;
  let credential = "";
  if (def && (agent === "claude" || agent === "claude-code")) {
    // A saved credential overrides the login. Only a personal one is named; a team or auto-ladder pick is not knowable here.
    const found = def.scope === "personal" && def.id ? credentials.listCredentials().find((c) => c.id === def.id) : null;
    if (!found || !found.label) return { engine: "Claude", account: "", label: "" };
    credential = found.label;
  }
  return payerLib.payerFor(agent, { model, engine, credential });
}
function allPayers() {
  return [...teamPayers.values()];
}
const sharePayer = async (actor, session, p) => {
  try {
    const a = steerAuth(readConfig());
    const docCrypto = agentSteer.loadDocCrypto();
    if (!a.hub || !a.token || !a.key || !docCrypto) return;
    await fetch(`${a.hub}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zevet-token": a.token },
      body: JSON.stringify(payerLib.payerBody(docCrypto, a.key, actor, session, p)),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // The label stays local; teammates see it at the next share.
  }
};
function allClaims() {
  const mine = myClaims.claims().map((e) => ({ ...e, mine: true }));
  const own = new Set(mine.map((e) => e.session));
  return [...mine, ...teamClaims.claims().filter((e) => !own.has(e.session)).map((e) => ({ ...e, mine: false }))];
}
function pushClaims() {
  toBoard("local:claimsEvent", { claims: allClaims(), payers: allPayers(), steps: stepClaims.all() });
}
setInterval(() => {
  if (myClaims.expire() | teamClaims.expire()) pushClaims();
}, 30 * 1000).unref();

/** A claimable path: relative, inside the folder, no `..`. */
function claimablePath(p) {
  const rel = String(p || "").replaceAll("\\", "/").replace(/^\.\//, "");
  return rel && !rel.startsWith("/") && !/^[A-Za-z]:/.test(rel) && !rel.split("/").includes("..") ? rel : "";
}

bridge.handle("local:overlapCheck", async (_e, arg) => {
  const input = arg && typeof arg.input === "object" && arg.input ? arg.input : {};
  const active = (Array.isArray(input.active) ? input.active : []).concat(
    claimsLib.claimsAsActive(allClaims(), { skip: String(input.session || ""), repo: String(input.repo || "") }),
  );
  try {
    // Never a model download: createEmbedder refuses when the model is absent.
    // A cold load must not hold the Send button, so it gets four seconds.
    const emb = sharedEmbedder || (await Promise.race([ensureEmbedder(), new Promise((r) => setTimeout(r, 4000))]));
    const embed = emb && emb.ok ? emb.embed : undefined;
    return { ok: true, hits: await classifyOverlap({ ...input, active, embed }) };
  } catch {
    return { ok: true, hits: await classifyOverlap({ ...input, active }).catch(() => []) };
  }
});
bridge.handle("local:claim", async (_e, arg) => {
  const input = arg && typeof arg.input === "object" && arg.input ? arg.input : {};
  const root = typeof input.root === "string" ? knownRoot(input.root) : null;
  const session = typeof input.session === "string" ? input.session : "";
  const paths = (Array.isArray(input.paths) ? input.paths : []).map(claimablePath).filter(Boolean).slice(0, claimsLib.MAX_PATHS);
  if (!root || !session || !paths.length) return { ok: false, error: "a folder, a session and a path are required" };
  // A path an agent merely mentioned is only claimed when the file is there.
  const real = input.auto === true ? paths.filter((p) => fs.existsSync(path.join(root, p))) : paths;
  if (!real.length) return { ok: true, claim: null, shared: false };
  const cfg = readConfig();
  const actor = String(input.actor || (cfg && cfg.actor) || "");
  const claim = myClaims.claim({ paths: real, session, actor, repo: path.basename(root), timeoutMs: Number(input.timeoutMs) || undefined });
  const a = steerAuth(cfg);
  return { ok: true, claim, shared: Boolean(a.hub && a.token && a.key && agentSteer.loadDocCrypto()) };
});
bridge.handle("local:releaseClaims", async (_e, arg) => {
  const session = String((arg && arg.session) || "");
  if (session) myClaims.release({ session, path: typeof (arg && arg.path) === "string" ? arg.path : undefined });
  return { ok: true };
});
/* Pinned memory (D-077): per-file notes sealed with the document key,
 * on disk and on the hub's room. desktop/pinned-memory.js owns the rules;
 * staleness is read off the working tree here, never by the hub. */
const pinnedMemory = require("./pinned-memory.js");
function memoryFor() {
  const docCrypto = agentSteer.loadDocCrypto();
  const key = steerAuth(readConfig()).key;
  if (!docCrypto || !key) return null;
  return pinnedMemory.createMemory({
    dir: path.join(zevetHome(), "memory"),
    docCrypto,
    key,
    send: (room, bytes) => {
      const got = ensureDocSync();
      if (got.error) return; // offline or not set up: the note is saved locally and goes at the next edit
      try {
        got.sync.join(room);
        got.sync.send(room, bytes);
      } catch {
        // Local note stands; teammates get it at its next change.
      }
    },
  });
}
const memoryGate = (arg) => {
  const input = arg && typeof arg.input === "object" && arg.input ? arg.input : {};
  const root = typeof input.root === "string" ? knownRoot(input.root) : null;
  const mem = root ? memoryFor() : null;
  if (!root) return { error: "a known folder is required" };
  if (!mem) return { error: "not set up: no document key" };
  return { input, root, mem, repo: path.basename(root) };
};
bridge.handle("local:memoryList", async (_e, arg) => {
  const g = memoryGate(arg);
  if (g.error) return { ok: false, notes: [], error: g.error };
  try {
    ensureDocSync().sync?.join(g.mem.room(g.repo));
  } catch {
    // Listing is local; the room only brings teammates' notes.
  }
  return { ok: true, notes: g.mem.list({ repo: g.repo, path: typeof g.input.path === "string" ? g.input.path : "", root: g.root }) };
});
bridge.handle("local:memoryCreate", async (_e, arg) => {
  const g = memoryGate(arg);
  if (g.error) return { ok: false, error: g.error };
  const cfg = readConfig();
  const note = g.mem.create({ repo: g.repo, path: claimablePath(g.input.path), text: g.input.text, root: g.root, author: String((cfg && cfg.actor) || "") });
  if (note) toBoard("local:memoryEvent", { repo: g.repo });
  return note ? { ok: true, note } : { ok: false, error: "a note needs a file that exists and some text" };
});
bridge.handle("local:memoryEdit", async (_e, arg) => {
  const g = memoryGate(arg);
  if (g.error) return { ok: false, error: g.error };
  const note = g.mem.edit(String(g.input.id || ""), { text: g.input.text, rehash: g.input.rehash === true, root: g.root });
  if (note) toBoard("local:memoryEvent", { repo: g.repo });
  return note ? { ok: true, note } : { ok: false, error: "no such note" };
});
bridge.handle("local:memoryRetire", async (_e, arg) => {
  const g = memoryGate(arg);
  if (g.error) return { ok: false, error: g.error };
  const note = g.mem.retire(String(g.input.id || ""));
  if (note) toBoard("local:memoryEvent", { repo: g.repo });
  return note ? { ok: true } : { ok: false, error: "no such note" };
});
/* Agent coordination tools (D-087, desktop/agent-tools.js). Reached from
 * zevet-mcp.js over the ask-server's /tool route; every dependency is this
 * app's own signed-in team, so no argument can name another team. */
const agentToolsLib = require("./agent-tools.js");
const stepClaimsLib = require("./step-claims.js");
const stepClaims = stepClaimsLib.createStepClaims({
  send: (room, bytes) => {
    const got = ensureDocSync();
    if (got.error) return; // saved locally; teammates see it when sync is back
    try {
      got.sync.join(room);
      got.sync.send(room, bytes);
    } catch {
      // Local claim stands.
    }
  },
  onChange: () => pushClaims(),
});
let myTeamNames = [];
async function fetchTeamState() {
  const a = steerAuth(readConfig());
  if (!a.session || !a.hub) return null;
  const r = await fetch(`${a.hub}/api/state`, { headers: { "x-zevet-token": a.token }, redirect: "error", signal: AbortSignal.timeout(10000) });
  return r.ok ? r.json() : null;
}
let agentToolsInstance = null;
function agentTools() {
  if (!agentToolsInstance) {
    agentToolsInstance = agentToolsLib.createAgentTools({
      getState: async () => {
        const st = await fetchTeamState().catch(() => null);
        if (st) for (const ag of Array.isArray(st.agents) ? st.agents : []) if (ag.repo) try { ensureDocSync().sync?.join(stepClaims.room(ag.repo)); } catch { /* local only */ }
        return st;
      },
      me: () => [readConfig()?.actor, ...myTeamNames],
      actor: () => String(readConfig()?.actor || ""),
      claims: () => allClaims(),
      stepOwner: (session, step) => stepClaims.ownerOf(session, step),
      stepClaim: (c) => stepClaims.claim(c),
      steer: (m) => {
        const a = steerAuth(readConfig());
        return agentSteer.sendSteer({ hub: a.hub, token: a.token, key: a.key, to: m.to, session: m.session, repo: m.repo, text: m.text });
      },
      memory: () => memoryFor(),
      memoryChanged: (repo) => toBoard("local:memoryEvent", { repo }),
    });
  }
  return agentToolsInstance;
}
bridge.handle("local:claims", async () => ({ ok: true, claims: allClaims(), payers: allPayers(), steps: stepClaims.all() }));
bridge.handle("local:payerFor", async (_e, arg) => {
  const { engine, account, label } = payerOf(String((arg && arg.agent) || ""), { model: String((arg && arg.model) || ""), engine: String((arg && arg.engine) || "") });
  return { engine, account, label };
});
/** Seal this session's payer for the team (or release it when unknown). */
bridge.handle("local:sharePayer", async (_e, arg) => {
  const session = String((arg && arg.session) || "");
  if (!session) return { ok: false };
  const p = payerOf(String((arg && arg.agent) || ""), { model: String((arg && arg.model) || ""), engine: String((arg && arg.engine) || "") });
  const actor = String((arg && arg.actor) || readConfig()?.actor || "");
  if (p.label) myPayers.set(session, p.label);
  else myPayers.delete(session);
  await sharePayer(actor, session, p);
  return { ok: true, label: p.label };
});

bridge.handle("local:status", async (_e, arg) => {
  const root = arg && typeof arg.root === "string" ? arg.root : null;
  const dir = root ? knownRoot(root) : null;

  // Probed and read in parallel: the port probe can take its full 250ms and
  // there is no reason for the git call to wait behind it.
  const [cindex, repo] = await Promise.all([
    statusSources.probePort(STATUS_PATHS.cindexPort),
    dir ? repoStats.branchState(dir) : Promise.resolve(null),
  ]);

  const failedAgo = statusSources.hookFailure(STATUS_PATHS.errorLog);

  // The 5h/7d windows from startup, before any agent has reported a
  // rate_limit_event: this machine's own login, probed at most every 5 min.
  const probed = await agentEngine.engine1Windows({ probeOpts: { fetchImpl: fetch } }).catch(() => undefined);
  return {
    ok: true,
    cindex,
    // Carried so the settings sheet can NAME the port it found something on.
    // "An index is already serving on 8080" is checkable; "an index is already
    // serving" is a claim the user has no way to confirm or disprove.
    cindexPort: STATUS_PATHS.cindexPort,
    repo,
    graph: statusSources.vaultHealth(STATUS_PATHS.vaultHealth),
    // Seconds, formatted by the renderer -- the main process has no business
    // deciding whether "2h" or "2 hours ago" reads better in a 10px strip.
    hook: { failedAgo },
    burn: burn.read(),
    rateLimits: probed ? probed.windows : undefined,
    rateLimitsAt: probed ? probed.at : 0,
  };
});

/* ---------------------------------------------------------------------------
 * SCHEDULES
 *
 * An agent run on a timer. The same spawn local:startAgent performs, so this
 * adds no capability the app did not have — only a delay. schedule.js holds
 * the pure parts and the one refusal (a schedule may not run in `dangerous`
 * mode; see the note there).
 * ------------------------------------------------------------------------- */

const SCHEDULES = path.join(HOME, "schedules.json");

/* ---------------------------------------------------------------------------
 * PER-REPO AGENT SETTINGS
 *
 * Standing instructions for a repo, and which optional capabilities an agent
 * started here is given. Keyed by the workspace path, in the same store as the
 * schedules, because both are "what this machine does on your behalf".
 *
 * `systemPrompt` becomes `--append-system-prompt` (claude's flag; the other two
 * CLIs have no equivalent and the panel says so). `computerUse` is off by
 * default and is the ONLY thing that hands an agent zevet's MCP server — see
 * the comment on that wiring below.
 * ------------------------------------------------------------------------- */
const AGENT_SETTINGS = path.join(HOME, "agent-settings.json");

/** Everything, by workspace path. */
function readAllAgentSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(AGENT_SETTINGS, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** One repo's, with every field defaulted, so a caller never sees undefined. */
function agentSettingsFor(dir) {
  const raw = (readAllAgentSettings()[path.resolve(dir)] || {});
  return {
    systemPrompt: typeof raw.systemPrompt === "string" ? raw.systemPrompt.slice(0, 8000) : "",
    // ⚠️ DEFAULT FALSE, AND IT HAS TO STAY FALSE. This is the switch that lets
    // an agent see the screen and move the mouse. Absent file, unreadable
    // file, unknown repo, a field somebody hand-edited to nonsense — every one
    // of those has to land on "no".
    computerUse: raw.computerUse === true,
  };
}

function writeAgentSettingsFor(dir, patch) {
  const all = readAllAgentSettings();
  const key = path.resolve(dir);
  const next = { ...agentSettingsFor(dir), ...(patch || {}) };
  all[key] = {
    systemPrompt: typeof next.systemPrompt === "string" ? next.systemPrompt.slice(0, 8000) : "",
    computerUse: next.computerUse === true,
  };
  try {
    fs.mkdirSync(HOME, { recursive: true });
    atomicWriteJson(AGENT_SETTINGS, all);
  } catch (err) {
    console.error(`zevet: could not save agent settings: ${err.message}`);
  }
  return all[key];
}

bridge.handle("local:agentSettings", (_e, arg) => {
  const dir = knownRoot(arg && arg.root);
  if (!dir) return { ok: false, settings: null };
  return { ok: true, settings: agentSettingsFor(dir) };
});

bridge.handle("local:saveAgentSettings", (_e, arg) => {
  const dir = knownRoot(arg && arg.root);
  if (!dir) return { ok: false, settings: null };
  return { ok: true, settings: writeAgentSettingsFor(dir, arg && arg.patch) };
});

/* ---------------------------------------------------------------------------
 * USER PREFS MIRROR
 *
 * Every "zevet.*" key the board keeps in localStorage — view, theme, launch
 * model, permission mode, seen runs, model limits, and the rest (see board/
 * src/lib/prefs-mirror.mjs). localStorage is scoped to the hub's ORIGIN, so a
 * person who switches hubs, or whose hub's URL changes, silently loses all of
 * it. This is the same flat key→string map, kept on this machine instead, so
 * a preference follows the person rather than whichever hub served the page.
 * The board hydrates its localStorage from this on startup and mirrors every
 * write back here — see prefs-mirror.mjs's `applyMirror`/`mirroredStorage`.
 * ------------------------------------------------------------------------- */
const PREFS = path.join(HOME, "prefs.json");

function readPrefs() {
  try {
    const raw = JSON.parse(fs.readFileSync(PREFS, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writePrefs(all) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    atomicWriteJson(PREFS, all);
  } catch (err) {
    console.error(`zevet: could not save prefs: ${err.message}`);
  }
}

bridge.handle("local:prefs", () => readPrefs());

bridge.handle("local:setPref", (_e, arg) => {
  const key = String((arg && arg.key) || "");
  if (!key) return { ok: false };
  const all = readPrefs();
  // A null value is a delete (see prefs-mirror.mjs's mirroredStorage.removeItem).
  if (arg.value == null) delete all[key];
  else all[key] = String(arg.value);
  writePrefs(all);
  return { ok: true };
});

/** One round trip for many keys at once — prefs-mirror.mjs's
 *  `hydratePrefsMirror` seeding the mirror from an existing user's
 *  localStorage the first time it finds the mirror empty. */
bridge.handle("local:setPrefs", (_e, arg) => {
  const entries = arg && arg.entries;
  if (!entries || typeof entries !== "object") return { ok: false };
  const all = readPrefs();
  for (const [key, value] of Object.entries(entries)) {
    if (key && typeof value === "string") all[key] = value;
  }
  writePrefs(all);
  return { ok: true };
});

function readSchedules() {
  try {
    const raw = JSON.parse(fs.readFileSync(SCHEDULES, "utf8"));
    return Array.isArray(raw) ? raw.map((s) => schedule.sanitise(s)) : [];
  } catch {
    // No file yet, or one somebody edited into something else. Neither is an
    // error: there are simply no schedules.
    return [];
  }
}

function writeSchedules(list) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    atomicWriteJson(SCHEDULES, list);
  } catch (err) {
    console.error(`zevet: could not save schedules: ${err.message}`);
  }
}

/** Fire everything due. Called on a slow timer — the cadences are minutes, so
 *  checking once a minute is as precise as the feature claims to be. */
async function runDueSchedules() {
  const list = readSchedules();
  const ready = schedule.due(list, Date.now());
  if (!ready.length) return;

  let changed = false;
  for (const s of ready) {
    const dir = knownRoot(s.root);
    // The folder was closed or moved since the schedule was made. Advance it
    // anyway rather than retrying every minute forever.
    let ok = false;
    if (dir && s.prompt) {
      let place = null;
      try {
        await runtimeReady;
        place = await placeAgent(dir);
        // Same handle-indirection as local:startAgent: onEvent can fire before
        // `started` is assigned, so the id it needs is read off a mutable box.
        const handle = { id: null };
        const env = await credentialEnvFor();
        const started = instrumentedStartConsole({
          agent: s.agent,
          cwd: place.cwd,
          repoRoot: place.root,
          model: s.model,
          mode: s.mode,
          env,
          onEvent: (evt) => {
            if (evt && evt.type === "agent") noteBurn(evt.payload, handle.id);
            notePlacement(place, evt, handle.id);
            // A scheduled run's worktree goes when the run ends.
            if (evt && evt.type === "exit") void releasePlacement(place, { integrate: true });
            // Routed through consoleLog like any other console, so a scheduled
            // run reattaches on a board reload instead of vanishing from the
            // rail — see console-log.js.
            toBoard("local:agentEvent", { ...consoleLog.record(handle.id, evt), scheduled: s.id });
          },
        });
        if (started && started.ok) {
          handle.id = started.id;
          trackPlacement(place, started.id);
          place.title = s.name;
          consoles.set(started.id, started);
          consoleLog.open(started.id, { ...consoleMeta(s.agent, dir, { model: s.model, mode: s.mode }, place), scheduled: s.id });
          announceConsole(started.id);
          started.send(s.prompt);
          ok = true;
        }
      } catch (err) {
        console.error(`zevet: scheduled run "${s.name}" failed: ${err.message}`);
      }
      if (!ok && place) void releasePlacement(place);
    }
    const i = list.findIndex((x) => x.id === s.id);
    if (i >= 0) list[i] = schedule.advance(list[i], ok);
    changed = true;
  }
  if (changed) {
    writeSchedules(list);
    if (boardWindow && !boardWindow.isDestroyed()) {
      boardWindow.webContents.send("local:schedulesChanged", list);
    }
  }
}

let scheduleTimer = null;
function startScheduler() {
  if (scheduleTimer) return;
  // Once a minute. The shortest cadence offered is fifteen.
  scheduleTimer = setInterval(() => void runDueSchedules(), 60_000);
  if (typeof scheduleTimer.unref === "function") scheduleTimer.unref();
}

/**
 * C1: push agent sessions for opted-in repos (masora.reposFor(), default
 * none) to Masora, once every five minutes. A cycle that errors (no
 * keychain, network down, Masora unreachable) just tries again next tick --
 * the outbox (masora-push.js) is what makes that safe: nothing already
 * queued is lost between attempts.
 */
let masoraPushTimer = null;
async function runMasoraPushOnce() {
  // Chat records queued while offline or locked go out on the same beat.
  if (masoraPush.readOutbox(masoraPush.CHAT_OUTBOX_PATH).length) {
    const auth = await masoraToken();
    if (auth) {
      await masoraPush
        .flushOutbox({ baseUrl: auth.cfg.url, token: auth.token, file: masoraPush.CHAT_OUTBOX_PATH, team: await currentTeamName() })
        .catch((err) => console.error(`zevet: chat push failed: ${err.message}`));
    }
  }
  const repos = masora.reposFor();
  if (!Object.keys(repos).length) return;
  const cfg = masora.readConfig();
  if (!cfg.paired || !safeStorage.isEncryptionAvailable()) return;
  const token = masora.loadToken((buf) => safeStorage.decryptString(buf));
  if (!token) return;
  try {
    await masoraPush.runOnce({
      repos, baseUrl: cfg.url, token,
      listSessions: agentSessions.list, readSession: agentSessions.read,
      actor: chatAuthor(), team: await currentTeamName(),
    });
  } catch (err) {
    console.error(`zevet: masora push failed: ${err.message}`);
  }
}
function startMasoraPush() {
  if (masoraPushTimer) return;
  void runMasoraPushOnce();
  masoraPushTimer = setInterval(() => void runMasoraPushOnce(), 5 * 60_000);
  if (typeof masoraPushTimer.unref === "function") masoraPushTimer.unref();
}

bridge.handle("local:schedules", () => ({ ok: true, schedules: readSchedules() }));

bridge.handle("local:scheduleSave", (_e, arg) => {
  const incoming = schedule.sanitise(arg && arg.schedule);
  if (!incoming.prompt) return { ok: false, error: "a schedule needs a prompt" };
  if (!knownRoot(incoming.root)) return { ok: false, error: "not an opened workspace" };
  const list = readSchedules();
  const i = list.findIndex((s) => s.id === incoming.id);
  if (i >= 0) list[i] = incoming;
  else list.push(incoming);
  writeSchedules(list);
  return { ok: true, schedules: list };
});

bridge.handle("local:scheduleRemove", (_e, arg) => {
  const id = String((arg && arg.id) || "");
  const list = readSchedules().filter((s) => s.id !== id);
  writeSchedules(list);
  return { ok: true, schedules: list };
});

bridge.handle("local:scheduleToggle", (_e, arg) => {
  const id = String((arg && arg.id) || "");
  const list = readSchedules().map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s));
  writeSchedules(list);
  return { ok: true, schedules: list };
});

/** The last few commits in a folder the person has opened. Read only: it
 *  runs `git log` and nothing else, and there is no counterpart that writes. */
bridge.handle("local:commits", async (_e, arg) => {
  const dir = knownRoot(arg && arg.root);
  if (!dir) return { ok: false, commits: [] };
  try {
    return { ok: true, commits: await repoStats.commits(dir, arg && arg.limit) };
  } catch {
    // Same rule as every other git call here: no history is a board without
    // a checkpoint list, not an error worth showing.
    return { ok: false, commits: [] };
  }
});

/** When this run of the app started. A memory file newer than this was
 *  written while you were watching, which is the only "change" state the
 *  filesystem can honestly report. */
const APP_STARTED = Date.now();

/**
 * What the agent has written down about this repo.
 *
 * Claude Code keeps per-project memories as one markdown file per fact under
 * `~/.claude/projects/<slug>/memory`, where the slug is the project path with
 * every non-alphanumeric character replaced by a dash. Nothing else reads
 * these, which is exactly why they are worth surfacing: a memory that is wrong
 * steers every future session in this repo and is otherwise invisible.
 *
 * READ ONLY. There is deliberately no handler that deletes one — see the note
 * on the panel. An agent that does not write memories has an empty directory,
 * which is not an error.
 */
bridge.handle("local:memories", async (_e, arg) => {
  const dir = knownRoot(arg && arg.root);
  if (!dir) return { ok: false, memories: [] };
  const slug = path.resolve(dir).replace(/[^A-Za-z0-9]/g, "-");
  const memDir = path.join(os.homedir(), ".claude", "projects", slug, "memory");
  let names;
  try {
    names = fs.readdirSync(memDir);
  } catch {
    return { ok: true, dir: memDir, memories: [] };
  }
  const out = [];
  for (const name of names) {
    // MEMORY.md is the index over the others, not a memory.
    if (!name.endsWith(".md") || name === "MEMORY.md") continue;
    const full = path.join(memDir, name);
    let stat;
    let head;
    try {
      stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > 64 * 1024) continue;
      head = fs.readFileSync(full, "utf8").slice(0, 2048);
    } catch {
      continue;
    }
    // The description line of the frontmatter is the memory in one sentence,
    // which is what a chip has room for. Falling back to the slug rather than
    // to the body: a chip full of prose is unreadable at that size.
    const m = /^description:\s*(.+)$/m.exec(head);
    const text = ((m && m[1]) || name.replace(/\.md$/, "").replace(/-/g, " ")).trim().slice(0, 160);
    out.push({
      id: name,
      text,
      at: stat.mtimeMs,
      fresh: stat.mtimeMs >= APP_STARTED,
    });
  }
  out.sort((a, b) => b.at - a.at);
  return { ok: true, dir: memDir, memories: out.slice(0, 40) };
});

bridge.handle("local:stats", async (_e, { root, relPaths }) => {
  // knownRoot FIRST, exactly as every handler above does it, and for the same
  // reason: without it `C:\` is a valid root and the counter walks the disk.
  const dir = knownRoot(root);
  if (!dir) return { ok: false, lines: {}, diff: null, error: "not an opened workspace" };

  const asked = Array.isArray(relPaths) ? relPaths.filter((p) => typeof p === "string") : [];
  const list = asked.slice(0, MAX_STAT_PATHS);

  // `countAll` returns a null-prototype object, which is what repo-stats.js
  // built it to hand over IPC — a path literally named `__proto__` is then an
  // ordinary key rather than a prototype write.
  const lines = lineCounter.countAll(dir, list);

  // A Map does NOT survive Electron's structured clone as anything a renderer
  // can use: it arrives as an empty-looking object with no entries, which
  // reads as "this repo has no changes" — a wrong answer that looks like a
  // right one. Converted here, once, rather than in the renderer.
  //
  // `ok:false` from diffStats means git said nothing useful (not a repo, no
  // git installed, a timeout) and is passed on as `diff: null`. That is a
  // different thing from an EMPTY diff, which means a clean tree and is worth
  // drawing; collapsing the two would make "no git" look like "no changes".
  const { byPath, ok } = await repoStats.diffStats(dir);
  const diff = ok ? Object.fromEntries(byPath) : null;

  return { ok: true, lines, diff, truncated: asked.length > list.length, counted: list.length };
});

/** Added-line hunks for one file, so the board can seat an agent's sprite on
 *  the lines it just wrote. knownRoot first, like every sibling handler. */
bridge.handle("local:diffHunks", async (_e, { root, relPath }) => {
  const dir = knownRoot(root);
  if (!dir) return { ok: false, hunks: [], error: "not an opened workspace" };
  if (typeof relPath !== "string" || !relPath || relPath.includes("..")) {
    return { ok: false, hunks: [], error: "not a file in this workspace" };
  }
  return repoStats.diffHunks(dir, relPath);
});

// ---- watching the disk for what an agent did ------------------------------

/**
 * One watcher set for the app, torn down with the board window.
 *
 * The change is pushed on `local:fileChanged` rather than polled, because the
 * event that matters — an agent rewriting a file that is open in the editor —
 * has to reach the CRDT before the next keystroke publishes a stale document
 * over the top of it.
 */
const fileWatch = new FileWatch({
  onChange: (evt) => toBoard("local:fileChanged", evt),
});

bridge.handle("local:watch", (_e, { root, relPath, initialText }) => {
  const dir = knownRoot(root);
  if (!dir) return { ok: false, error: "not an opened workspace" };
  // The resolved root is passed on, not the renderer's spelling, so the
  // echoed `root` in every change event is the one the allowlist approved.
  return fileWatch.watch(dir, String(relPath || ""), initialText);
});

bridge.handle("local:unwatch", (_e, { root, relPath }) => {
  const dir = knownRoot(root);
  /* ⚠️ AN UNKNOWN ROOT STILL HAS TO BE UNWATCHED. The old line was
     `if (!dir) return { ok: true }`, and the reasoning above it was right —
     unwatch only ever removes, so there is nothing to protect — but the code
     acted on it backwards: it reported success and removed NOTHING. A renderer
     closing a tab after its workspace had been dropped from the list therefore
     leaked the watch for the life of the app, and file-watch.js says what that
     costs in its own words: an fs.watch handle is a real OS resource and
     "leaking one per file ever opened is how a long session runs out of them".

     The allowlist is still consulted first, as it is in every handler here,
     because `watch` and `stats` genuinely need it. This one falls back to the
     same resolve `knownRoot` would have done, so the key matches the one
     `watch` registered. The worst a bad root can do is fail to match a key. */
  return fileWatch.unwatch(dir || path.resolve(String(root || "")), String(relPath || ""));
});

// ---- the shared document ---------------------------------------------------

/**
 * One DocSync for the board window, built on the first join and destroyed with
 * the window.
 *
 * ⚠️ WHAT MUST NOT CROSS THE BRIDGE, because the whole design rests on it: the
 * master secret, the derived auth token, the document key, and this object
 * itself. The renderer gets plaintext Yjs updates in and out and nothing else.
 * There is deliberately no "give me the config" call that answers with a
 * credential — `zevet:config` above is redacted for the same reason — because
 * the board window loads the HUB'S OWN PAGE, so anything readable from that
 * renderer is readable by the hub, and the hub is precisely who the encryption
 * is keeping out. See the header of doc-sync.js for the full argument.
 */
let docSync = null;

/**
 * Give back everything a board renderer was holding.
 *
 * Called from TWO places, and the second is the one that is easy to miss: the
 * window closing, and the window RELOADING. A reload destroys the Y.Docs and
 * the listeners that were driving all of this while leaving the window — and so
 * every socket and every OS watch handle — alive in this process. See where it
 * is wired up in openBoard() for why `did-start-loading` is the hook.
 *
 * Deliberately safe to call when there is nothing to release: the first load of
 * the first window calls it before anything exists.
 */
function releaseBoardResources() {
  if (docSync) {
    docSync.destroy();
    docSync = null;
  }
  fileWatch.closeAll();
  /* ⚠️ THE RUNNING AGENTS DO NOT GO, and they used to. `myConsoles` is
     renderer state, initialised to [], so a reload gave you an empty rail
     while the child processes kept running as children of this one — measured
     2026-09-21: three `claude.exe` still spawned from zevet.exe with the rail
     showing nothing. The first fix reaped them here, which killed every run on
     Ctrl+R, and would kill every run on anything else that reloads the page.

     They are RE-ATTACHED instead: `consoleLog` keeps what each console has
     already sent, and the new page replays it (`local:consoles`). Closing the
     window and quitting still stop them — see the `closed` handler in
     openBoard() and `before-quit`. */
}

/**
 * Lazily build it, or say why not.
 *
 * ⚠️ THE DISTINCTION THE RENDERER NEEDS, spelled out because the two failures
 * have nothing in common and the remedies are opposite:
 *
 *   • `join` resolving `{ok:false}` ALWAYS means a broken or legacy INSTALL.
 *     Re-run setup. It never means the hub is unreachable — nothing in this
 *     path touches the network. It is also permanent until the config changes,
 *     so a retry button is the wrong UI for it.
 *
 *   • THE HUB BEING DOWN never fails `join`. `join` succeeds, the socket
 *     retries with backoff behind it, and the renderer hears about it only
 *     through `onStatus` — `connecting`, `retrying`, `open`. That one IS worth
 *     a retry and IS worth waiting out, because it fixes itself.
 *
 * `code` is carried alongside `error` so this does not have to be inferred
 * from prose: `setup-required` (re-run setup) or `unavailable` (this build or
 * this install cannot sync at all — a missing crypto module, a runtime with no
 * WebSocket; reinstalling is the remedy, and neither is the user's fault).
 * The human-readable `error` is doc-sync.js's own wording, which is written to
 * be shown.
 */
function ensureDocSync() {
  if (docSync) return { sync: docSync };

  const cfg = readConfig();
  if (!cfg) {
    return { error: "this machine is not set up yet — run setup to enable the editor", code: "setup-required" };
  }
  try {
    // Required here rather than at the top of the file: see the note by the
    // other requires. A checkout missing the crypto modules must still start.
    const { DocSync } = require("./doc-sync.js");
    docSync = new DocSync({
      hub: cfg.hub,
      // The secret goes IN and never comes back out. DocSync derives the auth
      // token and the document key from it inside this process.
      secret: cfg.secret,
      onEvent: (room, payload) => {
        // Pinned memory rides the same sealed rooms but is main's, not the editor's.
        if (room.startsWith("steps:")) {
          if (payload.kind === "update" && payload.bytes) stepClaims.applyRemote(payload.bytes);
          return;
        }
        if (room.startsWith("memory:")) {
          if (payload.kind === "update" && payload.bytes && memoryFor() && memoryFor().applyRemote(room.slice(7), payload.bytes)) toBoard("local:memoryEvent", { repo: room.slice(7) });
          return;
        }
        toBoard("doc:message", docMessage(room, payload));
      },
      onStatus: (room, state, detail) => toBoard("doc:status", { room, state, detail }),
    });
    return { sync: docSync };
  } catch (err) {
    // A THROW IS TURNED INTO A VALUE. An `ipcMain.handle` that throws rejects
    // the renderer's promise with a mangled "Error invoking remote method"
    // wrapper, which loses doc-sync.js's carefully written message — and those
    // messages are the entire remedy the user has.
    //
    // Not cached as a sticky failure: re-running setup writes a new config and
    // the next join should pick it up without a restart of the app.
    // CLASSIFIED BY MESSAGE, which is not something to be pleased about.
    // doc-sync.js throws plain Errors with no code on them and belongs to
    // another author, so matching its wording is the only way to tell "your
    // credential needs re-running setup" from "this build cannot sync at all"
    // without widening its API. The two messages it can raise about a
    // credential both name the master secret or the legacy token; a missing
    // crypto module or a runtime without WebSocket names neither.
    //
    // ⚠️ IF THAT WORDING CHANGES, this silently starts telling people to
    // reinstall when they should re-run setup. It is a string match and it is
    // as fragile as it looks. Deliberately ORDERED to fail towards
    // "unavailable", which at least does not send somebody to re-enter a
    // secret that was never the problem.
    const credentialProblem = /master secret|legacy token/i.test(err.message);
    return { error: err.message, code: credentialProblem ? "setup-required" : "unavailable" };
  }
}

/**
 * The shape that crosses to the renderer, with the bytes made safe to ship.
 *
 * ⚠️ THE COPY IS NOT PARANOIA, AND THIS WAS MEASURED RATHER THAN ASSUMED.
 * `doc-crypto.open()` returns a Node `Buffer`, and a small Buffer is a VIEW
 * over Node's shared 8 KiB allocation pool. Electron's structured clone
 * serialises the whole backing store behind the view: a throwaway Electron
 * 38.1.2 app sending a 3-byte pooled Buffer produced, in the receiving world, a
 * 3-byte view whose `.buffer.byteLength` was 8192. That is roughly 8 KiB of
 * whatever else Node had in its pool — other rooms' decrypted frames among
 * them — shipped on every update to a renderer running the HUB'S page.
 *
 * `new Uint8Array(view)` copies the elements into a fresh exact-length buffer
 * with nothing behind it; the same probe showed `.buffer.byteLength` of 3 after
 * this line. It also settles the type question at the source: what leaves here
 * is a plain `Uint8Array` — the probe confirmed a `Buffer` arrives on the far
 * side as a Uint8Array with `Buffer.isBuffer` false — so the renderer cannot
 * depend on Buffer methods that will not exist there.
 */
function docMessage(room, payload) {
  const out = { room, kind: payload.kind };
  if (payload.bytes) out.bytes = new Uint8Array(payload.bytes);
  return out;
}

bridge.handle("doc:join", (_e, room) => {
  const got = ensureDocSync();
  if (got.error) return { ok: false, error: got.error, code: got.code };
  try {
    got.sync.join(String(room || ""));
    return { ok: true };
  } catch (err) {
    // DocSync.join validates the room name and throws; a renderer asking for a
    // 300-character room is a bug in the renderer, not a reason to reject.
    return { ok: false, error: err.message, code: "bad-room" };
  }
});

bridge.handle("doc:send", (_e, { room, bytes, opts }) => {
  if (!docSync) return { ok: false, error: "not joined", code: "not-joined" };
  const u8 = toBytes(bytes);
  if (!u8) return { ok: false, error: "update must be bytes" };
  try {
    // `opts` is FILTERED, not forwarded, on the same rule as local:write: a
    // fresh object with the one field this bridge promises, so nothing a
    // renderer invents can reach DocSync.
    docSync.send(String(room || ""), u8, { snapshot: Boolean(opts && opts.snapshot) });
    return { ok: true };
  } catch (err) {
    // "not joined: <room>" lands here, which is a real thing a renderer can
    // hit by racing a leave against an in-flight update.
    return { ok: false, error: err.message };
  }
});

bridge.handle("doc:comments", (_e, { room, data }) => {
  try {
    return { ok: Boolean(require("./doc-sync.js").writeCommentsFile(zevetHome(), room, data)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

bridge.handle("doc:leave", (_e, room) => {
  if (docSync) docSync.leave(String(room || ""));
  // Always ok. Leaving a room that was never joined is what a closing tab does
  // and there is nothing to report about it.
  return { ok: true };
});

/**
 * Whatever the renderer sent, as a Uint8Array, or null if it sent nonsense.
 *
 * A renderer `Uint8Array` sent through `invoke` was OBSERVED to arrive here as
 * a plain `Uint8Array` (Electron 38.1.2, Windows 11, a throwaway probe app that
 * is not in the gate — this repo has no Electron harness). The other two
 * branches are written from the structured-clone contract rather than from
 * anything seen, and are kept because the alternative — assuming — fails as an
 * empty update that silently syncs nothing and reports no error.
 */
function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

// ---- starting an agent -----------------------------------------------------

/**
 * Consoles this app has started, by id.
 *
 * Deliberately per-window-session and not persisted: a zevet that silently
 * resurrected somebody's agent on next launch would be spending their money
 * without being asked.
 */
const consoles = new Map();

/** What every console has already sent the board, so a reload can replay it.
 *  See console-log.js. */
const consoleLog = createConsoleLog({ onceDone: (id) => stopAgentCore(id) });

const worktrees = createAgentWorktrees({ home: HOME });

/**
 * Where each open thread's agent works: its repo, or a worktree of it when
 * another thread already had the repo (agent-worktree.js). Per thread, not per
 * process — a follow-up resumes where its conversation lives — so a worktree
 * goes when the thread closes, or when a scheduled run ends.
 */
const placements = new Set();

function placementOf(id) {
  for (const p of placements) if (p.id === id) return p;
  return null;
}

/** Added BEFORE any await, so two agents started at once still see each
 *  other. Any git failure leaves the agent in the repo, as before. */
async function placeAgent(dir) {
  const shared = [...placements].some((p) => p.root === dir);
  const p = { id: null, root: dir, cwd: dir, worktree: null, session: "", title: "" };
  placements.add(p);
  if (shared) {
    const wt = await worktrees.create(dir);
    if (wt) Object.assign(p, { cwd: wt.cwd, worktree: wt });
  }
  return p;
}

/** A new process in the placement; its exit is what a release waits for. */
function trackPlacement(p, id) {
  p.id = id;
  p.gone = new Promise((resolve) => (p.exited = resolve));
}

/** claude's session id is what a fork of it names, and claude finds a
 *  session only from the folder it ran in. `id` is the process the event came
 *  from: a replaced process exiting says nothing about its successor. */
function notePlacement(p, evt, id) {
  if (evt && evt.type === "exit" && p.exited && p.id === id) p.exited();
  const sid = evt && evt.type === "agent" && evt.payload && evt.payload.session_id;
  if (sid && !p.session) p.session = String(sid);
}

/** Set once a payload swap starts: the consoles it stops are resumed in their
 *  own worktrees after the relaunch, so nothing may be released under them. */
let relaunching = false;

/** Placements whose integration did not finish (waiting, failed, no checks):
 *  their worktree stays until the person integrates, discards or closes the
 *  thread. Keyed by run id, which is what the subagent row names. */
const pendingIntegrations = new Map();

const gitRun = (args) => new Promise((resolve, reject) => execFile("git", args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out) => err ? reject(err) : resolve(String(out))));

/** One integration attempt, its outcome shown on the subagent row. */
async function integratePlacement(p, manual) {
  const result = await integrateAgent({ worktree: p.worktree, runId: p.id, manual, git: gitRun, checks: runAgentChecks, markerDir: path.join(HOME, "integrations") });
  p.integration = result.status;
  consoleLog.updateMeta(p.id, { integration: result });
  toBoard("local:agentIntegration", { id: p.id, ...result });
  if (result.status === "integrated") pendingIntegrations.delete(p.id);
  else pendingIntegrations.set(p.id, p);
  return result;
}

/** `integrate`: this is the end of the run (a scheduled run), so try to bring
 *  its work back. Thread close, quit and failed starts only release: nothing
 *  may merge into the user's checkout where no row can show it. */
async function releasePlacement(p, { integrate = false } = {}) {
  if (relaunching) return;
  if (!placements.delete(p) || !p.worktree) return;
  // A fork shares its source's worktree; the last one out removes it.
  if ([...placements].some((q) => q.worktree === p.worktree)) return;
  // Not from under a process that may still have files open in it.
  await Promise.race([p.gone, new Promise((r) => setTimeout(r, 5000))]);
  if (integrate && p.id && p.integration !== "integrated") {
    const result = await integratePlacement(p, false);
    if (result.status !== "integrated") return;
  }
  await worktrees.release(p.worktree, p.title);
}

/** The Integrate button. Same guards as the automatic trigger, and it still
 *  waits for a process that is running. */
async function integrateAgentById(id) {
  const p = pendingIntegrations.get(id) || placementOf(id);
  if (!p || !p.worktree) return { status: "failed", why: "nothing to integrate" };
  const held = consoleLog.get(id);
  if (held && held.running) return { status: "waiting", why: "agent is still running" };
  const result = await integratePlacement(p, true);
  if (result.status === "integrated" && !placements.has(p)) await worktrees.release(p.worktree, p.title);
  return result;
}

/** The Discard button: the worktree and its branch go. */
async function discardAgentById(id) {
  const p = pendingIntegrations.get(id) || placementOf(id);
  if (!p || !p.worktree) return { status: "failed", why: "nothing to discard" };
  const held = consoleLog.get(id);
  if (held && held.running) return { status: "waiting", why: "agent is still running" };
  if (!(await worktrees.discard(p.worktree))) return { status: "failed", why: "could not remove the worktree" };
  pendingIntegrations.delete(id);
  placements.delete(p);
  const result = { status: "discarded" };
  consoleLog.updateMeta(id, { integration: result });
  toBoard("local:agentIntegration", { id, ...result });
  return result;
}

function toBoard(channel, payload) {
  if (boardWindow && !boardWindow.isDestroyed()) boardWindow.webContents.send(channel, payload);
}

/**
 * Which agents this machine has, and whether they are signed in.
 *
 * detect.mjs is ESM and this file is CommonJS, so it is loaded with a dynamic
 * import rather than duplicated — two copies of "where is codex installed"
 * would drift the first time one of them learned something, and that module
 * already knows about the build-hash directory the Windows installer uses.
 *
 * Sign-in is inferred from the PRESENCE of the file each CLI writes when an
 * account is configured. Nothing here reads a credential, and the result says
 * "an account is set up", not "that account is valid" — an expired token looks
 * identical from the outside, and claiming otherwise would be inventing a
 * check that was never made.
 */
let detectPromise = null;
function loadDetect() {
  if (!detectPromise) {
    const target = runtime.clientFile("detect.mjs", { clientDir: CLIENT_DIR });
    if (!target) return Promise.resolve(null);
    detectPromise = import(pathToFileURL(target).href).catch((err) => {
      console.error(`zevet: could not load detect.mjs (${err.message})`);
      return null;
    });
  }
  return detectPromise;
}

/** Candidate path for Meta's own Mac chat app (ai.meta.com/meta-ai/download,
 *  live since 2026-08-19). Listed as a candidate, not a fact — nobody has
 *  installed it to confirm the bundle name, same discipline detect.mjs
 *  already uses for codex/opencode's macOS paths. Presence only; never
 *  launched. No Windows build has shipped as of this session (search turned
 *  up Mac coverage only), so there is nothing to check for on win32. This is
 *  a separate product from Muse Code (the CLI) and from the Model API — it
 *  grants no API key, so it is informational (`detail`) only. */
function metaAiAppDetail() {
  if (process.platform !== "darwin") return null;
  const candidate = "/Applications/Meta AI.app";
  return fs.existsSync(candidate) ? candidate : null;
}

bridge.handle("local:agents", async () => {
  await runtimeReady;
  const detect = await loadDetect();
  const found = detect ? detect.detectAgents() : [];
  // The CLIs' own model lists, read fresh from their caches on every call, so
  // a model claude or codex learned about this morning is offered without a
  // zevet release. null when there is no cache: the board then keeps the list
  // it shipped with (board/src/lib/agent-models.generated.mjs, same reader).
  const catalogs = { claude: agentCatalogs.claudeModels(), codex: agentCatalogs.codexModels() };
  const rows = ["claude", "codex", "opencode"].map((name) => {
    const r = agentConsole.resolveAgent(name);
    const id = name === "claude" ? "claude-code" : name;
    const d = found.find((a) => a.id === id) || {};
    return {
      name,
      ok: Boolean(r.ok),
      detail: r.ok ? r.file : r.error,
      signedIn: Boolean(d.signedIn),
      models: catalogs[name] || undefined,
      // "unverified" for codex means the hook path is unproven; the CONSOLE
      // path below is what this launcher uses, and that is separate.
      hooks: d.hooks === undefined ? null : d.hooks,
    };
  });

  // Meta's Model API — no execution adapter (docs/contracts/meta-model-api.md),
  // so `ok` is always false; `signedIn` is what composercontrols.tsx uses to
  // decide whether to list it at all. Three legitimate sources, any one
  // suffices: the documented env var, a key saved in Settings, or Muse Code
  // itself being installed with that env var present (its own auth path is
  // the same MODEL_API_KEY — see docs/contracts/muse-code-hooks.md).
  const museCode = found.find((a) => a.id === "muse-code") || {};
  const hasSavedKey = credentials.listCredentials().some((c) => c.provider === "meta");
  const hasEnvKey = Boolean(process.env.MODEL_API_KEY);
  const appDetail = metaAiAppDetail();
  const metaDetails = [
    hasEnvKey && "MODEL_API_KEY",
    hasSavedKey && "saved in Settings",
    museCode.installed && !hasEnvKey && !hasSavedKey && "Muse Code installed, no key",
    appDetail && `Meta AI app: ${appDetail}`,
  ].filter(Boolean);
  rows.push({
    name: "meta",
    ok: false,
    detail: metaDetails.join(", "),
    signedIn: hasEnvKey || hasSavedKey,
    models: undefined,
    hooks: null,
  });
  return rows;
});

/* ---------------------------------------------------------------------------
 * COMPUTER USE — zevet's own MCP server, and the gate in front of it
 *
 * claude takes `--mcp-config <file>` and `--permission-prompt-tool <name>`
 * (both measured 2026-09-21 on 2.1.278), so zevet can hand an agent a server of
 * its own and be the thing that answers when the agent asks permission. That is
 * how the board gains a capability the CLI does not have: `desktop/zevet-mcp.js`
 * offers `screenshot`, `click`, `type_text` and `press_key`.
 *
 * ⚠️ THIS IS THE MOST DANGEROUS THING IN THE APPLICATION, so read the shape of
 * the guard rather than the list of tools:
 *
 *   1. OFF BY DEFAULT, per repo, by explicit choice. `agentSettingsFor`
 *      defaults `computerUse` to false and every unreadable, missing or
 *      hand-mangled setting lands there too.
 *   2. The MCP server ACTS ON NOTHING without a permit. It POSTs every call to
 *      the loopback server below and obeys the answer; with no
 *      ZEVET_MCP_URL/TOKEN in its environment it refuses everything, so a
 *      stray copy of that file is not a remote control for somebody's desktop.
 *   3. The loopback server is bound to 127.0.0.1, requires a per-run bearer
 *      token, and DENIES on timeout rather than allowing.
 *   4. The person answers. Every permit becomes a card in the board and the
 *      agent blocks until it is answered — that is what
 *      `--permission-prompt-tool` buys.
 *
 * One server for the app, started the first time a console needs it, because
 * the port and token are per-process rather than per-console and a console
 * that ends does not invalidate another's.
 * ------------------------------------------------------------------------- */
const MCP_SERVER = path.join(__dirname, "zevet-mcp.js");

/** Requests waiting on a person, by id. */
const pendingPermits = new Map();
/** Which console's MCP run asked each open permit, and which console each MCP run belongs to (masora-runs-wire.js needsYouFor). */
const permitRuns = new Map();
const runConsoles = new Map();
/** Questions waiting on a person, by id — same idea as pendingPermits, one
 *  map per ask-server route because a permit id and an ask id share no
 *  namespace and must never be answerable through the other's channel. */
const pendingAsks = new Map();
/** "Always allow" answers for Claude's own tools, per run. */
const permitGrantsModule = require("./permit-grants.js");
const permitGrants = { ...permitGrantsModule.createGrants(), ruleKey: permitGrantsModule.ruleKey };
let permitSeq = 0;
let askServerPromise = null;

const masoraRunsWire = require("./masora-runs-wire.js");
/** Masora agent runs (masora-runs.js, spec 06 C5), off unless `runs` is set in masora.json. Called once from whenReady. */
bridge.handle("zevet:masoraRunsPoll", (_e, arg) => masora.setRunsPoll(Boolean(arg && arg.on)));
function startMasoraRuns() {
  return masoraRunsWire.startMasoraRuns({
    masora, safeStorage, consoleLog, agentApi, payerOf,
    announceOutcome: (id, outcome) => toBoard("local:masoraRun", { id, outcome }),
    readWorkspaces, storedMode, startAndBrief,
    stopAgentCore: (id) => stopAgentCore(id),
    permits: { pendingPermits, permitRuns, runConsoles },
    isRelaunching: () => relaunching,
  });
}
/** MCP run id -> the folder that run was started in (agent-tools.js record_memory). */
const runRoots = new Map();

function ensureAskServer() {
  if (!askServerPromise) {
    askServerPromise = askServer.start({
      onPermit: (request) =>
        new Promise((resolve) => {
          // "Always allow this" answered earlier in this run (permit-grants.js).
          const run = request && typeof request.run === "string" ? request.run : "";
          if (request && request.via === "claude" && permitGrants.allows(run, request.tool, request.arguments)) {
            resolve({ ok: true });
            return;
          }
          const id = `p${++permitSeq}`;
          if (run) permitRuns.set(id, run);
          // A teammate may answer this too (D-086) when the team allows it.
          // The card id is separate from the local id, and unique across restarts.
          const cardId = approvalCanShare() ? crypto.randomUUID() : "";
          if (cardId) {
            approvalHost().begin({
              id: cardId,
              tool: request && request.tool,
              arguments: request && request.arguments,
              session: run || "run",
              agent: String((request && request.via) || ""),
              resolve: (answer) => {
                pendingPermits.delete(id);
                toBoard("local:steerEvent", { kind: "permit-gone", id: cardId, permitId: id });
                resolve(answer);
              },
            });
          }
          pendingPermits.set(id, (answer) => {
            if (cardId) approvalHost().local(cardId, answer.ok === true);
            if (answer.ok && answer.always && request && request.via === "claude") {
              permitGrants.grant(run, request.tool, request.arguments);
            }
            resolve(answer);
          });
          // The board decides. If no board is listening — the window is gone,
          // or it is an older build that does not know this event — nothing
          // resolves this and the ask-server's own timeout denies it, which is
          // the correct end for a question nobody can be asked.
          toBoard("local:permitRequest", {
            id,
            ...(request || {}),
            ...(request && request.via === "claude" ? { canAlways: permitGrants.ruleKey(request.tool, request.arguments) !== null } : {}),
          });
        }),
      onAsk: (request) =>
        new Promise((resolve) => {
          const id = `a${++permitSeq}`;
          pendingAsks.set(id, resolve);
          toBoard("local:askRequest", { id, ...(request || {}) });
        }),
      onTool: (request) => {
        const r = request && typeof request === "object" ? request : {};
        // The folder comes from OUR record of this run, never from the agent's arguments.
        return agentTools().call(String(r.tool || ""), r.arguments, { root: runRoots.get(String(r.run || "")) || null });
      },
    });
  }
  return askServerPromise;
}

/** The person's answer to one permit. */
bridge.handle("local:permitAnswer", (_e, arg) => {
  const id = arg && typeof arg.id === "string" ? arg.id : "";
  const resolve = pendingPermits.get(id);
  if (!resolve) return { ok: false, error: "no such request" };
  pendingPermits.delete(id);
  permitRuns.delete(id);
  resolve({ ok: arg && arg.allow === true, reason: (arg && arg.reason) || "refused", always: Boolean(arg && arg.always) });
  return { ok: true };
});

/** The person's answer to one question. */
bridge.handle("local:askAnswer", (_e, arg) => {
  const id = arg && typeof arg.id === "string" ? arg.id : "";
  const resolve = pendingAsks.get(id);
  if (!resolve) return { ok: false, error: "no such request" };
  pendingAsks.delete(id);
  const picked = Array.isArray(arg && arg.picked) ? arg.picked.filter((p) => typeof p === "string") : [];
  resolve({ ok: picked.length > 0, picked });
  return { ok: true };
});

/**
 * The `--mcp-config` file for one console, or null when there is nothing to
 * put in it (computer use is off for this repo AND Masora is not paired).
 *
 * ⚠️ `node` IS NOT ON THE PATH OF A PACKAGED APP. Electron's own binary is,
 * and with ELECTRON_RUN_AS_NODE it runs a script as plain node — which is the
 * only interpreter guaranteed to exist beside the app.
 *
 * C4 (docs/contracts/cross_app_context.md): the `masora` entry is an `http`
 * server pointing at `<masoraUrl>/mcp` -- verified against the installed
 * claude CLI itself (`claude mcp add-json`'s own written config, this
 * session) rather than guessed: `{"type":"http","url":"..."}`. The OAuth
 * handshake for that connection is the CLI's own job, not zevet's -- no
 * token is written here, unlike the `zevet` stdio entry below.
 */
async function mcpConfigFor(dir, mode) {
  const servers = {};
  let mcpRun = "";
  const computerUse = Boolean(agentSettingsFor(dir).computerUse);
  /* The zevet server also carries `permission_prompt`, which is how a headless
     claude asks the person instead of silently denying what would prompt. Every
     posture but "skip permissions" needs it (nothing prompts under that one). */
  const gate = mode !== "dangerous";
  /* Coordination tools (D-087) need a team to coordinate with. */
  const team = steerAuth(readConfig()).session;
  if ((computerUse || gate || team) && fs.existsSync(MCP_SERVER)) {
    const { url, token } = await ensureAskServer();
    const run = `r${process.pid}-${++permitSeq}`;
    runRoots.set(run, dir);
    mcpRun = run;
    servers.zevet = {
      command: process.execPath,
      args: [MCP_SERVER],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        ZEVET_MCP_URL: url,
        ZEVET_MCP_TOKEN: token,
        ZEVET_MCP_RUN: run,
        ZEVET_MCP_TEAM: team ? "1" : "0",
        // Without this the four computer tools are never listed, whatever the setting says.
        ZEVET_MCP_COMPUTER: computerUse ? "1" : "0",
      },
    };
  }
  const masoraCfg = masora.readConfig();
  if (masoraCfg.paired) Object.assign(servers, masora.mcpServerEntry(masoraCfg.url));
  if (!Object.keys(servers).length) return null;
  const file = path.join(app.getPath("temp"), `zevet-mcp-${process.pid}-${++permitSeq}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }), "utf8");
  // `permissions` says whether the `zevet` tool server (and so its permission
  // tool) is actually in this file -- a masora-only config must not claim a
  // permission tool that config does not register.
  return { file, computerUse, permissions: Boolean(servers.zevet) && (computerUse || gate), run: mcpRun };
}

/**
 * C2/C4: "Context from Masora" at agent start. Only runs when Masora is
 * paired AND the OS keychain can give back the token; any other outcome
 * (unpaired, no prompt yet, fetch error, 2s timeout) is silently no brief --
 * masora.briefFor() already fails open, this just skips the call it can't
 * make (no token to send) rather than making a doomed one.
 */
async function masoraBriefFor(dir, prompt) {
  const cfg = masora.readConfig();
  if (!cfg.paired || !safeStorage.isEncryptionAvailable()) return null;
  const token = masora.loadToken((buf) => safeStorage.decryptString(buf));
  if (!token) return null;
  const repository = await masoraPush.deriveRepository(dir);
  const result = await masora.briefFor({ baseUrl: cfg.url, token, prompt, repository });
  return result ? result.brief : null;
}

/** The shared body of `local:startAgent` and the control API's `spawn` --
 *  `trusted` is what tells the two apart (see `trustedDir` above). */
/* ---- the Zevet model (desktop/zevet-router.js) ---------------------------
   What is runnable is asked per turn and cached a minute: a CLI can sign in
   mid-session. `opencode models` is a process spawn, so its list is kept ten. */
const zevetRouter = require("./zevet-router.js");
const repoPrivacy = require("./repo-privacy.js");
let openModelsCache = { at: 0, list: null };
function listOpenModels() {
  const r = agentConsole.resolveAgent("opencode");
  if (!r.ok) return Promise.resolve(null);
  const inv = r.kind === "shim"
    ? agentConsole._internals.buildShimInvocation(r.file, ["models"])
    : { command: r.file, args: ["models"], options: {} };
  return new Promise((resolve) => {
    execFile(inv.command, inv.args, { ...inv.options, windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, out) =>
      resolve(err ? null : String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)));
  });
}
let zevetLadderCache = { at: 0, ladder: null };
async function zevetLadder() {
  if (zevetLadderCache.ladder && Date.now() - zevetLadderCache.at < 60_000) return zevetLadderCache.ladder;
  const detect = await loadDetect();
  const found = detect ? detect.detectAgents() : [];
  const usable = (name, id) => agentConsole.resolveAgent(name).ok && Boolean((found.find((a) => a.id === id) || {}).signedIn);
  if (Date.now() - openModelsCache.at > 10 * 60_000) openModelsCache = { at: Date.now(), list: await listOpenModels() };
  const ladder = zevetRouter.buildLadder({
    has: { claude: usable("claude", "claude-code"), codex: usable("codex", "codex"), opencode: agentConsole.resolveAgent("opencode").ok },
    claude: agentCatalogs.claudeModels(),
    codex: agentCatalogs.codexModels(),
    opencode: openModelsCache.list,
  });
  zevetLadderCache = { at: Date.now(), ladder };
  return ladder;
}
/** A routed console: the same handle shape as startConsole's, one CLI process per rung in use. */
function startZevetConsole(spec, claudeOnly) {
  return zevetRouter.startRouted({
    id: spec.id,
    onEvent: spec.onEvent,
    ladder: zevetLadder,
    isPrivate: () => repoPrivacy.isPrivate(spec.cwd),
    start: (rung, extra) =>
      instrumentedStartConsole({
        ...spec,
        id: undefined,
        agent: rung.agent,
        model: rung.model,
        onEvent: extra.onEvent,
        ...(extra.resumeFrom ? { resumeFrom: extra.resumeFrom } : {}),
        ...(rung.agent === "claude" ? claudeOnly : {}),
      }),
  });
}

async function startAgentCore({ agent, cwd, opts, trusted, resumeFrom, forcedId, restorePlace } = {}) {
  await runtimeReady;
  const dir = trusted ? trustedDir(cwd) : knownRoot(cwd);
  if (!dir) return { ok: false, error: trusted ? "cwd does not exist" : "not an opened workspace" };

  // A claude fork has to start where its source session ran — claude finds a
  // session only from that folder — so it joins its source's worktree rather
  // than getting one of its own. Anything else is placed first, before the
  // awaits below, so an agent started meanwhile sees this one.
  const forkFrom = opts && typeof opts.forkFrom === "string" ? opts.forkFrom : "";
  const source = forkFrom && String(agent || "") === "claude" ? [...placements].find((p) => p.session === forkFrom) : null;
  /* `--continue` finds "the latest session in this folder", so it must start IN
     the folder: a fresh worktree would have no sessions to continue. */
  const inPlace = Boolean(opts && opts.continueLatest === true && String(agent || "") === "claude");
  /* A console restored after a payload swap goes back into the folder its
     session ran in — claude finds a session only from there — and keeps the
     worktree it had, rather than being placed afresh. */
  const place = restorePlace
    ? { id: null, root: restorePlace.root || dir, cwd: dir, worktree: restorePlace.worktree || null, session: String(resumeFrom || ""), title: "" }
    : source
    ? { ...source, id: null, session: "", title: "" }
    : inPlace
    ? { id: null, root: dir, cwd: dir, worktree: null, session: "", title: "" }
    : await placeAgent(dir);
  if (restorePlace || source || inPlace) placements.add(place);

  // Standing instructions for this repo, if any were saved. Only claude has a
  // flag for them (agent-console.js § invocationFor); the other two ignore the
  // option rather than being handed something they cannot use.
  const settings = agentSettingsFor(dir);
  let systemPrompt = withActivity(settings.systemPrompt);
  // C2/C4: the brief needs SOME prompt text to match against; when the
  // renderer has not queued one yet (an interactive session where nobody has
  // typed the first message), there is nothing to ask Masora and this is
  // skipped rather than sent empty. A failure here costs context, not the run.
  const firstPrompt = opts && typeof opts.prompt === "string" ? opts.prompt : "";
  if (firstPrompt) {
    try {
      const brief = await masoraBriefFor(dir, firstPrompt);
      if (brief) systemPrompt = masora.withBrief(systemPrompt, brief);
    } catch (err) {
      console.error(`zevet: could not fetch the Masora brief: ${err.message}`);
    }
  }
  // And zevet's own MCP server / Masora's, only for the CLI that can be
  // handed one. A failure to set either up must not stop the agent starting
  // — it costs a capability, not the run.
  let mcpConfig = null;
  const isZevet = String(agent || "") === "zevet";
  if (String(agent || "") === "claude" || isZevet) {
    try {
      mcpConfig = await mcpConfigFor(dir, opts && typeof opts.mode === "string" ? opts.mode : "auto");
    } catch (err) {
      console.error(`zevet: could not set up MCP servers: ${err.message}`);
    }
  }

  // A mutable holder rather than closing over `started` directly: onEvent can
  // fire DURING startConsole (a spawn that fails immediately does exactly
  // that), and at that moment `const started` is still in its temporal dead
  // zone — reading it throws a ReferenceError out of the error path, which is
  // the worst possible place to add a second failure.
  const handle = { id: null };
  const engineReq = opts && typeof opts.engine === "string" ? opts.engine : "";
  const resolved = await agentEnvFor(engineReq);
  if (!resolved.ok) {
    void releasePlacement(place);
    return { ok: false, error: resolved.error };
  }
  const env = resolved.env;
  // What only the claude CLI is handed. A routed console gives it to its claude rungs alone.
  const claudeOnly = {
    ...(mcpConfig
      ? {
          mcpConfig: mcpConfig.file,
          // claude names an MCP tool `mcp__<server>__<tool>`; the server is
          // registered as `zevet` above, only when computer use is actually on.
          ...(mcpConfig.permissions ? { permissionTool: "mcp__zevet__permission_prompt" } : {}),
        }
      : {}),
    // A routed console has no claude of its own; its claude rungs take these.
    ...(isZevet ? agentConsole.extrasFrom(opts) : {}),
  };
  const spec = {
    agent: String(agent || ""),
    cwd: place.cwd,
    repoRoot: place.root,
    model: opts && typeof opts.model === "string" ? opts.model : "",
    mode: opts && typeof opts.mode === "string" ? opts.mode : "auto",
    ...(resumeFrom ? { resumeFrom: String(resumeFrom) } : {}),
    ...(forcedId ? { id: String(forcedId) } : {}),
    systemPrompt,
    env,
    ...(isZevet ? {} : claudeOnly),
    /* ⚠️ ASKED FOR, AND ALLOWED, ARE TWO DIFFERENT THINGS. The renderer may
       ask for a forked run; whether this repo may is decided here, against the
       saved settings, because the renderer is the untrusted side of the
       bridge. Same rule the workspace guard follows above. */
    forkFrom: isZevet ? "" : forkFrom,
    ...(String(agent || "") === "claude" ? agentConsole.extrasFrom(opts) : {}),
    onEvent: (evt) => {
      // The status strip's rolling windows are fed HERE, in the main process,
      // and not in the renderer. The renderer shows the live figures off the
      // same events, but it forgets everything on reload and the agents it
      // started keep running -- so the only place a week's spend can actually
      // accumulate is this side of the bridge.
      if (evt && evt.type === "agent") noteBurn(evt.payload, handle.id);
      notePlacement(place, evt, handle.id);
      if (evt && evt.type === "agent" && evt.payload && evt.payload.session_id) consoleLog.updateMeta(handle.id, { sessionId: String(evt.payload.session_id) });
      toBoard("local:agentEvent", consoleLog.record(handle.id, evt));
      // The session is over: what it claimed goes, for teammates too.
      if (evt && evt.type === "exit") {
        if (mcpConfig && mcpConfig.run) runConsoles.delete(mcpConfig.run);
        const c = consoleLog.snapshot().consoles.find((x) => x.id === handle.id);
        if (c && c.sessionId) {
          myClaims.endSession(c.sessionId);
          if (myPayers.delete(c.sessionId)) void sharePayer(readConfig()?.actor || "", c.sessionId, null);
        }
      }
    },
  };
  const started = isZevet ? startZevetConsole(spec, claudeOnly) : instrumentedStartConsole(spec);
  if (!started.ok) {
    void releasePlacement(place);
    return { ok: false, error: started.error };
  }

  handle.id = started.id;
  if (mcpConfig && mcpConfig.run) runConsoles.set(mcpConfig.run, started.id);
  trackPlacement(place, started.id);
  consoles.set(started.id, started);
  consoleLog.open(started.id, consoleMeta(agent, dir, opts, place, resolved.engine));
  return { ok: true, id: started.id, agent, cwd: dir, engine: resolved.engine };
}
/** Directories the control API has asked the board to start an agent in: the
 *  board's start is untrusted (knownRoot), so these -- set by main alone, for the
 *  span of one request -- are let through as the API's own `spawn` is. */
const apiRoots = createApiRootLease();
bridge.handle("local:startAgent", (_e, args) => startAgentCore({ ...args, trusted: apiRoots.has(path.resolve(String((args && args.cwd) || ""))) }));

/** What a reloaded board needs to rebuild a console's rail entry. `root` is
 *  the repo the user picked even when the agent works in a worktree of it.
 *  `engineUsed` is only set when a caller named an engine (desktop/
 *  agent-engine.js) -- absent, the card shows nothing new, exactly as before
 *  engine selection existed. `opts.label` names an API-spawned console
 *  (desktop/agent-api.js "spawn"); UI-started consoles never set it. */
/** Show a console the board did not start (API spawn, schedule) in every
 *  workspace: the board only learns of its own launches and of a reload's
 *  snapshot, so without this it sees such an agent only via the repo-scoped disk scan. */
function announceConsole(id) {
  const entry = consoleLog.get(id);
  if (entry) toBoard("local:agentAttached", entry);
}

function consoleMeta(agent, dir, opts, place, engineUsed) {
  return {
    agent: String(agent || ""),
    root: dir,
    model: opts && typeof opts.model === "string" ? opts.model : "",
    mode: opts && typeof opts.mode === "string" ? opts.mode : "auto",
    startedAt: Date.now(),
    ...(engineUsed ? { engine: engineUsed } : {}),
    ...(opts && typeof opts.label === "string" && opts.label ? { label: opts.label } : {}),
    ...(place && place.worktree ? { worktree: place.worktree.dir, branch: place.worktree.branch } : {}),
    ...(opts && opts.sessionId ? { sessionId: String(opts.sessionId) } : {}),
  };
}

function resumeSnapshotFile() { return path.join(app.getPath("userData"), consolePersistence.FILE); }
function persistResumableConsoles() {
  const consoles = consoleLog.snapshot().consoles.map((e) => {
    const p = placementOf(e.id);
    return { ...e, cwd: (p && p.cwd) || e.cwd, root: (p && p.root) || e.root, worktreeRecord: (p && p.worktree) || null };
  });
  consolePersistence.write(resumeSnapshotFile(), consoles);
}
/** Before the worktree prune: a restored console keeps its worktree. */
async function restoreResumableConsoles() {
  const saved = consolePersistence.read(resumeSnapshotFile());
  try { fs.rmSync(resumeSnapshotFile(), { force: true }); } catch (err) { console.warn(`[zevet] resume snapshot not removed: ${err.message}`); }
  for (const s of saved) {
    const r = await startAgentCore({
      agent: s.agent, cwd: s.cwd, trusted: true, resumeFrom: s.sessionId, forcedId: s.id,
      restorePlace: { root: s.root, worktree: s.worktreeRecord || null },
      opts: { model: s.model, mode: s.mode, engine: s.engine, label: s.label, sessionId: s.sessionId },
    });
    if (!r.ok) console.warn(`[zevet] could not resume console ${s.id}: ${r.error}`);
    else if (s.inFlight) sendToAgentCore(s.id, "Zevet restarted to apply an update. Continue exactly where you left off.");
  }
}

/**
 * A follow-up prompt to a console whose process has already exited.
 *
 * codex and opencode close stdin after one prompt, so their console is dead
 * the moment it has answered. Both can RESUME a session by id, and so can
 * claude, which makes a follow-up an ordinary start with `resumeFrom` set —
 * the agent picks the conversation up with everything it already read.
 *
 * The board keeps the SAME console entry and swaps in the new process id, so
 * the transcript continues rather than starting a second thread beside it.
 */
bridge.handle("local:resumeAgent", async (_e, { agent, cwd, resumeFrom, opts }) => {
  await runtimeReady;
  if (typeof resumeFrom !== "string" || !resumeFrom.trim()) {
    return { ok: false, error: "no session to resume" };
  }
  /* A session started in a terminal resumes from the folder IT ran in, which
     need not be an opened workspace. The renderer cannot choose that folder:
     it is accepted only when it is the one the session's own transcript
     recorded (agent-sessions.cwdOf) and still exists. Anything else is the
     workspace rule, as before. */
  let dir = knownRoot(cwd);
  if (!dir && typeof cwd === "string") {
    const own = agentSessions.cwdOf(String(agent || ""), resumeFrom.trim());
    if (own && path.resolve(own) === path.resolve(cwd)) {
      try {
        if (fs.statSync(own).isDirectory()) dir = path.resolve(own);
      } catch {
        return { ok: false, error: `That session's folder no longer exists: ${own}` };
      }
    }
  }
  if (!dir) return { ok: false, error: "not an opened workspace" };
  const settings = agentSettingsFor(dir);
  let mcpConfig = null;
  if (String(agent || "") === "claude") {
    try {
      mcpConfig = await mcpConfigFor(dir, opts && typeof opts.mode === "string" ? opts.mode : "auto");
    } catch (err) {
      console.error(`zevet: could not set up computer use: ${err.message}`);
    }
  }

  // A session resumes only from where it ran. A thread with no worktree left
  // (a scheduled run that ended) is back in the repo.
  const continues = opts && typeof opts.continues === "string" ? opts.continues : "";
  let place = placementOf(continues);
  if (!place || (place.worktree && !fs.existsSync(place.cwd))) {
    if (place) placements.delete(place);
    place = { id: null, root: dir, cwd: dir, worktree: null, session: "", title: "" };
    placements.add(place);
  }

  const handle = { id: null };
  const engineReq = opts && typeof opts.engine === "string" ? opts.engine : "";
  const resolved = await agentEnvFor(engineReq);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const env = resolved.env;
  // The thread keeps its id and label across the new process, so `zagent --attach <id>` and any waiter still find it.
  const kept = consolePersistence.resumedIdentity(continues ? consoleLog.get(continues) : null, continues, opts);
  const started = instrumentedStartConsole({
    ...(kept.id ? { id: kept.id } : {}),
    agent: String(agent || ""),
    cwd: place.cwd,
    repoRoot: place.root,
    model: opts && typeof opts.model === "string" ? opts.model : "",
    mode: opts && typeof opts.mode === "string" ? opts.mode : "auto",
    systemPrompt: withActivity(settings.systemPrompt),
    resumeFrom: resumeFrom.trim(),
    ...(String(agent || "") === "claude" ? agentConsole.extrasFrom({ ...opts, continueLatest: false }) : {}),
    env,
    ...(mcpConfig
      ? {
          mcpConfig: mcpConfig.file,
          ...(mcpConfig.permissions ? { permissionTool: "mcp__zevet__permission_prompt" } : {}),
        }
      : {}),
    onEvent: (evt) => {
      if (evt && evt.type === "agent") noteBurn(evt.payload, handle.id);
      notePlacement(place, evt, handle.id);
      toBoard("local:agentEvent", consoleLog.record(handle.id, evt));
    },
  });
  if (!started.ok) return { ok: false, error: started.error };

  handle.id = started.id;
  trackPlacement(place, started.id);
  consoles.set(started.id, started);
  // The same thread, a new process: its history moves over rather than
  // coming back after a reload as a second thread, and the old handle goes.
  const prev = kept.id ? null : consoles.get(continues); // same id: consoles.set above already replaced the dead handle
  consoleLog.open(started.id, consoleMeta(agent, dir, { ...opts, ...(kept.label ? { label: kept.label } : {}) }, place, resolved.engine), continues);
  if (prev) {
    try {
      prev.stop();
    } catch {
      // Already gone, which is the expected case: a follow-up only ever
      // replaces a process that has exited.
    }
    consoles.delete(continues);
  }
  return { ok: true, id: started.id, agent, cwd: dir, engine: resolved.engine };
});

/** The shared body of `local:sendToAgent` and the control API's `spawn`
 *  (which sends the prompt this same way, right after starting). */
function sendToAgentCore(id, text) {
  const c = consoles.get(id);
  if (!c) return { ok: false, error: "no such console" };
  try {
    const first = !consoleLog.prompted(id);
    const sent = c.send(String(text || ""));
    // Kept for a reload and NOT sent live: the board already shows what it
    // typed, and no CLI's own stream carries it back as a prompt.
    if (sent && sent.ok !== false) {
      consoleLog.record(id, { type: "prompt", text: String(text || "") });
      // The commit message for a worktree's unfinished work, until a
      // generated title replaces it.
      const place = placementOf(id);
      if (first && place && !place.title) place.title = String(text || "").trim().split("\n")[0].slice(0, 72);
      if (first) void nameConsole(id, String(text || "")).catch(() => {});
    }
    return sent;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
bridge.handle("local:sendToAgent", (_e, { id, text }) => sendToAgentCore(id, text));

/**
 * A few generated words for a console's title, from its first prompt. Not
 * awaited by anything: the agent is already running, and on any failure the
 * board keeps titling it by the prompt's first sentence. See auto-title.js.
 */
async function nameConsole(id, text) {
  const detect = await loadDetect();
  const claude = detect ? detect.detectAgents().find((a) => a.id === "claude-code") : null;
  if (!claude || !claude.signedIn) return;
  const r = agentConsole.resolveAgent("claude");
  if (!r.ok) return;
  const inv =
    r.kind === "shim"
      ? agentConsole._internals.buildShimInvocation(r.file, autoTitle.ARGS)
      : { command: r.file, args: autoTitle.ARGS, options: {} };
  const title = await autoTitle.titleFor(text, inv);
  if (title && consoleLog.setTitle(id, title)) {
    const place = placementOf(id);
    if (place) place.title = title;
    toBoard("local:agentEvent", { type: "title", id, title });
  }
}

/** The shared body of `local:stopAgent` and the control API's `stop`. */
function stopAgentCore(id) {
  const c = consoles.get(id);
  if (!c) return { ok: false, error: "no such console" };
  try {
    c.stop();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  consoles.delete(id);
  return { ok: true };
}
bridge.handle("local:stopAgent", (_e, id) => stopAgentCore(id));

/** Every console a reloaded board should show again, with what it has said. */
bridge.handle("local:consoles", () => consoleLog.snapshot());

/** The board closed a thread; a reload should not bring it back. */
bridge.handle("local:integrateAgent", (_e, id) => integrateAgentById(String(id || "")));
bridge.handle("local:discardAgent", (_e, id) => discardAgentById(String(id || "")));

bridge.handle("local:forgetAgent", (_e, id) => {
  consoleLog.forget(String(id || ""));
  const place = placementOf(String(id || ""));
  if (place) void releasePlacement(place);
  const left = pendingIntegrations.get(String(id || ""));
  if (left) { pendingIntegrations.delete(left.id); void worktrees.release(left.worktree, left.title); }
  return { ok: true };
});

// An agent outliving the window that started it is a process nobody can see
// and nobody asked for. Called on quit and on window close — NOT on reload,
// which re-attaches instead; see releaseBoardResources.
function stopAllConsoles() {
  killChecks();
  for (const c of consoles.values()) {
    try {
      c.stop();
    } catch {
      // Already gone; nothing to do and nothing worth reporting at exit.
    }
  }
  consoles.clear();
  consoleLog.clear();
  // Best effort: a quit may not wait for it, and the next start prunes.
  for (const p of placements) void releasePlacement(p);
}

app.on("before-quit", stopAllConsoles);
app.on("before-quit", () => {
  // A stale discovery file pointing at a dead port is worse than none: a CLI
  // that trusts it hangs on a connection nobody answers rather than failing
  // fast with "zevet is not running".
  fs.rmSync(AGENT_API_FILE, { force: true });
  if (agentApiHandle) void agentApiHandle.close();
});
app.on("before-quit", () => { if (approvalHostInst) approvalHostInst.interrupt("their app closed"); });
app.on("before-quit", () => family.stop());
app.on("before-quit", () => clearInterval(ssoTimer));

/* ==========================================================================
 * PAYLOAD SWAP (bootstrap.js loaded this file from the current payload build)
 *
 * A staged payload replaces this process by relaunch, never while work is in
 * flight (payload-swap.js has the whole gate). app.exit skips before-quit, so
 * what before-quit tidies is done here by hand — and NOT appUpdater's
 * installOnQuit, which would start an installer under the relaunch.
 * ======================================================================== */
let lastInputAt = 0;
/** A window opening under a still cursor fires mouseEnter/mouseMove with nobody there (seen on the Windows runner the
 *  moment a relaunch opened the setup window), so pointer movement alone is not "the person is here". */
const NOT_INPUT = new Set(["mouseMove", "mouseEnter", "mouseLeave"]);
app.on("web-contents-created", (_e, wc) => {
  // before-input-event is keyboard; input-event (newer Electron) adds mouse buttons and wheel.
  for (const ev of ["before-input-event", "input-event"]) {
    wc.on(ev, (_e2, input) => {
      if (input && NOT_INPUT.has(input.type)) return;
      const now = Date.now();
      if (now - lastInputAt > 2 * 60 * 1000) bootShell.log(`input (${ev}: ${input && input.type}): a payload swap waits 2 minutes`);
      lastInputAt = now;
    });
  }
});
/** What every "is anyone using Zevet" decision reads: the payload swap and the idle installer share it, so agents,
 *  a chat turn and recent input gate both identically (payload-swap.js busyReason). */
const useGate = {
  activity: () => {
    const a = consoleLog.activity();
    const live = consoleLog.snapshot().consoles.filter((e) => e.running);
    const can = (e) => consolePersistence.AGENTS.has(e.agent) && e.sessionId;
    return { ...a, resumable: live.some(can), nonResumable: live.filter((e) => !can(e)).length };
  },
  /** Consoles mid-turn: the idle installer never restarts one, resumable or not. */
  working: () => consoleLog.snapshot().consoles.filter((e) => e.running && e.state === "working").length,
  chatBusy: () => Boolean(chatRun && chatRun.turn),
  lastInputAt: () => lastInputAt,
  windows: () => BrowserWindow.getAllWindows().length,
};
/** Resolves when any window has finished a load attempt (load OR fail: an unreachable hub is not the build's fault). */
const firstWindowLoaded = new Promise((resolve) => {
  if (process.argv.includes(WINDOWLESS_ARG)) resolve(); // no window on a macOS swap boot
  app.on("browser-window-created", (_e, w) => w.webContents.once("did-stop-loading", resolve));
});
function releaseForRelaunch() {
  persistResumableConsoles();
  // Stop the processes (their sessions are on disk) but keep every worktree:
  // the relaunch resumes them there.
  relaunching = true;
  for (const c of consoles.values()) {
    try {
      c.stop();
    } catch {
      // Already gone.
    }
  }
  stopChatRun();
  fs.rmSync(AGENT_API_FILE, { force: true });
  family.stop();
}
/** The agent API answers with the token the discovery file carries. */
function agentApiAnswers() {
  if (!agentApiHandle) return Promise.resolve(false);
  return new Promise((resolve) => {
    const req = require("node:http").get(`${agentApiHandle.url}/list`, { headers: { authorization: `Bearer ${agentApiHandle.token}` }, timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}
if (bootShell.payload) {
  try {
    if (settleChannel(bootShell.require("./payload-config.js").payloadRoot())) bootShell.log("payload channel was not stable: moved to stable (canary is retired)");
  } catch (err) { bootShell.log(`payload channel check failed: ${err && err.message || err}`); }
  observePayload(bootShell.payload, {
    log: (m) => bootShell.log(m),
    report: (extra) => Sentry.captureMessage("payload stuck: a newer build has not staged for 24h", { level: "warning", tags: { channel: String(extra.channel) }, extra }),
  });
  const swapper = createSwapper({
    payload: bootShell.payload,
    app,
    ...useGate,
    windowless: process.platform === "darwin",
    inputQuietMs: process.env.ZEVET_PAYLOAD_INPUT_QUIET_MS ? Number(process.env.ZEVET_PAYLOAD_INPUT_QUIET_MS) : undefined, // the packaged proof only
    release: releaseForRelaunch,
    onWaiting: (why) => { payloadWaiting = why; pushUpdateStatus(); },
    log: bootShell.log,
  });
  swapper.start();
  let quitApplied = false;
  app.on("will-quit", (e) => { // activate() is async: hold the quit until the staged build is current
    if (quitApplied || !swapper.pending()) return;
    e.preventDefault();
    swapper.applyOnQuit().catch((err) => bootShell.log(`payload apply on quit failed: ${err && err.message}`)).finally(() => { quitApplied = true; app.quit(); });
  });
  if (bootShell.trial) {
    void confirmWhenHealthy({ payload: bootShell.trial, loaded: firstWindowLoaded, apiAnswers: agentApiAnswers, app, log: bootShell.log });
  }
}

/* ==========================================================================
 * ZEVET CHAT — conversations with no repository behind them (desktop/chat.js)
 *
 * One claude process at a time, kept alive across the turns of the chat in
 * front: a follow-up is one more stdin line, not a cold start. Switching chats
 * ends it, and the next turn there resumes the session by id. Events go to the
 * board on `chat:event`, never `local:agentEvent`, so a chat is never drawn as
 * a console in Code's People pane.
 * ======================================================================== */
let chatRun = null; // { id, console, turn: { user, reply } | null, model, provider, want }

function stopChatRun() {
  if (!chatRun) return;
  try {
    chatRun.console.stop();
  } catch {
    // Already exited: the next turn resumes by id.
  }
  chatRun = null;
}
app.on("before-quit", stopChatRun);

async function masoraToken() {
  const cfg = masora.readConfig();
  if (!cfg.paired || !safeStorage.isEncryptionAvailable()) return null;
  const token = masora.loadToken((buf) => safeStorage.decryptString(buf));
  return token ? { cfg, token } : null;
}

/** C1 `zevet_chat`: queued only when the person turned Chat push on. */
async function pushChat(chat) {
  const cfg = masora.readConfig();
  if (!cfg.chat) return;
  masoraPush.appendOutbox([chats.toRecord(chat)], masoraPush.CHAT_OUTBOX_PATH);
  const auth = await masoraToken();
  if (!auth) return; // stays queued until a paired, unlocked cycle
  await masoraPush.flushOutbox({ baseUrl: auth.cfg.url, token: auth.token, file: masoraPush.CHAT_OUTBOX_PATH, team: await currentTeamName() });
}

function finishChatTurn(run, reply, error) {
  const turn = run.turn;
  run.turn = null;
  if (!turn || error || !reply) return;
  const chat = chats.addTurn(run.id, turn.user, reply, run.model, chatAuthor(), run.provider);
  if (!chat) return;
  toBoard("chat:event", { id: run.id, evt: { type: "saved", chat: { id: chat.id, title: chat.title, updated: chat.updated } } });
  void pushChat(chat).catch((err) => console.error(`zevet: chat push failed: ${err.message}`));
  // A few generated words replace the first-line title, same as a console —
  // but a slash command is plumbing, never a topic to title from.
  if (chat.messages.length === 2 && !chats.isSlashPrompt(turn.user)) void nameChat(chat.id, turn.user).catch(() => {});
}

async function nameChat(id, text) {
  const r = agentConsole.resolveAgent("claude");
  if (!r.ok) return;
  const inv =
    r.kind === "shim"
      ? agentConsole._internals.buildShimInvocation(r.file, autoTitle.ARGS)
      : { command: r.file, args: autoTitle.ARGS, options: {} };
  const title = await autoTitle.titleFor(text, inv);
  const renamed = title ? chats.rename(id, title) : null;
  if (renamed) toBoard("chat:event", { id, evt: { type: "saved", chat: renamed } });
}

/* Model providers (desktop/chat-claude.js documents the contract), keyed by the
   agent-console.js agent they drive. A chat records which one answered each
   message. */
const chatProviders = {
  claude: createClaudeCli({ startConsole: instrumentedStartConsole }),
  codex: createChatCli({ agent: "codex", id: "codex-cli", startConsole: instrumentedStartConsole }),
  opencode: createChatCli({ agent: "opencode", id: "opencode-cli", startConsole: instrumentedStartConsole }),
};
// "zevet:auto": the router, answering each turn with whichever of the above can.
chatProviders.zevet = createZevetChat({ inner: chatProviders, ladder: zevetLadder, isPrivate: repoPrivacy.isPrivate });
const DEFAULT_CHAT_AGENT = "claude";

async function spawnChat(chat, provider, opts = {}, folder = "") {
  let mcpConfig = null;
  const cfg = masora.readConfig();
  // --mcp-config is claude's flag; the others get Masora as the C2 brief.
  if (cfg.paired && (provider.agent === "claude" || provider.agent === "zevet")) {
    mcpConfig = path.join(app.getPath("temp"), `zevet-chat-mcp-${process.pid}.json`);
    fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: masora.mcpServerEntry(cfg.url) }), "utf8");
  }
  const run = { id: chat.id, console: null, turn: null, model: opts.model || chat.model || "", want: chatWant(provider, opts, folder), provider: provider.id };
  const opened = provider.open({
    chat,
    mcpConfig,
    model: opts.model,
    mode: opts.mode,
    effort: agentConsole.extrasFrom(opts).effort,
    folder,
    env: await credentialEnvFor(),
    onEvent: (evt) => {
      const p = evt && evt.type === "agent" ? evt.payload : null;
      if (p && p.type === "system" && p.subtype === "init" && p.model) run.model = String(p.model);
      // The router says which backend answered; each turn is saved as theirs.
      if (p && p.type === "zevet_route") {
        run.model = String(p.model || "");
        run.provider = `${p.agent}-cli`;
      }
      const text = p && run.turn ? provider.replyOf(p, evt) : "";
      if (text) run.turn.reply = run.turn.reply ? [run.turn.reply, text].join(String.fromCharCode(10, 10)) : text;
      if (p && run.turn && provider.endsTurn(p, evt)) finishChatTurn(run, run.turn.reply, p.is_error);
      // A routed turn that ended on codex or opencode says so itself (zevet-router.js).
      if (evt && evt.type === "turn_end" && run.turn) finishChatTurn(run, run.turn.reply, Boolean(evt.error) || !run.turn.reply);
      if (evt && evt.type === "exit") {
        // A one-shot CLI ends its turn by exiting: a reply and a clean exit is
        // an answer; anything else is a failed turn and is not saved.
        if (run.turn) finishChatTurn(run, run.turn.reply, Boolean(evt.error) || (evt.code !== 0 && !evt.stopped) || !run.turn.reply);
        if (chatRun === run) chatRun = null;
      }
      toBoard("chat:event", { id: run.id, evt });
    },
  });
  if (!opened.ok) return { ok: false, error: opened.error };
  run.console = opened;
  return { ok: true, run };
}

/** C2 for one chat turn: a separate step, skipped for any provider that may
 *  train on prompts. Fails open, like Code's. */
async function chatBrief(provider, text) {
  if (provider.trainsOnPrompts) return null;
  try {
    const auth = await masoraToken();
    if (!auth) return null;
    const r = await masora.briefFor({ baseUrl: auth.cfg.url, token: auth.token, prompt: text });
    return r ? r.brief : null;
  } catch (err) {
    console.error(`zevet: could not fetch the Masora brief: ${err.message}`);
    return null;
  }
}

bridge.handle("chat:list", (_e, arg) => chats.list(arg && arg.query));
bridge.handle("chat:get", (_e, id) => chats.read(String(id || "")));
/** Who a chat belongs to: the hub login this app signs in as. */
function chatAuthor() {
  const cfg = readConfig();
  return (cfg && typeof cfg.actor === "string" && cfg.actor) || os.userInfo().username;
}

/** A folder a chat may work in: one the person opened (the same guard Code's
 *  launches use), still on disk. "" detaches. */
function chatFolder(dir) {
  const d = String(dir || "");
  if (!d) return "";
  const known = knownRoot(d);
  return known && fs.existsSync(known) ? known : null;
}

/** What a live process was started for; a different answer respawns it. */
function chatWant(provider, opts, folder) {
  return [provider.agent, opts.model || "", opts.mode || "", opts.effort || "", folder].join("|");
}

bridge.handle("chat:create", (_e, arg) => chats.create(chatAuthor(), chatFolder(arg && arg.folder) || ""));
bridge.handle("chat:setFolder", (_e, arg) => {
  const folder = chatFolder(arg && arg.folder);
  if (folder === null) return null;
  const id = String((arg && arg.id) || "");
  if (chatRun && chatRun.id === id) stopChatRun(); // a new folder is a new posture
  return chats.setFolder(id, folder);
});
bridge.handle("chat:rename", (_e, arg) => chats.rename(arg && arg.id, arg && arg.title));
bridge.handle("chat:remove", (_e, id) => {
  if (chatRun && chatRun.id === id) stopChatRun();
  return chats.remove(String(id || ""));
});
bridge.handle("chat:stop", (_e, id) => {
  if (chatRun && chatRun.id === id) stopChatRun();
  return { ok: true };
});
bridge.handle("chat:send", async (_e, arg) => {
  await runtimeReady;
  const id = String((arg && arg.id) || "");
  const text = String((arg && arg.text) || "");
  const opts = arg && arg.opts ? arg.opts : {};
  const chat = chats.read(id);
  if (!chat) return { ok: false, error: "No such chat." };
  if (!text.trim()) return { ok: false, error: "Nothing to send." };
  if (chatRun && chatRun.id === id && chatRun.turn) return { ok: false, error: "Still answering." };
  if (chatRun && chatRun.id !== id) stopChatRun();
  const provider = chatProviders[opts.agent] || chatProviders[DEFAULT_CHAT_AGENT];
  // Set through chatFolder (an opened workspace); here it only has to still exist.
  const folder = chat.folder && fs.existsSync(chat.folder) ? chat.folder : "";
  if (chat.folder && !folder) return { ok: false, error: "Folder unavailable." };
  // A different agent, model, posture or folder needs new flags: respawn
  // (the session binding keeps the conversation). Compared against what was
  // ASKED, not run.model, which init overwrites with the resolved id.
  if (chatRun && chatRun.want !== chatWant(provider, opts, folder)) stopChatRun();
  // A slash command goes to claude bare: no Masora brief, no prior replay
  // (composeTurn drops both too; skipping the fetch here saves the round trip).
  const brief = chats.isSlashPrompt(text) ? null : await chatBrief(provider, text);

  if (!chatRun) {
    const s = await spawnChat(chat, provider, opts, folder);
    if (!s.ok) return s;
    chatRun = s.run;
  }
  chatRun.turn = { user: text, reply: "" };
  const sent = chatRun.console.send(text, { brief, prior: chat.messages });
  if (!sent || sent.ok === false) {
    chatRun.turn = null;
    stopChatRun();
    return sent || { ok: false, error: "Could not send." };
  }
  return { ok: true, brief: Boolean(brief) };
});

bridge.handle("zevet:masoraChatPush", (_e, arg) => masora.setChatPush(Boolean(arg && arg.on)));

// ---- lifecycle -------------------------------------------------------------

/* ==========================================================================
 * KEEPING THIS MACHINE CURRENT
 *
 * Andrew: "every machine should auto-update when you release a new version."
 *
 * The updater lives in app-update.js and is deliberately ignorant of Electron;
 * this block is the whole of the wiring. What it decides here:
 *
 *   - WHERE the feed is. The public download host, overridable with
 *     ZEVET_APP_FEED for testing against something that is not production.
 *   - WHERE the download lands: a directory of our own under userData, NOT the
 *     system temp directory. Windows disk cleanup empties temp, and an
 *     installer that vanishes between "ready" and the click is a bug report
 *     nobody can reproduce.
 *   - That the renderer is TOLD, and never asked. The board shows a row; the
 *     person clicks it or does not.
 * ======================================================================== */
/** update-rollback.js: an installer update that does not come up healthy runs the previous installer again and is
 *  never offered again. Windows only, and never on the payload path (bootstrap.js's 3-strike revert owns that). */
const updatesDir = path.join(app.getPath("userData"), "updates");
const rollback = createRollback({
  dir: updatesDir,
  running: app.getVersion(),
  spawn,
  installArgs: () => winInstallArgs(INSTALL_ARGS, process.execPath),
  spawnOptions: { windowsVerbatimArguments: true }, // winInstallArgs ends in an unquoted /D=
  verifyPublisher: async (_platform, file) => (await appUpdater._publisherProblem(file)) === null,
  verifiedOnDisk: (file, entry) => appUpdater._verified(file, entry),
  stopRuntime: () => persistResumableConsoles(), // quit() below is appUpdater's quitImpl: releaseForRelaunch
  quit: () => appUpdater.quitImpl(),
  log: (m) => { console.log(`[zevet-app-update] ${m}`); fileLog.info(`[zevet-app-update] ${m}`); },
  report: (err) => sentry.captureUpdateFailure(Sentry, { stage: "auto-update-rollback", error: err }),
});
// Whether the menu item currently reads "Restart to update" — tracked outside
// appUpdater.state so a download's percent ticks (also delivered through
// onStatus) don't rebuild the native menu dozens of times for nothing.
let menuOffersRestart = false;
// Reported once per ENTRY into "error", not on every status poll while it
// stays there — app-update.js re-announces the same state on a timer, and an
// event per poll would flood one real failure into hundreds of duplicates.
let lastUpdatePhase = null;
/** Settings' Version reads `current`. The updater's is the INSTALLER's version
 *  (what the feed is compared against); a payload swap moves the code without
 *  moving that, so shown raw it read 0.2.89 while 0.2.91 ran. */
function withRunningBuild(s) {
  if (!s || typeof s !== "object") return s;
  // `shell` in this file is Electron's; the payload client is bootShell's.
  let staged = null;
  try {
    staged = bootShell && bootShell.payload ? bootShell.payload.staged() : null;
  } catch (err) {
    bootShell.log(`payload staged() unreadable: ${err && err.message}`);
  }
  const waiting = payloadWaiting || installWaiting;
  return {
    ...s,
    running: APP_VERSION,
    ...(staged && staged.build !== APP_VERSION ? { next: { build: staged.build, when: "on restart" } } : {}),
    // Why a ready update has not applied yet (an agent mid-turn, a recent keystroke); absent when nothing holds it.
    ...(waiting ? { waiting } : {}),
  };
}
/** What is holding a staged payload / a downloaded installer back; the next gate poll retries and clears it. */
let payloadWaiting = null;
let installWaiting = null;
function pushUpdateStatus() {
  const s = withRunningBuild(appUpdater.state);
  toBoard("app:update", s);
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.webContents.send("app:update", s);
}
const appUpdater = new AppUpdater({
  rollback,
  currentVersion: app.getVersion(),
  feedUrl: process.env.ZEVET_APP_FEED || undefined,
  trustedKeys: loopbackProofKeys(process.env.ZEVET_APP_FEED),
  isPackaged: app.isPackaged,
  dir: updatesDir,
  // Only meaningful on darwin; see canSelfReplaceMac() in app-update.js.
  // /Applications/zevet.app from .../zevet.app/Contents/MacOS/zevet.
  bundlePath: process.platform === "darwin" ? path.dirname(path.dirname(path.dirname(app.getPath("exe")))) : undefined,
  // toBoard() only reaches boardWindow, and a person stuck on setup — no hub
  // configured yet, or not signed in — has no board window at all. Sent to
  // setupWindow too, so "0.2.57 is ready" shows up on the screen a first-run
  // person is actually looking at, not just one that may never open.
  onStatus: (raw) => {
    const s = withRunningBuild(raw);
    toBoard("app:update", s);
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.webContents.send("app:update", s);
    if (s.phase === "error" && lastUpdatePhase !== "error") {
      sentry.captureUpdateFailure(Sentry, { stage: "auto-update", error: s.error || "unknown auto-update error" });
    }
    lastUpdatePhase = s.phase;
    const canRestart = s.phase === "ready" && Boolean(s.canInstall);
    if (canRestart !== menuOffersRestart) {
      menuOffersRestart = canRestart;
      buildMenu();
    }
  },
  log: (m) => { console.log(`[zevet-app-update] ${m}`); fileLog.info(`[zevet-app-update] ${m}`); },
  openImpl: (f) => shell.openPath(f),
  quitImpl: () => {
    // ⚠️ NOT app.quit(): the board's beforeunload and the single-instance
    // lock both get in the way of a quit that has to be certain, and the
    // installer is already running by the time this fires.
    // Restart now is a relaunch like a payload swap: save the running Claude
    // consoles so the new build resumes them. Without this, every agent open
    // across an installer restart was gone (masora2-09, 2026-09-30: w125-fixa
    // and -fixb, "Zevet restarted and did not restore it").
    try {
      releaseForRelaunch();
    } catch (err) {
      bootShell.log(`consoles not saved before the installer restart: ${err && err.message}`);
    }
    app.exit(0);
  },
});

/** No modal, no click required: if a build is already downloaded and verified
 *  when the app is closed — window closed, Quit, or the OS logging the
 *  machine off — put it on silently so the NEXT launch is already current.
 *  `before-quit` does not fire for the Restart-now path above, which exits
 *  via app.exit(0); that is deliberate, see quitImpl's own comment. */
app.on("before-quit", () => {
  if (appUpdater.state.phase === "ready") appUpdater.installOnQuit();
});

/**
 * After an installer update: the new shell has to prove itself, like a trial payload does. A window that finished
 * loading and an agent API that answers within the boot budget confirms it (and makes it the next rollback
 * target); otherwise update-rollback.js takes one strike (a slow first boot is not a verdict) and then runs the
 * previous installer. Relaunch on the first strike so the second one comes now, not at the next launch.
 */
async function watchShellInstall() {
  if ((await rollback.afterBoot(null)) !== "none" || !rollback.state().pending) return; // a finished rollback, or an installer that never took
  const ok = await awaitHealthy({ loaded: firstWindowLoaded, apiAnswers: agentApiAnswers });
  const did = await rollback.afterBoot(ok ? { ok: true } : { ok: false, reason: "timeout" });
  if (did === "retry") {
    bootShell.log("installer update not healthy within 120s; relaunching for the second strike");
    releaseForRelaunch();
    app.relaunch();
    app.exit(1);
  }
}

/** Put a ready installer on when nobody is here (idle-install.js); the relaunch restores the consoles. */
function startIdleInstall() {
  const tick = createIdleInstaller({
    updater: appUpdater,
    gate: useGate,
    canSilent: () => appUpdater.steps.canOnQuit(appUpdater),
    systemIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    // No window focused: hidden, minimised, behind another app. idle-install.js times how long that has held.
    windowsAway: () => {
      const all = BrowserWindow.getAllWindows();
      return all.length > 0 && all.every((w) => w.isMinimized() || !w.isVisible() || !w.isFocused());
    },
    persist: persistResumableConsoles, // before the installer spawns; a non-resumable console never gets here (busyReason)
    onWaiting: (why) => { if (why !== installWaiting) { installWaiting = why; pushUpdateStatus(); } },
    log: (m) => bootShell.log(m),
  });
  const run = (o) => void tick(o).catch((err) => bootShell.log(`idle install: ${err && err.message}`));
  setInterval(run, IDLE_CHECK_MS).unref();
  // Waking from sleep: the person was not looking, and nothing ran meanwhile.
  powerMonitor.on("resume", () => run({ resumed: true }));
}

/** The on-focus recheck and the resume-from-sleep recheck share one gate so
 *  neither adds a request on top of the ordinary hourly timer if the other
 *  just ran one. */
const UPDATE_RECHECK_MIN_GAP_MS = 60 * 1000;
app.on("browser-window-focus", () => appUpdater.maybeCheck(UPDATE_RECHECK_MIN_GAP_MS));

/* ========================================================================
 * MASORA VOICE
 *
 * zevet does not transcribe. Masora Voice does, system-wide, into whatever
 * field has focus — which includes zevet's own composer. All the board asks
 * for is whether it is installed, and to start it so its flow bar is up.
 * The whole of why it cannot ask for more is in desktop/zevet-voice.js.
 * ==================================================================== */
/* EVERY agent session on this machine, not only the ones zevet started.
 * Read only; see desktop/agent-sessions.js. `cwd` scopes to one project and
 * is not a path the handler opens — it is matched as a string against the slug
 * and compared, so an unknown one simply matches nothing. */
bridge.handle("local:sessions", (_e, arg) => agentSessions.list(arg || {}));
bridge.handle("local:session", (_e, arg) =>
  agentSessions.read(
    (arg && arg.source) || "",
    (arg && arg.slug) || "",
    (arg && arg.id) || "",
    (arg && arg.child) || "",
  ),
);
/* The subagents one session spawned. Separate from `local:sessions` because
 * it opens a metadata file per child, and a session can have ninety of them —
 * paid for once, for the session actually opened. */
bridge.handle("local:sessionAgents", (_e, arg) =>
  agentSessions.children((arg && arg.slug) || "", (arg && arg.id) || ""),
);
bridge.handle("local:sessionLive", (_e, arg) =>
  agentSessions.live((arg && arg.source) || "", (arg && arg.id) || ""),
);

bridge.handle("local:defaultMode", (_e, mode) => rememberMode(String(mode || "")));

bridge.handle("local:voiceStatus", () => masoraVoice.status());
bridge.handle("local:voiceStart", () => masoraVoice.start());
bridge.handle("local:voiceMic", () => masoraVoice.mic());

bridge.handle("app:updateStatus", () => withRunningBuild(appUpdater.status()));
bridge.handle("app:updateCheck", () => appUpdater.check());
bridge.handle("app:updateInstall", () => appUpdater.install());
/** The board window answering the loopback API's `via: "board"` requests (desktop/board-ask.js). */
const boardAsk = createBoardAsk({
  send: (reqId, kind, payload) => {
    if (!boardWindow || boardWindow.isDestroyed()) return false;
    toBoard("local:boardRequest", { reqId, kind, ...payload });
    return true;
  },
});
// Agent notifications. The board decides whether one is wanted and passes the
// text; a click raises the window and hands the key back so it can focus the card.
bridge.handle("local:notify", (_e, { title, body, key }) => {
  if (!Notification.isSupported()) return { ok: false };
  const n = new Notification({ title: String(title || "Zevet").slice(0, 120), body: String(body || "").slice(0, 240), silent: false });
  n.on("click", () => {
    if (!boardWindow || boardWindow.isDestroyed()) return;
    if (boardWindow.isMinimized()) boardWindow.restore();
    boardWindow.show();
    boardWindow.focus();
    toBoard("local:notifyClick", String(key || ""));
  });
  n.show();
  return { ok: true };
});
bridge.handle("local:boardReply", (_e, { reqId, result }) => boardAsk.reply(reqId, result));

/* ── Steering a teammate's agent, and shared team context (D-058) ──────────
 *
 * desktop/agent-steer.js holds the logic; this is the wiring. The hub decides
 * the policy (on / ask / off) and says so on each steer it relays; this side
 * finds the agent among its OWN consoles, puts an approval card on the board
 * when asked to, and injects through the board's own Send (so the transcript
 * shows it like any other turn, prefixed "[from …]"), falling back to the
 * console directly when no board answers.
 */
const agentSteer = require("./agent-steer.js");
let steerAbort = null;
let activityTimer = null;
/** Approval cards waiting on the person, by steer id. */
const pendingSteers = new Map();

/* ── Teammates answering MY agents' permission prompts (D-086) ───────
 * desktop/agent-approval.js holds the rules (exact action, once, local wins).
 * This is the wiring: the hub arbitrates and relays sealed frames, and only
 * what this host accepts ever resolves a permit. Needs a signed-in session
 * and a team secret; the hub refuses to open a card when the team policy
 * `approve` is off (the default), and then the prompt is local-only. */
const agentApproval = require("./agent-approval.js");
let approvalHostInst = null;

function approvalCanShare() {
  const a = steerAuth(readConfig());
  return Boolean(a.hub && a.token && a.session && a.key && agentApproval.loadDocCrypto());
}

async function approvalCall(route, body) {
  const a = steerAuth(readConfig());
  if (!a.hub || !a.token) return { ok: false };
  const res = await fetch(`${a.hub}/api/approval/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zevet-token": a.token },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  const out = await res.json().catch(() => ({}));
  return { ...out, ok: res.ok && out.ok !== false };
}

function approvalHost() {
  if (!approvalHostInst) {
    const dc = () => agentApproval.loadDocCrypto();
    const key = () => steerAuth(readConfig()).key;
    approvalHostInst = agentApproval.createApprovalHost({
      sealCard: (meta, card) => agentApproval.sealCard(dc(), key(), meta, card),
      openAnswer: (frame, hash, session) => agentApproval.openAnswer(dc(), key(), { id: frame.id, session, hash }, frame.sealed),
      publish: (card) => approvalCall("open", card),
      report: (id, status, via, reason) => approvalCall("status", { id, status, via, reason }),
      advise: (a) => toBoard("local:steerEvent", { kind: "approval-advice", id: a.id, by: a.by, decision: a.decision }),
    });
  }
  return approvalHostInst;
}

/** What the board needs to render a card a teammate's agent is waiting on. */
function approvalCardForBoard(data) {
  const out = { kind: "approval", id: String(data.id || ""), status: String(data.status || ""), from: String(data.from || ""), repo: String(data.repo || ""), session: String(data.session || ""), by: String(data.by || ""), via: String(data.via || ""), decision: String(data.decision || ""), reason: String(data.reason || ""), expiresAt: Number(data.expiresAt) || 0, mine: Boolean(approvalHostInst && approvalHostInst.has(String(data.id || ""))) || approvalMine.has(String(data.id || "")) };
  if (out.mine) approvalMine.add(out.id);
  if (data.status === "open" && typeof data.sealed === "string") {
    try {
      const card = agentApproval.openCard(agentApproval.loadDocCrypto(), steerAuth(readConfig()).key, { id: out.id, session: out.session }, data.sealed);
      out.tool = String(card.tool || "").slice(0, 200);
      out.args = String(card.arguments || "").slice(0, 3000);
      out.agent = String(card.agent || "").slice(0, 40);
      // Held here, never sent to the board page: the nonce and hash ride in the
      // answer the main process seals itself.
      approvalCards.set(out.id, { hash: String(card.hash || ""), nonce: String(card.nonce || ""), session: out.session });
      while (approvalCards.size > 200) approvalCards.delete(approvalCards.keys().next().value);
    } catch {
      out.status = "unreadable";
    }
  }
  return out;
}
const approvalCards = new Map();
/** Cards for my own agents: answered in my own prompt, not through the hub. */
const approvalMine = new Set();

function steerAuth(cfg) {
  const c = cfg || {};
  const auth = authFor(c);
  const secret = loadSecretModule();
  let key = null;
  try {
    key = auth.secret && secret ? secret.deriveDocKey(auth.secret) : null;
  } catch {
    key = null;
  }
  return { hub: String(c.hub || "").replace(/\/+$/, ""), token: auth.token || "", session: Boolean(auth.session), key };
}

/** The console running the agent session a steer names — this app's only. */
function findSteerConsole(session) {
  const all = consoleLog.snapshot().consoles.filter((c) => c.sessionId && c.sessionId === session);
  const c = all.find((x) => x.running) || all[0];
  return c ? { id: c.id, agent: c.agent } : null;
}

async function injectSteer(consoleId, prompt) {
  const r = await askBoard("send", { id: consoleId, prompt });
  if (r && !r.notFound) return r;
  return sendToAgentCore(consoleId, prompt);
}

const steerInbox = agentSteer.createSteerInbox({
  open: (msg) => agentSteer._internals.open(agentSteer.loadDocCrypto(), steerAuth(readConfig()).key, msg, msg.sealed),
  findConsole: findSteerConsole,
  askOwner: (req) =>
    new Promise((resolve) => {
      if (!boardWindow || boardWindow.isDestroyed()) return resolve(null);
      pendingSteers.set(req.id, resolve);
      toBoard("local:steerEvent", { kind: "ask", id: req.id, from: req.from, text: req.text, agent: req.agent, repo: req.repo, consoleId: req.consoleId, payer: payerOf(String(req.agent || "")).label });
    }),
  inject: injectSteer,
  report: reportSteerStatus,
});

/** Tell the hub what happened to a steer or a spawn sent to this person. */
async function reportSteerStatus(id, status, reason, extra) {
  const a = steerAuth(readConfig());
  if (!a.hub || !a.token) return;
  await fetch(`${a.hub}/api/steer/status`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zevet-token": a.token },
    body: JSON.stringify({ id, status, reason, ...(extra && typeof extra.session === "string" ? { session: extra.session } : {}) }),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
}

/* ── A teammate starting an agent HERE (D-060, desktop/agent-spawn.js) ──────
 * The repo is resolved against this app's own open workspaces by folder
 * name; the mode is this person's own default when that is a safe one (plan
 * or ask), otherwise ask — never what the sender wanted; the engine is this
 * machine's default login. Started directly, not through the board page: the
 * page is served by the hub, and nothing it says may change how this runs. */
const agentSpawn = require("./agent-spawn.js");
/** Consoles a teammate started here; the cap counts the ones still running. */
const remoteStarted = new Set();

function runningRemote() {
  for (const id of remoteStarted) {
    const c = consoleLog.get(id);
    if (!c || !c.running) remoteStarted.delete(id);
  }
  return remoteStarted.size;
}

/** Start a console, send it its first prompt, show it on the board. After the prompt, so the board's re-attach replays it. */
async function startAndBrief({ agent, dir, label, prompt, mode, model, onStarted }) {
  const r = await startAgentCore({ agent, cwd: dir, opts: { model, mode, label } });
  if (!r.ok) return r;
  if (onStarted) onStarted(r.id);
  const sent = sendToAgentCore(r.id, prompt);
  announceConsole(r.id);
  if (!sent || sent.ok === false) return { ok: false, error: (sent && sent.error) || "the prompt could not be sent" };
  return { ok: true, id: r.id };
}

async function startRemoteSpawn({ agent, dir, model, prompt, from }) {
  const who = String(from || "a teammate").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 40);
  return startAndBrief({ agent, dir, model, prompt, label: `started by ${who}`, mode: agentSpawn.safeMode(storedMode()), onStarted: (id) => remoteStarted.add(id) });
}

const spawnInbox = agentSpawn.createSpawnInbox({
  open: (msg) => agentSpawn._internals.open(agentSteer.loadDocCrypto(), steerAuth(readConfig()).key, msg, msg.sealed),
  resolveRepo: (name) => agentSpawn.resolveRepo(name, readWorkspaces()),
  runningRemote,
  askOwner: (req) =>
    new Promise((resolve) => {
      if (!boardWindow || boardWindow.isDestroyed()) return resolve(null);
      pendingSteers.set(req.id, resolve);
      toBoard("local:steerEvent", { kind: "spawn-ask", id: req.id, from: req.from, agent: req.agent, repo: req.repo, dir: req.dir, model: req.model, text: req.prompt, payer: payerOf(String(req.agent || ""), { model: String(req.model || "") }).label });
    }),
  start: (req) => startRemoteSpawn(req),
  sessionOf: (id) => {
    const c = consoleLog.get(id);
    return (c && c.sessionId) || "";
  },
  outcome: (id) => agentSpawn.watchOutcome((c) => consoleLog.get(c), id),
  report: reportSteerStatus,
});

/* ── Taking over a teammate's running turn (desktop/agent-takeover.js) ──────
 * OWNER side: approve (policy ask), capture transcript + git diff summary,
 * seal the baton, hand it to the hub, then stop this turn. TAKER side: the
 * baton opens here, the repo resolves against THIS app's workspaces by folder
 * name, and a new turn starts on the engine this person asked for, under their
 * own login and their own safe mode (plan or ask), never the owner's. */
const agentTakeover = require("./agent-takeover.js");
/** Take-overs I asked for, id -> the engine I chose: the baton cannot pick one. */
const takeoversAsked = new Map();

function takeoverPost(route, payload) {
  const a = steerAuth(readConfig());
  if (!a.hub || !a.token) return Promise.resolve({ ok: false, error: "not signed in" });
  return fetch(`${a.hub}/api/takeover${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zevet-token": a.token },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  }).then(async (res) => {
    let out = {};
    try {
      out = await res.json();
    } catch {
      out = {};
    }
    return res.ok ? { ok: true, ...out } : { ok: false, ...out, error: out.error || `the team server answered ${res.status}` };
  });
}

const takeoverInbox = agentTakeover.createTakeoverInbox({
  open: (msg) => agentTakeover._internals.openJson(agentSteer.loadDocCrypto(), steerAuth(readConfig()).key, agentTakeover._internals.requestAad(msg), msg.sealed),
  findConsole: (session) => {
    const c = findSteerConsole(session);
    const full = c ? consoleLog.get(c.id) : null;
    return c && full ? { ...c, repo: path.basename(String(full.root || "")) } : null;
  },
  askOwner: (req) =>
    new Promise((resolve) => {
      if (!boardWindow || boardWindow.isDestroyed()) return resolve(null);
      pendingSteers.set(req.id, resolve);
      toBoard("local:steerEvent", { kind: "takeover-ask", id: req.id, from: req.from, agent: req.agent, repo: req.repo, consoleId: req.consoleId, payer: req.payer });
    }),
  capture: async (consoleId) => {
    const c = consoleLog.get(consoleId);
    if (!c) throw new Error("the session is gone");
    const place = placementOf(consoleId);
    const where = diffWhere(c, place);
    return { events: c.events, turns: c.turns, ...(await agentTakeover.diffSummary(where)) };
  },
  sealBaton: (msg, baton) => agentTakeover._internals.sealJson(agentSteer.loadDocCrypto(), steerAuth(readConfig()).key, agentTakeover._internals.batonAad(msg), baton),
  sendBaton: (id, sealed) => takeoverPost("/baton", { id, sealed }),
  halt: (consoleId) => stopAgentCore(consoleId),
  report: reportSteerStatus,
});

function diffWhere(c, place) {
  return (place && place.cwd) || c.worktree || c.root || "";
}

const batonInbox = agentTakeover.createBatonInbox({
  open: (msg) => agentTakeover._internals.openJson(agentSteer.loadDocCrypto(), steerAuth(readConfig()).key, agentTakeover._internals.batonAad(msg), msg.sealed),
  requested: (id) => takeoversAsked.get(id) || "",
  resolveRepo: (name) => agentTakeover.resolveRepo(name, readWorkspaces()),
  start: ({ agent, dir, from, prompt }) => {
    const who = String(from || "a teammate").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 40);
    return startAndBrief({ agent, dir, prompt, label: `taken over from ${who}`, mode: agentTakeover.safeMode(storedMode()) });
  },
  sessionOf: (id) => {
    const c = consoleLog.get(id);
    return (c && c.sessionId) || "";
  },
  report: (id, status, reason, extra) => takeoverPost("/status", { id, status, reason, ...(extra && typeof extra.session === "string" ? { session: extra.session } : {}) }),
});

function startSteerChannel(cfg) {
  stopSteerChannel();
  const a = steerAuth(cfg);
  // The steer channel and the board both refuse a shared token: a person has
  // to be signed in to be steered, or to steer.
  if (!a.hub || !a.token || !a.session) return;
  const ctl = new AbortController();
  steerAbort = ctl;
  void agentSteer.streamSteers({
    hub: a.hub,
    token: a.token,
    signal: ctl.signal,
    onFrame: (name, data) => {
      if (name === "approval" && data && typeof data.id === "string") {
        toBoard("local:steerEvent", approvalCardForBoard(data));
      } else if (name === "approval-answer" && data && typeof data.id === "string") {
        approvalHost().remote(data);
      } else if (name === "steer") {
        void steerInbox.handle(data).then((status) => {
          const id = data && typeof data.id === "string" ? data.id : "";
          pendingSteers.delete(id);
          if (status === "accepted" || status === "declined") toBoard("local:steerEvent", { kind: "done", id, from: String((data && data.from) || ""), status });
        });
      } else if (name === "spawn") {
        void spawnInbox.handle(data).then((status) => {
          const id = data && typeof data.id === "string" ? data.id : "";
          pendingSteers.delete(id);
          if (status !== "replay" && status !== "ignored") toBoard("local:steerEvent", { kind: "done", id, from: String((data && data.from) || ""), status });
        });
      } else if (name === "takeover") {
        void takeoverInbox.handle(data).then((status) => {
          const id = data && typeof data.id === "string" ? data.id : "";
          pendingSteers.delete(id);
          if (status !== "replay" && status !== "ignored") toBoard("local:steerEvent", { kind: "done", id, from: String((data && data.from) || ""), status });
        });
      } else if (name === "baton") {
        void batonInbox.handle(data).then((status) => {
          if (status === "started" || status === "start-failed") takeoversAsked.delete(String((data && data.id) || ""));
        });
      } else if (name === "hello" || name === "payer" || name === "payer-release") {
        if (payerLib.applyPayerFrame(teamPayers, name, data, { docCrypto: agentSteer.loadDocCrypto(), key: steerAuth(readConfig()).key, isMine: (session) => myPayers.has(session) })) pushClaims();
        if (name !== "hello") return;
        // hello also resets claims, below.
      }
      if (name === "hello" || name === "claim" || name === "claim-release") {
        const mine = new Set(myClaims.claims().map((e) => e.session));
        const changed = claimsLib.applyFrame(teamClaims, name, data, {
          docCrypto: agentSteer.loadDocCrypto(),
          key: steerAuth(readConfig()).key,
          isMine: (session) => mine.has(session),
        });
        if (changed) pushClaims();
      } else if (name === "steer-status" && data && typeof data.id === "string") {
        toBoard("local:steerEvent", { kind: "status", id: data.id, of: data.kind === "spawn" ? "spawn" : data.kind === "takeover" ? "takeover" : "steer", to: String(data.to || ""), status: String(data.status || ""), reason: String(data.reason || ""), session: String(data.session || "") });
      }
    },
  });
  void refreshActivity(cfg);
  activityTimer = setInterval(() => void refreshActivity(readConfig() || cfg), 60 * 1000);
}

function stopSteerChannel() {
  if (approvalHostInst) approvalHostInst.interrupt("their app lost its connection");
  if (steerAbort) steerAbort.abort();
  steerAbort = null;
  if (activityTimer) clearInterval(activityTimer);
  activityTimer = null;
  for (const resolve of pendingSteers.values()) resolve(null);
  pendingSteers.clear();
  teamClaims.clear();
  pushClaims();
}

const sessionShare = require("./session-share.js");

bridge.handle("local:sessionInvite", async (_e, arg) => {
  const a = steerAuth(readConfig());
  if (!a.session) return { ok: false, error: "Sign in to your team to invite someone." };
  return sessionShare.sendInvite({ hub: a.hub, token: a.token, key: a.key, session: String((arg && arg.session) || ""), mode: String((arg && arg.mode) || "watch"), repo: String((arg && arg.repo) || "") });
});

bridge.handle("local:sessionJoin", async (_e, arg) => {
  const a = steerAuth(readConfig());
  if (!a.session) return { ok: false, error: "Sign in to your team to join a session." };
  return sessionShare.joinInvite({
    hub: a.hub,
    token: a.token,
    key: a.key,
    id: String((arg && arg.id) || "").trim(),
    mode: arg && arg.mode ? String(arg.mode) : "",
    resolveRepo: (name) => {
      const w = agentSpawn.resolveRepo(name, readWorkspaces());
      return w && w.dir ? w.dir : null;
    },
  });
});

bridge.handle("local:steerSend", async (_e, arg) => {
  const a = steerAuth(readConfig());
  if (!a.session) return { ok: false, error: "Sign in to your team to steer a teammate's agent." };
  return agentSteer.sendSteer({
    hub: a.hub,
    token: a.token,
    key: a.key,
    to: String((arg && arg.to) || ""),
    session: String((arg && arg.session) || ""),
    repo: String((arg && arg.repo) || ""),
    text: String((arg && arg.text) || ""),
  });
});

bridge.handle("local:spawnSend", async (_e, arg) => {
  const a = steerAuth(readConfig());
  if (!a.session) return { ok: false, error: "Sign in to your team to start an agent for a teammate." };
  // Exactly these five fields cross: the renderer cannot add a mode, a path
  // or a flag, because nothing else is read.
  return agentSpawn.sendSpawn({
    hub: a.hub,
    token: a.token,
    key: a.key,
    to: String((arg && arg.to) || ""),
    repo: String((arg && arg.repo) || ""),
    agent: String((arg && arg.agent) || ""),
    model: String((arg && arg.model) || ""),
    text: String((arg && arg.text) || ""),
  });
});

bridge.handle("local:takeoverSend", async (_e, arg) => {
  const a = steerAuth(readConfig());
  if (!a.session) return { ok: false, error: "Sign in to your team to take over a teammate's agent." };
  const agent = String((arg && arg.agent) || "");
  const payer = payerOf(agent).label;
  const r = await agentTakeover.sendTakeover({
    hub: a.hub,
    token: a.token,
    key: a.key,
    to: String((arg && arg.to) || ""),
    session: String((arg && arg.session) || ""),
    repo: String((arg && arg.repo) || ""),
    agent,
    payer,
  });
  if (r.ok && r.id) {
    takeoversAsked.set(r.id, agent);
    while (takeoversAsked.size > 50) takeoversAsked.delete(takeoversAsked.keys().next().value);
  }
  return { ...r, payer };
});

/** An Editor answering a teammate's agent's permission prompt. The answer is
 *  sealed here with the nonce and hash the card carried; the hub only
 *  arbitrates, and the teammate's app checks them before acting. */
bridge.handle("local:approvalAnswer", async (_e, arg) => {
  const id = arg && typeof arg.id === "string" ? arg.id : "";
  const card = approvalCards.get(id);
  if (!card) return { ok: false, error: "that prompt is no longer here" };
  const a = steerAuth(readConfig());
  if (!a.session || !a.key) return { ok: false, error: "Sign in to your team to answer a teammate's prompt." };
  const decision = arg && arg.allow === true ? "allow" : "deny";
  let sealed;
  try {
    sealed = agentApproval.sealAnswer(agentApproval.loadDocCrypto(), a.key, { id, session: card.session, hash: card.hash }, { nonce: card.nonce, hash: card.hash, decision });
  } catch (err) {
    return { ok: false, error: `Could not seal the answer: ${err.message}` };
  }
  try {
    const r = await approvalCall("answer", { id, decision, sealed });
    return r.ok ? { ok: true, status: String(r.status || "") } : { ok: false, status: String(r.status || ""), by: String(r.by || ""), error: String(r.error || "not accepted") };
  } catch (err) {
    return { ok: false, error: `Could not reach your team: ${err.message}` };
  }
});

/** The person's answer to one steer (or spawn) approval card. */
bridge.handle("local:steerAnswer", (_e, arg) => {
  const id = arg && typeof arg.id === "string" ? arg.id : "";
  const resolve = pendingSteers.get(id);
  if (!resolve) return { ok: false, error: "no such steer" };
  pendingSteers.delete(id);
  resolve(Boolean(arg && arg.approve === true));
  return { ok: true };
});

/* Shared context: the team activity block (client/activity.mjs), refreshed
 * every minute while signed in, written to ~/.zevet/activity.md and appended
 * to a desktop-launched claude's system prompt at every process start. claude
 * keeps one process across turns and its system prompt is fixed for that
 * process, so the block also points at the file, which stays current. codex
 * and opencode have no system-prompt flag here; they get the file only. */
let activityModule;
function loadActivity() {
  if (activityModule !== undefined) return activityModule;
  activityModule = null;
  const target = runtime.clientFile("activity.mjs", { clientDir: CLIENT_DIR });
  try {
    if (target) activityModule = require(target);
  } catch (err) {
    console.error(`zevet: could not load activity.mjs (${err.message})`);
  }
  return activityModule;
}

let activityText = "";
async function refreshActivity(cfg) {
  const act = loadActivity();
  const a = steerAuth(cfg);
  if (!act || !a.session || !a.hub) return;
  try {
    const headers = { "x-zevet-token": a.token };
    const [state, who] = await Promise.all(
      ["/api/state", "/auth/whoami"].map((p) => fetch(`${a.hub}${p}`, { headers, redirect: "error", signal: AbortSignal.timeout(10000) }).then((r) => (r.ok ? r.json() : null))),
    );
    if (!state) return;
    const me = who && who.me ? [who.me.name, who.me.login, ...(who.me.aliases || []), ...(who.me.identities || []).map((i) => i.login)] : [];
    myTeamNames = [who && who.login, ...me].filter(Boolean);
    // Step claims ride a room per repo; join the ones teammates are working in so their owners show.
    for (const ag of Array.isArray(state.agents) ? state.agents : []) if (ag && ag.repo) try { ensureDocSync().sync?.join(stepClaims.room(ag.repo)); } catch { /* local only */ }
    activityText = act.activityBlock(state, { me: [cfg && cfg.actor, who && who.login, ...me].filter(Boolean), comments: act.readComments(HOME) });
    act.writeActivityFile(HOME, activityText);
  } catch (err) {
    console.error(`zevet: team activity not refreshed (${err.message})`);
  }
}

function withActivity(systemPrompt) {
  if (!activityText) return systemPrompt;
  // A .cmd-shim claude refuses any argument with a newline or a quote in it
  // (agent-console.js § CMD_METACHARACTERS), and this block has both: adding
  // it there would stop every launch. Such a machine gets the file only.
  const r = agentConsole.resolveAgent("claude");
  if (!r.ok || r.kind === "shim") return systemPrompt;
  return [systemPrompt, `${activityText}\n(This is a snapshot from when you started; ~/.zevet/activity.md is kept current.)`].filter(Boolean).join("\n\n");
}

bridge.assertComplete();

/**
 * The local control API (desktop/agent-api.js) -- started eagerly on app
 * ready, not lazily on first use like ask-server.js's permit gate, because
 * its whole point is a terminal caller who is not otherwise touching the
 * app at all. The discovery file is user-only (mode 0600, same discipline
 * masora.js's own token file uses) since holding it is what makes a caller
 * trusted -- see `trustedDir` above for what that buys `spawn`.
 */
let agentApiHandle = null;
async function askBoard(kind, payload) {
  if (kind !== "start") return boardAsk.ask(kind, payload);
  const dir = trustedDir(payload.cwd);
  if (!dir) return { ok: false, error: "cwd does not exist" };
  apiRoots.add(dir);
  try {
    const r = await boardAsk.ask(kind, { ...payload, cwd: dir });
    return r && r.ok ? { ...r, cwd: dir } : r;
  } finally {
    apiRoots.delete(dir);
  }
}
async function startAgentApi() {
  agentApiHandle = await agentApi.start({
    askBoard,
    startAgentCore: async (args) => {
      const r = await startAgentCore(args);
      if (r.ok) announceConsole(r.id);
      return r;
    },
    sendToAgentCore,
    stopAgentCore,
    setOnce: (id) => consoleLog.setOnce(id),
    getConsole: (id) => consoleLog.get(id),
    listConsoles: () => consoleLog.snapshot().consoles,
    isRelaunching: () => relaunching,
  });
  // HOME is otherwise created by whichever writer runs first; on a fresh profile that is not this one.
  fs.mkdirSync(HOME, { recursive: true });
  atomicWriteJson(AGENT_API_FILE, { url: agentApiHandle.url, token: agentApiHandle.token, pid: process.pid }, { mode: 0o600 });
}

app.whenReady().then(async () => {
  buildMenu();
  // The window first: its renderer boots in another process while the starters below run, so everything
  // after this line is off the path to the first board paint.
  session.defaultSession.webRequest.onHeadersReceived({ urls: FRAME_URLS, types: ["subFrame"] }, (d, cb) => cb({ responseHeaders: frameable(d.responseHeaders) }));
  const cfg = readConfig();
  // A windowless payload swap relaunches with this flag (macOS dock-only app): no window until the dock is clicked.
  if (process.platform === "darwin" && process.argv.includes(WINDOWLESS_ARG)) {
    // nothing: the activate handler opens a window on demand
  } else if (cfg) openBoard(cfg);
  else openSetup(null);
  void startAgentApi();
  // No console outlives the app, so neither does a worktree made for one —
  // except those a payload swap is handing back, restored first.
  void restoreResumableConsoles().finally(() =>
    worktrees.prune(new Set([...placements].filter((p) => p.worktree).map((p) => path.resolve(p.worktree.dir)))),
  );
  startScheduler();
  startMasoraPush();
  startMasoraRuns();
  startReportingHealth();
  // After the window, never before it: an update check that delayed the
  // board would be a worse app for a feature nobody asked to wait on.
  // An unpackaged run (`electron .`, the drive harness) or ZEVET_NO_AUTOUPDATE=1 never self-updates: an installer
  // it ran would land in the working tree (2026-10-08). ZEVET_APP_FEED is the loopback-proof opt-in.
  if (process.env.ZEVET_APP_FEED || (app.isPackaged && process.env.ZEVET_NO_AUTOUPDATE !== "1")) appUpdater.start();
  family.start();
  void sso.sync();
  ssoTimer = setInterval(() => void sso.sync(), SSO_POLL_MS);
  if (typeof ssoTimer.unref === "function") ssoTimer.unref();
  watchShellInstall();
  startIdleInstall();
  // Only reliable after 'ready'; see the module's own docs.
  powerMonitor.on("resume", () => appUpdater.maybeCheck(UPDATE_RECHECK_MIN_GAP_MS));
  // Same reasoning as the updater above: never delay the board for this.
  // The probe is quick (2s, bounded), but "quick" is still slower than a
  // window that could have opened already — this runs alongside it.
  // The IPC guard reads config.json on every call, so the moment the new hub is
  // written a board still on the old origin loses its whole bridge (0.2.103:
  // update checks, sessions, everything refused until a restart). Move it too;
  // openBoard's reconnect closure reads cfg.hub, so it follows.
  if (cfg) void migrateHubDomain(cfg).then((m) => {
    if (m === cfg) return;
    cfg.hub = m.hub;
    if (!boardWindow || boardWindow.isDestroyed()) return;
    let at;
    try { at = new URL(boardWindow.webContents.getURL()); } catch { return; }
    if (at.protocol === "https:" || at.protocol === "http:") boardWindow.loadURL(`${m.hub.replace(/\/+$/, "")}/${at.search}`);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const c = readConfig();
      if (c) openBoard(c);
      else openSetup(null);
    }
  });
});

app.on("window-all-closed", () => {
  stopCollisionWatch();
  stopSteerChannel();
  if (process.platform !== "darwin") app.quit();
});

/**
 * A second instance should raise the first, not open a second board.
 *
 * ⚠️ WITH ONE ESCAPE HATCH, AND IT EXISTS FOR A REASON THE PRODUCT NEEDS.
 * zevet is now a multiplayer editor, and the only way to watch two participants
 * edit one document is to run two of it. On one machine the lock makes that
 * impossible: the second instance quits with status 0 and no message, which
 * looks exactly like "the app is broken" and cost an hour the first time.
 *
 * `ZEVET_ALLOW_MULTI=1` skips the lock. It is NOT a development-only flag in
 * any enforceable sense — it is read in the shipped binary — so the danger is
 * worth stating: two instances sharing one `ZEVET_HOME` will both write
 * `config.json` and `workspaces.json` and the loser's edits vanish. Set
 * `ZEVET_HOME` to something separate whenever you set this, which is what the
 * two-instance test rig does.
 *
 * Rejected: detecting a dev run (unpackaged `app.isPackaged === false`) and
 * allowing multiple automatically. That would silently change behaviour between
 * a checkout and an installer, so the thing you tested is not the thing you
 * shipped — which is the specific failure this codebase's Windows/macOS section
 * exists to complain about.
 */
// The lock itself is taken in bootstrap.js, with the ZEVET_ALLOW_MULTI escape hatch described above; this is
// only what the first instance does when a second launch is attempted.
bootShell.onSecondInstance = () => {
  const w = boardWindow || setupWindow;
  if (w && !w.isDestroyed()) {
    if (w.isMinimized()) w.restore();
    w.focus();
  }
};
