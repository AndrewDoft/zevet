// zevet desktop — the thing you send your friends.
//
// Two windows and one job each. Setup collects the three values nobody can
// guess (hub, token, name), writes ~/.zevet/config.json and wires a repo. The
// board is the hub's own page, loaded remotely.
//
// SECURITY POSTURE, stated because it is the whole reason this file is shaped
// the way it is: the board window renders a page served by the hub, which is
// a remote origin. It therefore gets no Node, no preload, no context bridge —
// nothing but a browser. Only the local setup window has a preload, and that
// preload exposes five named calls, not `require`. A compromised or spoofed
// hub can then do exactly what any website can do to a browser tab, and
// nothing whatsoever to the machine.
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const HOME = process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet");
const CONFIG = path.join(HOME, "config.json");
const CLIENT_DIR = path.join(HOME, "client");
const PAPER = "#0d0a0a";

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
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
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
    body{background:${PAPER};color:#f2e6e1;font:15px/1.65 -apple-system,Segoe UI,sans-serif;
         margin:0;display:grid;place-items:center;height:100vh;padding:32px}
    div{max-width:52ch}h1{font-size:21px;font-weight:500;margin:0 0 10px}
    p{color:#8f7d78;margin:0 0 12px}code{font-family:ui-monospace,monospace;font-size:12px;
      background:#16110f;border:1px solid #33221e;padding:2px 6px;border-radius:3px}
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
