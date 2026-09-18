// zevet desktop — the thing you send your friends.
//
// Two windows and one job each. Setup collects the three values nobody can
// guess (hub, token, name), writes ~/.zevet/config.json and wires a repo. The
// board is the hub's own page, loaded remotely.
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
// dialog and read one text file from it — nothing else, and never a path the
// main process has not re-checked against that root. See openBoard() for why
// the board is allowed a bridge at all despite loading a remote origin.
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu } = require("electron");
const localFs = require("./local-fs.js");
const agentConsole = require("./agent-console.js");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const os = require("node:os");

const HOME = process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet");
const CONFIG = path.join(HOME, "config.json");
const CLIENT_DIR = path.join(HOME, "client");
// The eggshell the board is painted on. Used as the window background so there
// is no white — or, as it was until now, near-black — flash before first paint.
const PAPER = "#eae7e2";

let boardWindow = null;
let setupWindow = null;
let watcher = null;

function readConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    if (cfg && typeof cfg.hub === "string" && typeof cfg.token === "string" && cfg.hub && cfg.token) return cfg;
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

/** The installer that ships with the client, if the client has been synced. */
function installerPath() {
  const installed = path.join(CLIENT_DIR, "install.mjs");
  if (fs.existsSync(installed)) return installed;
  // Running from a checkout rather than a packaged build.
  const local = path.join(__dirname, "..", "client", "install.mjs");
  return fs.existsSync(local) ? local : null;
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
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
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

  const url = `${cfg.hub.replace(/\/+$/, "")}/?token=${encodeURIComponent(cfg.token)}`;
  boardWindow.loadURL(url);

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

  boardWindow.on("closed", () => {
    boardWindow = null;
  });

  startCollisionWatch(cfg);
}

function unreachablePage(hub, why) {
  return `<!doctype html><meta charset="utf-8"><style>
    body{background:${PAPER};color:#2c2f44;font:300 15px/1.65 -apple-system,Segoe UI,sans-serif;
         margin:0;display:grid;place-items:center;height:100vh;padding:32px}
    div{max-width:52ch}h1{font-size:22px;font-weight:200;margin:0 0 10px;letter-spacing:.01em}
    p{color:#5f6274;margin:0 0 12px}code{font-family:ui-monospace,monospace;font-size:12px;
      background:#fff8;border:1px solid #cfccc6;padding:2px 6px}
  </style><div><h1>Can't reach the hub.</h1>
  <p>Tried <code>${hub.replace(/[<&]/g, "")}</code> and got: ${String(why).replace(/[<&]/g, "")}</p>
  <p>The hub may be off, or this machine may not be able to see it. Nothing is wrong with your install —
  zevet will connect as soon as the hub answers. Use <b>zevet &rsaquo; Change hub…</b> if the address changed.</p></div>`;
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
  const controller = new AbortController();
  watcher = controller;
  const base = cfg.hub.replace(/\/+$/, "");
  const me = (cfg.actor || "").toLowerCase();
  const announced = new Set();

  while (!controller.signal.aborted) {
    try {
      const res = await fetch(`${base}/events?token=${encodeURIComponent(cfg.token)}`, {
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
              body: `${others.join(" and ")} just touched ${c.target}, which you are also in.`,
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
          label: "Wire up a repo…",
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
    title: "Pick the repo you'll be working in",
    properties: ["openDirectory"],
  });
  if (picked.canceled || !picked.filePaths[0]) return;
  const result = await installHooks(picked.filePaths[0]);
  dialog.showMessageBox(parent, {
    type: result.ok ? "info" : "error",
    message: result.ok ? "Wired up." : "Could not wire that folder up.",
    detail: result.detail,
  });
}

function installHooks(repo) {
  return new Promise((resolve) => {
    const installer = installerPath();
    if (!installer) {
      resolve({ ok: false, detail: "The zevet client is not installed yet. Finish setup first." });
      return;
    }
    execFile(process.execPath, [installer, repo], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, detail: (stderr || err.message).trim().slice(0, 600) });
        return;
      }
      resolve({ ok: true, detail: `${repo}\n\nStart Claude Code there and you'll appear on the board.` });
    });
  });
}

// ---- IPC, from the setup window only -------------------------------------

ipcMain.handle("zevet:config", () => readConfig());

ipcMain.handle("zevet:test", async (_e, { hub, token }) => {
  try {
    const base = String(hub).replace(/\/+$/, "");
    const res = await fetch(`${base}/dist/manifest.json`, {
      headers: { "x-zevet-token": String(token) },
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

ipcMain.handle("zevet:save", (_e, cfg) => {
  writeConfig({ hub: String(cfg.hub).replace(/\/+$/, ""), token: String(cfg.token), actor: String(cfg.actor) });
  return true;
});

ipcMain.handle("zevet:pickRepo", async () => {
  const picked = await dialog.showOpenDialog(setupWindow, {
    title: "Pick the repo you'll be working in",
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
    const here = path.join(__dirname, "..", "client", "detect.mjs");
    const installed = path.join(CLIENT_DIR, "detect.mjs");
    const target = fs.existsSync(installed) ? installed : here;
    detectPromise = import(pathToFileURL(target).href).catch((err) => {
      console.error(`zevet: could not load detect.mjs (${err.message})`);
      return null;
    });
  }
  return detectPromise;
}

ipcMain.handle("local:agents", async () => {
  const detect = await loadDetect();
  const found = detect ? detect.detectAgents() : [];
  return ["claude", "codex"].map((name) => {
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

ipcMain.handle("local:startAgent", (_e, { agent, cwd, opts }) => {
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
    onEvent: (evt) => toBoard("local:agentEvent", { id: handle.id, ...evt }),
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

app.whenReady().then(() => {
  buildMenu();
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

// A second instance should raise the first, not open a second board.
if (!app.requestSingleInstanceLock()) {
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
