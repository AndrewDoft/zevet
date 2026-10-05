"use strict";
// Who may call the privileged IPC bridge (audit B2, partial). The board window
// loads a remote origin with a preload attached, so every handler is reachable
// from whatever that page runs; a call is honoured only when it comes from the
// configured hub origin or the app's own setup.html. The check is
// @masora/desktop-kit's; this file is Zevet's policy.
const path = require("node:path");
const kit = require("@masora/desktop-kit");

const SETUP = path.join(__dirname, "setup.html");
const policy = (hubUrl) => ({ origins: [hubUrl], files: [SETUP] });

const senderAllowed = (frameUrl, hubUrl) => kit.senderAllowed(frameUrl, policy(hubUrl));

/** Patch `ipcMain.handle` so every later registration checks its sender first. */
const guardIpc = (ipcMain, hubUrl) => kit.guardIpc(ipcMain, () => policy(hubUrl()));

module.exports = { senderAllowed, guardIpc };
