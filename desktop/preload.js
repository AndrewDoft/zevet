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
