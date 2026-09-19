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
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu } = require("electron");
const localFs = require("./local-fs.js");
const agentConsole = require("./agent-console.js");
const repoStats = require("./repo-stats.js");
const statusSources = require("./status-sources.js");
const crypto = require("node:crypto");
const indexCapability = require("./index-capability.js");
const embedder = require("./embedder.js");
const codeIndex = require("./code-index.js");
const { FileWatch } = require("./file-watch.js");
const { AppUpdater } = require("./app-update.js");
const runtime = require("./runtime.js");
const { GithubSignIn } = require("./github-signin.js");
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
function chromeFor(theme) {
  const dark = theme === "dark";
  return {
    color: dark ? PAPER_DARK : PAPER,
    symbolColor: dark ? "#eae7e2" : INK,
    height: 46,
  };
}

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
      : { titleBarOverlay: chromeFor("light") }),
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
    hasSecret,
    // Who is signed in, for the settings pane to show. A login is a public
    // name, not a credential -- it is on every commit this person has ever
    // pushed -- so unlike the secret and the session it is safe to hand back.
    login: typeof cfg.login === "string" ? cfg.login : "",
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

ipcMain.handle("zevet:githubWait", async () => {
  if (!signIn) return { ok: false, error: "Start GitHub sign-in first." };
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
      // The GitHub login is a far better actor name than a hostname, and it is
      // the name teammates will recognise on the board. An actor already chosen
      // by hand is not overwritten.
      actor: existing.actor || r.login,
      login: r.login,
    });
    return { ok: true, login: r.login, owner: r.owner };
  } catch (err) {
    return { ok: false, error: err.message, cancelled: err.message === "cancelled" };
  } finally {
    if (signIn === attempt) signIn = null;
  }
});

ipcMain.handle("zevet:githubCancel", () => {
  if (signIn) signIn.cancel();
  signIn = null;
  return true;
});

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
ipcMain.handle("zevet:githubLogout", async () => {
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
});

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
      w.setTitleBarOverlay({ color: paper, symbolColor: ink, height: 46 });
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
      filter: typeof arg.filter === "string" && arg.filter ? arg.filter : undefined,
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
  // An unwatch for a root that is no longer known is not an error: the
  // workspace list can change under a renderer that is closing a tab, and
  // there is nothing to protect — unwatch only ever removes.
  if (!dir) return { ok: true };
  return fileWatch.unwatch(dir, String(relPath || ""));
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
  return ["claude", "codex", "opencode"].map((name) => {
    const r = agentConsole.resolveAgent(name);
    const id = name === "claude" ? "claude-code" : name;
    const d = found.find((a) => a.id === id) || {};
    return {
      name,
      ok: Boolean(r.ok),
      detail: r.ok ? r.file : r.error,
      signedIn: Boolean(d.signedIn),
      // "unverified" for codex means the hook path is unproven; the CONSOLE
      // path below is what this launcher uses, and that is separate.
      hooks: d.hooks === undefined ? null : d.hooks,
    };
  });
});

ipcMain.handle("local:startAgent", async (_e, { agent, cwd, opts }) => {
  await runtimeReady;
  const dir = knownRoot(cwd);
  if (!dir) return { ok: false, error: "not an opened workspace" };

  // A mutable holder rather than closing over `started` directly: onEvent can
  // fire DURING startConsole (a spawn that fails immediately does exactly
  // that), and at that moment `const started` is still in its temporal dead
  // zone — reading it throws a ReferenceError out of the error path, which is
  // the worst possible place to add a second failure.
  const handle = { id: null };
  const started = agentConsole.startConsole({
    agent: String(agent || ""),
    cwd: dir,
    model: opts && typeof opts.model === "string" ? opts.model : "",
    mode: opts && typeof opts.mode === "string" ? opts.mode : "auto",
    onEvent: (evt) => {
      // The status strip's rolling windows are fed HERE, in the main process,
      // and not in the renderer. The renderer shows the live figures off the
      // same events, but it forgets everything on reload and the agents it
      // started keep running -- so the only place a week's spend can actually
      // accumulate is this side of the bridge.
      if (evt && evt.type === "agent") noteBurn(evt.payload, handle.id);
      toBoard("local:agentEvent", { id: handle.id, ...evt });
    },
  });
  if (!started.ok) return { ok: false, error: started.error };

  handle.id = started.id;
  consoles.set(started.id, started);
  return { ok: true, id: started.id, agent, cwd: dir };
});

ipcMain.handle("local:sendToAgent", (_e, { id, text }) => {
  const c = consoles.get(id);
  if (!c) return { ok: false, error: "no such console" };
  try {
    return c.send(String(text || ""));
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

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

// An agent outliving the window that started it is a process nobody can see
// and nobody asked for.
app.on("before-quit", () => {
  for (const c of consoles.values()) {
    try {
      c.stop();
    } catch {
      // Already gone; nothing to do and nothing worth reporting at exit.
    }
  }
  consoles.clear();
});

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

ipcMain.handle("app:updateStatus", () => appUpdater.status());
ipcMain.handle("app:updateCheck", () => appUpdater.check());
ipcMain.handle("app:updateInstall", () => appUpdater.install());

app.whenReady().then(() => {
  buildMenu();
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
