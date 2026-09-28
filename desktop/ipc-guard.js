"use strict";
// Who may call the privileged IPC bridge (audit B2, partial). The board window
// loads a remote origin with a preload attached, so every handler is reachable
// from whatever that page runs; a call is honoured only when it comes from the
// configured hub origin or the app's own setup.html.

const { fileURLToPath } = require("node:url");
const path = require("node:path");

const SETUP = path.join(__dirname, "setup.html");

function senderAllowed(frameUrl, hubUrl) {
  let u;
  try {
    u = new URL(String(frameUrl));
  } catch {
    return false;
  }
  if (u.protocol === "file:") {
    try {
      return path.resolve(fileURLToPath(u)) === SETUP;
    } catch {
      return false;
    }
  }
  try {
    return !!hubUrl && u.origin !== "null" && u.origin === new URL(hubUrl).origin;
  } catch {
    return false;
  }
}

/** Patch `ipcMain.handle` so every later registration checks its sender first. */
function guardIpc(ipcMain, hubUrl) {
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) =>
    handle(channel, (event, ...args) => {
      if (!senderAllowed(event && event.senderFrame && event.senderFrame.url, hubUrl())) {
        throw new Error(`ipc ${channel}: sender not allowed`);
      }
      return fn(event, ...args);
    });
}

module.exports = { senderAllowed, guardIpc };
