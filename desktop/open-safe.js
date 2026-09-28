"use strict";
// The one door to the system browser. A URL that came from a server, a config
// file or the renderer must not reach shell.openExternal as file:, smb:, a
// custom protocol handler, etc. (audit B8): https is always fine, http only
// to this machine (Masora runs on 127.0.0.1).

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isSafeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return false;
  }
  return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
}

/** Resolves to what shell.openExternal resolves to; rejects for a refused URL. */
function openSafe(url, shell = require("electron").shell) {
  if (!isSafeUrl(url)) return Promise.reject(new Error(`refusing to open ${String(url).slice(0, 80)}`));
  return Promise.resolve(shell.openExternal(String(url)));
}

module.exports = { isSafeUrl, openSafe };
