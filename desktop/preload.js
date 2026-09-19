// The only bridge between a renderer and this machine, and it is deliberately
// tiny: five named calls, no `require`, no `ipcRenderer` handle, nothing that
// takes a channel name from the page. The setup window is local HTML we ship;
// the board window has no preload at all, because it loads a remote origin.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("zevet", {
  /** The saved settings, or null on a first run. */
  config: () => ipcRenderer.invoke("zevet:config"),
  /** Ask the hub whether this URL and token actually work, before saving them. */
  test: (hub, token) => ipcRenderer.invoke("zevet:test", { hub, token }),
  /** Write ~/.zevet/config.json. */
  save: (hub, token, actor) => ipcRenderer.invoke("zevet:save", { hub, token, actor }),
  /** Native folder picker; resolves to a path or null. */
  pickRepo: () => ipcRenderer.invoke("zevet:pickRepo"),
  /** Install the hooks into that repo. */
  install: (repo) => ipcRenderer.invoke("zevet:install", repo),
  /** Setup is finished — open the board. */
  done: () => ipcRenderer.invoke("zevet:done"),
});

/**
 * The workspace surface, exposed to the BOARD window.
 *
 * This is what makes the desktop app more than a browser tab: it can read the
 * machine it is running on. The hub never receives a byte of anyone's source,
 * so a real file tree and real file contents can only come from here.
 *
 * Deliberately narrow: list a tree under a folder the user picked, read one
 * text file, write one text file back, start/stop an agent. No arbitrary path,
 * no `require`, no shell. The main process re-checks every path against the
 * chosen root anyway — a renderer is never trusted, and this bridge is a
 * convenience, not the guard.
 */
contextBridge.exposeInMainWorld("zevetLocal", {
  available: true,
  /** The folders this machine has opened, most recent first. */
  workspaces: () => ipcRenderer.invoke("local:workspaces"),
  /** Native folder picker; adds it to the list. */
  addWorkspace: () => ipcRenderer.invoke("local:addWorkspace"),
  /** A file tree under one of those folders. */
  tree: (root) => ipcRenderer.invoke("local:tree", root),
  /** One text file, by path relative to its root. */
  read: (root, relPath) => ipcRenderer.invoke("local:read", { root, relPath }),
  /**
   * One text file back, by path relative to its root.
   *
   * SAID PLAINLY, because it changes what this bridge is: the board window
   * loads a REMOTE origin — the hub's own page — with this preload attached.
   * openBoard() in main.js sets out why that is considered acceptable (the hub
   * already ships the hook that runs on every teammate's machine, so it is
   * trusted with code execution already, and a narrow bridge makes a capability
   * it effectively had explicit and bounded instead of implicit).
   *
   * That reasoning was written about READING files. This adds writing them, and
   * the stakes of the same decision are now higher: a hostile hub page could
   * not merely see your source, it could change it, inside a folder you picked.
   * The decision stands and is not being reopened here. It is written down so
   * that whoever does reopen it is looking at the real stake.
   *
   * `opts` is `{ bom, eol }` as `read` reported them, so a file goes back the
   * way it came. main.js keeps only those two fields; nothing else crosses.
   */
  write: (root, relPath, text, opts) => ipcRenderer.invoke("local:write", { root, relPath, text, opts }),
  /** Which agents are installed on this machine. */
  agents: () => ipcRenderer.invoke("local:agents"),
  /** Start an agent in a folder. Returns { ok, id }. */
  startAgent: (agent, cwd, opts) => ipcRenderer.invoke("local:startAgent", { agent, cwd, opts }),
  sendToAgent: (id, text) => ipcRenderer.invoke("local:sendToAgent", { id, text }),
  stopAgent: (id) => ipcRenderer.invoke("local:stopAgent", id),
  /** Stream of console events; returns an unsubscribe function. */
  onAgentEvent: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on("local:agentEvent", handler);
    return () => ipcRenderer.removeListener("local:agentEvent", handler);
  },
});
