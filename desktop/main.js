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
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu, safeStorage } = require("electron");
const localFs = require("./local-fs.js");
const agentConsole = require("./agent-console.js");
const repoStats = require("./repo-stats.js");
const schedule = require("./schedule.js");
const statusSources = require("./status-sources.js");
const crypto = require("node:crypto");
const indexCapability = require("./index-capability.js");
const embedder = require("./embedder.js");
const codeIndex = require("./code-index.js");
const { FileWatch } = require("./file-watch.js");
const { AppUpdater } = require("./app-update.js");
const runtime = require("./runtime.js");
const askServer = require("./ask-server.js");
const { GithubSignIn } = require("./github-signin.js");
const { GoogleSignIn } = require("./google-signin.js");
const masoraVoice = require("./zevet-voice.js");
const agentSessions = require("./agent-sessions.js");
const agentCatalogs = require("./agent-catalogs.js");
const { createConsoleLog } = require("./console-log.js");
const { createAgentWorktrees } = require("./agent-worktree.js");
const autoTitle = require("./auto-title.js");
const masora = require("./masora.js");
const masoraPush = require("./masora-push.js");
const masoraConnect = require("./masora-connect.js");
const chats = require("./chat.js");
const { createClaudeCli } = require("./chat-claude.js");
// doc-sync.js is NOT required at the top. It resolves and loads the crypto
// modules at construction time, and on a checkout where those are missing that
// is a throw — at the top of this file that throw happens before any window
// exists and the app simply never starts, with the message going to a console
// nobody is looking at. Required lazily in ensureDocSync() instead, where the
// failure becomes an error string a person can read in the editor.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const os = require("node:os");

// Node, npm agent shims and the tools those agents launch need the same PATH
// whether zevet was opened from Finder or from Terminal.
const runtimeReady = runtime.preparePath();

const HOME = process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet");
const CONFIG = path.join(HOME, "config.json");

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

/** The icon, for the dev run and for Linux; a packaged .exe carries its own. */
const ICON = path.join(__dirname, "build", "icon.png");
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

function writeConfig(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  try {
    // Best effort: the token is a shared secret sitting in a home directory.
    fs.chmodSync(CONFIG, 0o600);
  } catch {
    // Windows uses ACLs; there is nothing to do here and nothing to report.
  }
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
  boardWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 720,
    minHeight: 420,
    backgroundColor: PAPER, // no white flash before the page paints
    title: "zevet",
    ...iconOption,
    // macOS gets hiddenInset, which it has always had: the traffic lights stay
    // where a Mac user expects them and the board's own title bar absorbs the
    // inset. Windows and Linux get a hidden bar plus an overlay we colour.
    titleBarStyle: "hidden",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" }
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
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

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
        shell.openExternal(target);
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
  const auth = authFor(cfg);
  if (auth.error) {
    boardWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(credentialPage(auth.error)));
  } else {
    boardWindow.loadURL(`${cfg.hub.replace(/\/+$/, "")}/?token=${encodeURIComponent(auth.token)}`);
  }

  boardWindow.webContents.on("did-fail-load", (_e, code, desc) => {
    if (code === -3) return; // aborted by a normal navigation
    boardWindow.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(unreachablePage(cfg.hub, `${desc} (${code})`)),
    );
  });

  // Anything that wants a new window is a link to the outside world.
  boardWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) shell.openExternal(target);
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

function unreachablePage(hub, why) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Can't reach the hub</title>${statusPageStyle()}
  <main>${STATUS_BRAND}<h1>Can't reach the hub.</h1>
  <p>Tried <code>${hub.replace(/[<&]/g, "")}</code> and got: ${String(why).replace(/[<&]/g, "")}</p>
  <p>Check your connection and hub address, then reload.
  Change the address in <b>zevet &rsaquo; Change hub…</b>.</p></main></html>`;
}

/**
 * The page shown when this machine cannot prove who it is.
 *
 * Separate from `unreachablePage` on purpose: that one says "the hub may be
 * off, nothing is wrong with your install", which is a comforting and, here,
 * false thing to tell somebody whose config holds a mistyped secret. The
 * remedies are opposite — wait versus re-run setup — so the pages are too.
 *
 * `why` is secret.mjs's own wording ("master secret must be hex", and so on),
 * which names the fault without ever containing the value.
 */
function credentialPage(why) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Can't sign in</title>${statusPageStyle()}
  <main>${STATUS_BRAND}<h1>This machine can't sign in.</h1>
  <p>${String(why).replace(/[<&]/g, "")}</p>
  <p>Open <b>zevet &rsaquo; Change hub…</b> and sign in again, or check the team's secret.</p></main></html>`;
}

function openSetup(existing) {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 620,
    height: 700,
    resizable: false,
    backgroundColor: PAPER,
    title: "Set up zevet",
    ...iconOption,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  setupWindow.loadFile(path.join(__dirname, "setup.html"), {
    query: existing ? { hub: existing.hub, actor: existing.actor || "" } : {},
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
      if (!res.ok || !res.body) throw new Error(`hub answered ${res.status}`);

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
          label: "Change hub…",
          click: () => openSetup(readConfig()),
        },
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
ipcMain.handle("zevet:config", () => {
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
ipcMain.handle("zevet:test", async (_e, { hub, token }) => {
  const auth = authFor({ secret: String(token || "") });
  if (auth.error) return { ok: false, why: `That secret is not usable: ${auth.error}` };
  // An empty field resolves cleanly to an empty token — `resolveAuth` has
  // nothing to complain about — and would go to the hub as a 401 reported as
  // "it rejected that token", which is true and points at the wrong end.
  if (!auth.token) return { ok: false, why: "There is no secret to check yet." };
  try {
    const base = String(hub).replace(/\/+$/, "");
    const res = await fetch(`${base}/dist/manifest.json`, {
      headers: { "x-zevet-token": auth.token },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) return { ok: false, why: "The hub is there, but it rejected that token." };
    if (!res.ok) return { ok: false, why: `The hub answered ${res.status}.` };
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
ipcMain.handle("zevet:save", (_e, cfg) => {
  const hub = String(cfg.hub).replace(/\/+$/, "");
  const actor = String(cfg.actor);
  // `token` is what setup.html still calls the field; what it holds is now the
  // master secret. The field name is not worth a coordinated rename across a
  // file another author is holding.
  const typed = String(cfg.token || "");

  const existing = readConfig();

  /* ⚠️ AN EMPTY CREDENTIAL MEANS "KEEP THE ONE I HAVE", NOT "CLEAR IT".
   *
   * Since GitHub sign-in, the credential is established BEFORE the name is
   * typed rather than at the same time, so setup calls this a second time with
   * the secret field untouched purely to save an edited display name. Treating
   * that as a request to write an empty config would sign the machine out at
   * the last click of setting it up. */
  if (!typed && existing && (existing.session || existing.secret || existing.token)) {
    writeConfig({ ...existing, hub, actor: actor || existing.actor || "" });
    return true;
  }

  const auth = authFor({ secret: typed });
  if (!auth.error && auth.secret) {
    // A pasted secret REPLACES a GitHub session deliberately: somebody typing a
    // master secret into the fallback field is telling us the session is not
    // the credential they want to use, and keeping both would leave
    // `resolveAuth` preferring a session they were trying to get away from.
    writeConfig({ hub, secret: auth.secret, actor });
    return true;
  }

  if (existing && typeof existing.token === "string" && existing.token) {
    writeConfig({ hub, token: typed || existing.token, actor });
    return true;
  }

  // Neither a usable secret nor a machine with a legacy token to keep. Writing
  // it anyway would produce a config that cannot authenticate and an editor
  // that cannot start, and `readConfig` would call it valid — the worst of the
  // available outcomes. Refused instead; `zevet:test` has already told the user
  // why in the same words.
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

ipcMain.handle("zevet:githubStart", async (_e, { hub } = {}) => {
  try {
    if (signIn) signIn.cancel();
    signIn = new GithubSignIn({ hub: hub || (readConfig() || {}).hub });
    const r = await signIn.start();
    // Opened from the MAIN process, never by the renderer. The board window
    // loads remote HTML from the hub, and a renderer that could open arbitrary
    // URLs in the system browser is a hub that can too.
    shell.openExternal(r.verificationUriComplete).catch(() => {
      /* No browser, or none that would take it. The code is on screen; that is
       * the entire reason it is on screen. */
    });
    return { ok: true, userCode: r.userCode, url: r.verificationUriComplete, expiresIn: r.expiresIn };
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
ipcMain.handle("zevet:googleStart", async (_e, { hub } = {}) => {
  try {
    if (signIn) signIn.cancel();
    signIn = new GoogleSignIn({ hub: hub || (readConfig() || {}).hub });
    const r = await signIn.start();
    // Opened from the MAIN process, never by the renderer — same rule as the
    // GitHub flow above, and it matters more here: this URL carries the pairing
    // code that a completed sign-in will be handed over for.
    shell.openExternal(r.authUrl).catch(() => {
      /* No browser, or none that would take it. The URL goes back to the window
       * so it can offer a copyable link rather than being a dead end. */
    });
    // No `userCode`: there is nothing for the person to read or type, which is
    // the whole reason this flow is the web one and not Google's device flow.
    return { ok: true, url: r.authUrl, expiresIn: r.expiresIn, domain: r.domain };
  } catch (err) {
    signIn = null;
    return { ok: false, error: err.message };
  }
});

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
    });
    return { ok: true, login: r.login, owner: r.owner };
  } catch (err) {
    return { ok: false, error: err.message, cancelled: err.message === "cancelled" };
  } finally {
    if (signIn === attempt) signIn = null;
  }
}

ipcMain.handle("zevet:githubWait", () => awaitSignIn("GitHub"));
ipcMain.handle("zevet:googleWait", () => awaitSignIn("Google"));

/* Cancelling is provider-blind — there is one attempt in flight and this ends
 * it, whichever kind it is. Registered under both names so the renderer can
 * call the one that matches the button it is next to. */
const cancelSignIn = () => {
  if (signIn) signIn.cancel();
  signIn = null;
  return true;
};
ipcMain.handle("zevet:githubCancel", cancelSignIn);
ipcMain.handle("zevet:googleCancel", cancelSignIn);

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
  const cfg = readConfig() || {};
  const session = typeof cfg.session === "string" ? cfg.session : "";
  if (!session) return { ok: true, loggedOut: false };
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
  return { ok: true, loggedOut };
};
// Signing out ends a SESSION, and a session does not remember which provider
// minted it — so this is one function, under the name each button expects.
ipcMain.handle("zevet:githubLogout", signOut);
ipcMain.handle("zevet:googleLogout", signOut);

ipcMain.handle("zevet:pickRepo", async () => {
  const picked = await dialog.showOpenDialog(setupWindow, {
    title: "Choose a project folder",
    properties: ["openDirectory"],
  });
  return picked.canceled ? null : picked.filePaths[0];
});

ipcMain.handle("zevet:install", async (_e, repo) => installHooks(repo));

ipcMain.handle("zevet:done", () => {
  const cfg = readConfig();
  if (!cfg) return false;
  openBoard(cfg);
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
  return true;
});

/* ── Pairing with Masora (T5, docs/contracts/cross_app_context.md) ─────────
 *
 * Same two-call device-flow shape as GithubSignIn above, against masora2's
 * own /api/connector/register (the protocol its Go desktop connector uses --
 * read from apps/connector/internal/register/register.go, not guessed). The
 * token this ends with is a workspace-scoped connector bearer, encrypted at
 * rest with safeStorage (desktop/masora.js) -- never handed to a renderer.
 */
let masoraPairSession = null;

ipcMain.handle("zevet:masoraConfig", () => masora.readConfig());

ipcMain.handle("zevet:masoraSaveUrl", (_e, { url } = {}) => masora.saveUrl(url));

ipcMain.handle("zevet:masoraPairStart", async () => {
  try {
    if (masoraPairSession) masoraPairSession.cancel();
    const { url } = masora.readConfig();
    masoraPairSession = new masora.MasoraPair({ baseUrl: url });
    const r = await masoraPairSession.start();
    shell.openExternal(r.verifyUrl).catch(() => {});
    return { ok: true, userCode: r.userCode, verifyUrl: r.verifyUrl };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle("zevet:masoraPairWait", async () => {
  if (!masoraPairSession) return { ok: false, error: "Start pairing first." };
  try {
    const { token } = await masoraPairSession.wait(os.hostname(), process.platform);
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: "This machine's OS keychain is unavailable." };
    }
    masora.saveToken(token, (s) => safeStorage.encryptString(s));
    return { ok: true };
  } catch (err) {
    const cancelled = err && err.message === "cancelled";
    return { ok: false, cancelled, error: cancelled ? null : (err && err.message) || String(err) };
  } finally {
    masoraPairSession = null;
  }
});

ipcMain.handle("zevet:masoraPairCancel", () => {
  if (masoraPairSession) masoraPairSession.cancel();
  masoraPairSession = null;
  return true;
});

ipcMain.handle("zevet:masoraUnpair", () => {
  masora.unpair();
  return true;
});

ipcMain.handle("masora:sources", async () => {
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

ipcMain.handle("masora:connect", async (_e, { provider } = {}) => {
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
  fs.writeFileSync(workspacesPath(), `${JSON.stringify(list, null, 2)}
`, "utf8");
}

/**
 * A renderer may only name a root it has already been given.
 *
 * Without this, `tree("C:\\")` from a compromised page walks the whole disk.
 * The allowlist is the folders the user picked with the native dialog, which
 * is the only place a new root can come from.
 */
function knownRoot(root) {
  const want = path.resolve(String(root || ""));
  return readWorkspaces().some((d) => path.resolve(d) === want) ? want : null;
}

ipcMain.handle("local:workspaces", () =>
  readWorkspaces().map((dir) => ({ dir, name: path.basename(dir), repo: localFs.isProbablyRepo(dir) })),
);

ipcMain.handle("local:addWorkspace", async () => {
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
ipcMain.handle("local:masoraRepos", () => masora.reposFor());

ipcMain.handle("local:masoraRepoToggle", (_e, { root, on } = {}) => {
  const dir = knownRoot(root);
  if (!dir) return { ok: false, error: "not an opened workspace" };
  return { ok: true, repos: masora.setRepoOpted(dir, Boolean(on)) };
});

ipcMain.handle("local:tree", (_e, root) => {
  const dir = knownRoot(root);
  if (!dir) return { ok: false, error: "not an opened workspace" };
  return localFs.listTree(dir, {});
});

ipcMain.handle("local:read", (_e, { root, relPath }) => {
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
ipcMain.handle("local:write", (_e, { root, relPath, text, opts }) => {
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
ipcMain.handle("ui:chrome", (_e, arg) => {
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

ipcMain.handle("local:indexStatus", async (_e, arg) => {
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
ipcMain.handle("local:indexEnable", async (_e, arg) => {
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

ipcMain.handle("local:indexSearch", async (_e, arg) => {
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

ipcMain.handle("local:status", async (_e, arg) => {
  const root = arg && typeof arg.root === "string" ? arg.root : null;
  const dir = root ? knownRoot(root) : null;

  // Probed and read in parallel: the port probe can take its full 250ms and
  // there is no reason for the git call to wait behind it.
  const [cindex, repo] = await Promise.all([
    statusSources.probePort(STATUS_PATHS.cindexPort),
    dir ? repoStats.branchState(dir) : Promise.resolve(null),
  ]);

  const failedAgo = statusSources.hookFailure(STATUS_PATHS.errorLog);

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
    fs.writeFileSync(AGENT_SETTINGS, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  } catch (err) {
    console.error(`zevet: could not save agent settings: ${err.message}`);
  }
  return all[key];
}

ipcMain.handle("local:agentSettings", (_e, arg) => {
  const dir = knownRoot(arg && arg.root);
  if (!dir) return { ok: false, settings: null };
  return { ok: true, settings: agentSettingsFor(dir) };
});

ipcMain.handle("local:saveAgentSettings", (_e, arg) => {
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
    fs.writeFileSync(PREFS, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  } catch (err) {
    console.error(`zevet: could not save prefs: ${err.message}`);
  }
}

ipcMain.handle("local:prefs", () => readPrefs());

ipcMain.handle("local:setPref", (_e, arg) => {
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
ipcMain.handle("local:setPrefs", (_e, arg) => {
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
    fs.writeFileSync(SCHEDULES, `${JSON.stringify(list, null, 2)}\n`, "utf8");
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
        const started = agentConsole.startConsole({
          agent: s.agent,
          cwd: place.cwd,
          model: s.model,
          mode: s.mode,
          onEvent: (evt) => {
            if (evt && evt.type === "agent") noteBurn(evt.payload, handle.id);
            notePlacement(place, evt, handle.id);
            // A scheduled run's worktree goes when the run ends.
            if (evt && evt.type === "exit") void releasePlacement(place);
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
        .flushOutbox({ baseUrl: auth.cfg.url, token: auth.token, file: masoraPush.CHAT_OUTBOX_PATH })
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

ipcMain.handle("local:schedules", () => ({ ok: true, schedules: readSchedules() }));

ipcMain.handle("local:scheduleSave", (_e, arg) => {
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

ipcMain.handle("local:scheduleRemove", (_e, arg) => {
  const id = String((arg && arg.id) || "");
  const list = readSchedules().filter((s) => s.id !== id);
  writeSchedules(list);
  return { ok: true, schedules: list };
});

ipcMain.handle("local:scheduleToggle", (_e, arg) => {
  const id = String((arg && arg.id) || "");
  const list = readSchedules().map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s));
  writeSchedules(list);
  return { ok: true, schedules: list };
});

/** The last few commits in a folder the person has opened. Read only: it
 *  runs `git log` and nothing else, and there is no counterpart that writes. */
ipcMain.handle("local:commits", async (_e, arg) => {
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
ipcMain.handle("local:memories", async (_e, arg) => {
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

ipcMain.handle("local:stats", async (_e, { root, relPaths }) => {
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
ipcMain.handle("local:diffHunks", async (_e, { root, relPath }) => {
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

ipcMain.handle("local:watch", (_e, { root, relPath, initialText }) => {
  const dir = knownRoot(root);
  if (!dir) return { ok: false, error: "not an opened workspace" };
  // The resolved root is passed on, not the renderer's spelling, so the
  // echoed `root` in every change event is the one the allowlist approved.
  return fileWatch.watch(dir, String(relPath || ""), initialText);
});

ipcMain.handle("local:unwatch", (_e, { root, relPath }) => {
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
      onEvent: (room, payload) => toBoard("doc:message", docMessage(room, payload)),
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

ipcMain.handle("doc:join", (_e, room) => {
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

ipcMain.handle("doc:send", (_e, { room, bytes, opts }) => {
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

ipcMain.handle("doc:leave", (_e, room) => {
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
const consoleLog = createConsoleLog();

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

async function releasePlacement(p) {
  if (!placements.delete(p) || !p.worktree) return;
  // A fork shares its source's worktree; the last one out removes it.
  if ([...placements].some((q) => q.worktree === p.worktree)) return;
  // Not from under a process that may still have files open in it.
  await Promise.race([p.gone, new Promise((r) => setTimeout(r, 5000))]);
  await worktrees.release(p.worktree, p.title);
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

ipcMain.handle("local:agents", async () => {
  await runtimeReady;
  const detect = await loadDetect();
  const found = detect ? detect.detectAgents() : [];
  // The CLIs' own model lists, read fresh from their caches on every call, so
  // a model claude or codex learned about this morning is offered without a
  // zevet release. null when there is no cache: the board then keeps the list
  // it shipped with (board/src/lib/agent-models.generated.mjs, same reader).
  const catalogs = { claude: agentCatalogs.claudeModels(), codex: agentCatalogs.codexModels() };
  return ["claude", "codex", "opencode"].map((name) => {
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
let permitSeq = 0;
let askServerPromise = null;

function ensureAskServer() {
  if (!askServerPromise) {
    askServerPromise = askServer.start({
      onPermit: (request) =>
        new Promise((resolve) => {
          const id = `p${++permitSeq}`;
          pendingPermits.set(id, resolve);
          // The board decides. If no board is listening — the window is gone,
          // or it is an older build that does not know this event — nothing
          // resolves this and the ask-server's own timeout denies it, which is
          // the correct end for a question nobody can be asked.
          toBoard("local:permitRequest", { id, ...(request || {}) });
        }),
    });
  }
  return askServerPromise;
}

/** The person's answer to one permit. */
ipcMain.handle("local:permitAnswer", (_e, arg) => {
  const id = arg && typeof arg.id === "string" ? arg.id : "";
  const resolve = pendingPermits.get(id);
  if (!resolve) return { ok: false, error: "no such request" };
  pendingPermits.delete(id);
  resolve({ ok: arg && arg.allow === true, reason: (arg && arg.reason) || "refused" });
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
async function mcpConfigFor(dir) {
  const servers = {};
  let computerUse = false;
  if (agentSettingsFor(dir).computerUse && fs.existsSync(MCP_SERVER)) {
    const { url, token } = await ensureAskServer();
    servers.zevet = {
      command: process.execPath,
      args: [MCP_SERVER],
      env: { ELECTRON_RUN_AS_NODE: "1", ZEVET_MCP_URL: url, ZEVET_MCP_TOKEN: token },
    };
    computerUse = true;
  }
  const masoraCfg = masora.readConfig();
  if (masoraCfg.paired) Object.assign(servers, masora.mcpServerEntry(masoraCfg.url));
  if (!Object.keys(servers).length) return null;
  const file = path.join(app.getPath("temp"), `zevet-mcp-${process.pid}-${++permitSeq}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }), "utf8");
  // `computerUse` says whether the `zevet` tool server (and so its permission
  // tool) is actually in this file -- a masora-only config must not claim a
  // permission tool that config does not register.
  return { file, computerUse };
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

ipcMain.handle("local:startAgent", async (_e, { agent, cwd, opts }) => {
  await runtimeReady;
  const dir = knownRoot(cwd);
  if (!dir) return { ok: false, error: "not an opened workspace" };

  // A claude fork has to start where its source session ran — claude finds a
  // session only from that folder — so it joins its source's worktree rather
  // than getting one of its own. Anything else is placed first, before the
  // awaits below, so an agent started meanwhile sees this one.
  const forkFrom = opts && typeof opts.forkFrom === "string" ? opts.forkFrom : "";
  const source = forkFrom && String(agent || "") === "claude" ? [...placements].find((p) => p.session === forkFrom) : null;
  const place = source ? { ...source, id: null, session: "", title: "" } : await placeAgent(dir);
  if (source) placements.add(place);

  // Standing instructions for this repo, if any were saved. Only claude has a
  // flag for them (agent-console.js § invocationFor); the other two ignore the
  // option rather than being handed something they cannot use.
  const settings = agentSettingsFor(dir);
  let systemPrompt = settings.systemPrompt;
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
  if (String(agent || "") === "claude") {
    try {
      mcpConfig = await mcpConfigFor(dir);
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
  const started = agentConsole.startConsole({
    agent: String(agent || ""),
    cwd: place.cwd,
    model: opts && typeof opts.model === "string" ? opts.model : "",
    mode: opts && typeof opts.mode === "string" ? opts.mode : "auto",
    systemPrompt,
    ...(mcpConfig
      ? {
          mcpConfig: mcpConfig.file,
          // claude names an MCP tool `mcp__<server>__<tool>`; the server is
          // registered as `zevet` above, only when computer use is actually on.
          ...(mcpConfig.computerUse ? { permissionTool: "mcp__zevet__permission_prompt" } : {}),
        }
      : {}),
    /* ⚠️ ASKED FOR, AND ALLOWED, ARE TWO DIFFERENT THINGS. The renderer may
       ask for a forked run; whether this repo may is decided here, against the
       saved settings, because the renderer is the untrusted side of the
       bridge. Same rule the workspace guard follows above. */
    forkFrom,
    onEvent: (evt) => {
      // The status strip's rolling windows are fed HERE, in the main process,
      // and not in the renderer. The renderer shows the live figures off the
      // same events, but it forgets everything on reload and the agents it
      // started keep running -- so the only place a week's spend can actually
      // accumulate is this side of the bridge.
      if (evt && evt.type === "agent") noteBurn(evt.payload, handle.id);
      notePlacement(place, evt, handle.id);
      toBoard("local:agentEvent", consoleLog.record(handle.id, evt));
    },
  });
  if (!started.ok) {
    void releasePlacement(place);
    return { ok: false, error: started.error };
  }

  handle.id = started.id;
  trackPlacement(place, started.id);
  consoles.set(started.id, started);
  consoleLog.open(started.id, consoleMeta(agent, dir, opts, place));
  return { ok: true, id: started.id, agent, cwd: dir };
});

/** What a reloaded board needs to rebuild a console's rail entry. `root` is
 *  the repo the user picked even when the agent works in a worktree of it. */
function consoleMeta(agent, dir, opts, place) {
  return {
    agent: String(agent || ""),
    root: dir,
    model: opts && typeof opts.model === "string" ? opts.model : "",
    mode: opts && typeof opts.mode === "string" ? opts.mode : "auto",
    startedAt: Date.now(),
    ...(place && place.worktree ? { worktree: place.worktree.dir, branch: place.worktree.branch } : {}),
  };
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
ipcMain.handle("local:resumeAgent", async (_e, { agent, cwd, resumeFrom, opts }) => {
  await runtimeReady;
  const dir = knownRoot(cwd);
  if (!dir) return { ok: false, error: "not an opened workspace" };
  if (typeof resumeFrom !== "string" || !resumeFrom.trim()) {
    return { ok: false, error: "no session to resume" };
  }
  const settings = agentSettingsFor(dir);
  let mcpConfig = null;
  if (String(agent || "") === "claude") {
    try {
      mcpConfig = await mcpConfigFor(dir);
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
  const started = agentConsole.startConsole({
    agent: String(agent || ""),
    cwd: place.cwd,
    model: opts && typeof opts.model === "string" ? opts.model : "",
    mode: opts && typeof opts.mode === "string" ? opts.mode : "auto",
    systemPrompt: settings.systemPrompt,
    resumeFrom: resumeFrom.trim(),
    ...(mcpConfig
      ? {
          mcpConfig: mcpConfig.file,
          ...(mcpConfig.computerUse ? { permissionTool: "mcp__zevet__permission_prompt" } : {}),
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
  consoleLog.open(started.id, consoleMeta(agent, dir, opts, place), continues);
  const prev = consoles.get(continues);
  if (prev) {
    try {
      prev.stop();
    } catch {
      // Already gone, which is the expected case: a follow-up only ever
      // replaces a process that has exited.
    }
    consoles.delete(continues);
  }
  return { ok: true, id: started.id, agent, cwd: dir };
});

ipcMain.handle("local:sendToAgent", (_e, { id, text }) => {
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
});

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

ipcMain.handle("local:stopAgent", (_e, id) => {
  const c = consoles.get(id);
  if (!c) return { ok: false, error: "no such console" };
  try {
    c.stop();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  consoles.delete(id);
  return { ok: true };
});

/** Every console a reloaded board should show again, with what it has said. */
ipcMain.handle("local:consoles", () => consoleLog.snapshot());

/** The board closed a thread; a reload should not bring it back. */
ipcMain.handle("local:forgetAgent", (_e, id) => {
  consoleLog.forget(String(id || ""));
  const place = placementOf(String(id || ""));
  if (place) void releasePlacement(place);
  return { ok: true };
});

// An agent outliving the window that started it is a process nobody can see
// and nobody asked for. Called on quit and on window close — NOT on reload,
// which re-attaches instead; see releaseBoardResources.
function stopAllConsoles() {
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

/* ==========================================================================
 * ZEVET CHAT — conversations with no repository behind them (desktop/chat.js)
 *
 * One claude process at a time, kept alive across the turns of the chat in
 * front: a follow-up is one more stdin line, not a cold start. Switching chats
 * ends it, and the next turn there resumes the session by id. Events go to the
 * board on `chat:event`, never `local:agentEvent`, so a chat is never drawn as
 * a console in Code's People pane.
 * ======================================================================== */
let chatRun = null; // { id, console, turn: { user, reply } | null, model, provider }

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
  await masoraPush.flushOutbox({ baseUrl: auth.cfg.url, token: auth.token, file: masoraPush.CHAT_OUTBOX_PATH });
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

/* Model providers (desktop/chat-claude.js documents the contract). One today;
   a chat records which one answered each message. */
const chatProviders = { "claude-cli": createClaudeCli({ startConsole: agentConsole.startConsole }) };
const DEFAULT_CHAT_PROVIDER = "claude-cli";

async function spawnChat(chat, provider, opts = {}) {
  let mcpConfig = null;
  const cfg = masora.readConfig();
  if (cfg.paired) {
    mcpConfig = path.join(app.getPath("temp"), `zevet-chat-mcp-${process.pid}.json`);
    fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: masora.mcpServerEntry(cfg.url) }), "utf8");
  }
  const run = { id: chat.id, console: null, turn: null, model: chat.model || "", want: `${opts.model || ""}|${opts.mode || ""}`, provider: provider.id };
  const opened = provider.open({
    chat,
    mcpConfig,
    model: opts.model,
    mode: opts.mode,
    onEvent: (evt) => {
      const p = evt && evt.type === "agent" ? evt.payload : null;
      if (p && p.type === "system" && p.subtype === "init" && p.model) run.model = String(p.model);
      if (p && p.type === "assistant" && run.turn && p.message && Array.isArray(p.message.content)) {
        const text = p.message.content.filter((b) => b && b.type === "text").map((b) => b.text).join("");
        if (text) run.turn.reply = run.turn.reply ? [run.turn.reply, text].join(String.fromCharCode(10, 10)) : text;
      }
      if (p && p.type === "result" && run.turn) finishChatTurn(run, run.turn.reply, p.is_error);
      if (evt && evt.type === "exit") {
        if (run.turn) finishChatTurn(run, "", true);
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

ipcMain.handle("chat:list", (_e, arg) => chats.list(arg && arg.query));
ipcMain.handle("chat:get", (_e, id) => chats.read(String(id || "")));
/** Who a chat belongs to: the hub login this app signs in as. */
function chatAuthor() {
  const cfg = readConfig();
  return (cfg && typeof cfg.actor === "string" && cfg.actor) || os.userInfo().username;
}

ipcMain.handle("chat:create", () => chats.create(chatAuthor()));
ipcMain.handle("chat:rename", (_e, arg) => chats.rename(arg && arg.id, arg && arg.title));
ipcMain.handle("chat:remove", (_e, id) => {
  if (chatRun && chatRun.id === id) stopChatRun();
  return chats.remove(String(id || ""));
});
ipcMain.handle("chat:stop", (_e, id) => {
  if (chatRun && chatRun.id === id) stopChatRun();
  return { ok: true };
});
ipcMain.handle("chat:send", async (_e, arg) => {
  await runtimeReady;
  const id = String((arg && arg.id) || "");
  const text = String((arg && arg.text) || "");
  const opts = arg && arg.opts ? arg.opts : {};
  const chat = chats.read(id);
  if (!chat) return { ok: false, error: "No such chat." };
  if (!text.trim()) return { ok: false, error: "Nothing to send." };
  if (chatRun && chatRun.id === id && chatRun.turn) return { ok: false, error: "Still answering." };
  if (chatRun && chatRun.id !== id) stopChatRun();
  // A different model or posture needs new flags: respawn (--resume keeps the
  // conversation). Compared against what was ASKED, not run.model, which init
  // overwrites with the resolved id.
  if (chatRun && chatRun.want !== `${opts.model || ""}|${opts.mode || ""}`) stopChatRun();

  const provider = chatProviders[chat.provider] || chatProviders[DEFAULT_CHAT_PROVIDER];
  // A slash command goes to claude bare: no Masora brief, no prior replay
  // (composeTurn drops both too; skipping the fetch here saves the round trip).
  const brief = chats.isSlashPrompt(text) ? null : await chatBrief(provider, text);

  if (!chatRun) {
    const s = await spawnChat(chat, provider, opts);
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

ipcMain.handle("zevet:masoraChatPush", (_e, arg) => masora.setChatPush(Boolean(arg && arg.on)));

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
const appUpdater = new AppUpdater({
  currentVersion: app.getVersion(),
  feedUrl: process.env.ZEVET_APP_FEED || undefined,
  dir: path.join(app.getPath("userData"), "updates"),
  onStatus: (s) => toBoard("app:update", s),
  log: (m) => console.log(`[zevet-app-update] ${m}`),
  openImpl: (f) => shell.openPath(f),
  quitImpl: () => {
    // ⚠️ NOT app.quit(): the board's beforeunload and the single-instance
    // lock both get in the way of a quit that has to be certain, and the
    // installer is already running by the time this fires.
    app.exit(0);
  },
});

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
ipcMain.handle("local:sessions", (_e, arg) => agentSessions.list(arg || {}));
ipcMain.handle("local:session", (_e, arg) =>
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
ipcMain.handle("local:sessionAgents", (_e, arg) =>
  agentSessions.children((arg && arg.slug) || "", (arg && arg.id) || ""),
);
ipcMain.handle("local:sessionLive", (_e, arg) =>
  agentSessions.live((arg && arg.source) || "", (arg && arg.id) || ""),
);

ipcMain.handle("local:defaultMode", (_e, mode) => rememberMode(String(mode || "")));

ipcMain.handle("local:voiceStatus", () => masoraVoice.status());
ipcMain.handle("local:voiceStart", () => masoraVoice.start());
ipcMain.handle("local:voiceMic", () => masoraVoice.mic());

ipcMain.handle("app:updateStatus", () => appUpdater.status());
ipcMain.handle("app:updateCheck", () => appUpdater.check());
ipcMain.handle("app:updateInstall", () => appUpdater.install());

app.whenReady().then(() => {
  buildMenu();
  // No console outlives the app, so neither does a worktree made for one.
  void worktrees.prune();
  startScheduler();
  startMasoraPush();
  // After the window, never before it: an update check that delayed the
  // board would be a worse app for a feature nobody asked to wait on.
  appUpdater.start();
  const cfg = readConfig();
  if (cfg) openBoard(cfg);
  else openSetup(null);

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
if (process.env.ZEVET_ALLOW_MULTI === "1") {
  // Nothing to do: no lock requested, no `second-instance` handler wanted.
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const w = boardWindow || setupWindow;
    if (w && !w.isDestroyed()) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });
}
