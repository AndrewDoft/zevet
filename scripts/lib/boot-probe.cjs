// Headless boot probe, preloaded into an Electron main process with NODE_OPTIONS=--require=<this file>.
// Works on any Electron app (Zevet, Metrodora) so both are timed by the same code.
//
// NEVER SHOWS A WINDOW: BrowserWindow is wrapped so every window is created with show:false and
// offscreen rendering (the page believes it is visible, so paint timing exists, but no native window is drawn);
// show/focus/maximize/restore are no-ops.
//
// Output: one JSON line appended to $PROBE_OUT when the run settles, then the app exits.
//   $PROBE_SETTLE_MS  quiet time after the first real (non-data:) page finishes loading (default 4000)
//   $PROBE_MAX_MS     hard stop (default 40000)
//   $PROBE_OSR=0      hidden window instead of offscreen rendering: no paint events, but real memory (OSR costs ~120 MB)
//   $PROBE_READY_URL  substring of a request URL whose first completed response marks "usable"
// All times are ms since this process was created (process.getCreationTime()).
"use strict";
const Module = require("node:module");
const fs = require("node:fs");

const t0 = process.getCreationTime ? process.getCreationTime() : Date.now();
const now = () => Date.now() - t0;
const out = process.env.PROBE_OUT;
const SETTLE = Number(process.env.PROBE_SETTLE_MS) || 4000;
const MAX = Number(process.env.PROBE_MAX_MS) || 40000;
const READY_URL = process.env.PROBE_READY_URL || "";

const r = { requireHooked: now(), windows: [], requests: [], errors: [] };
let finished = false;
const sessions = new Set();

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const mod = origLoad.apply(this, arguments);
  if (request !== "electron" || !mod || !mod.BrowserWindow || mod.__probed) return mod;
  const Real = mod.BrowserWindow;
  class Probed extends Real {
    constructor(opts = {}) {
      super({ ...opts, show: false, webPreferences: { ...opts.webPreferences, offscreen: process.env.PROBE_OSR !== "0" } });
      track(this, opts);
    }
    show() {}
    showInactive() {}
    focus() {}
    maximize() {}
    restore() {}
  }
  Object.defineProperty(Probed, "name", { value: "BrowserWindow" });
  const wrapped = new Proxy(mod, { get: (t, k) => (k === "BrowserWindow" ? Probed : k === "__probed" ? true : t[k]) });
  return wrapped;
};

function track(win, opts) {
  const w = { n: r.windows.length, created: now(), w: opts.width, h: opts.height };
  r.windows.push(w);
  const wc = win.webContents;
  wc.once("did-start-loading", () => (w.loadStart = now()));
  wc.on("dom-ready", () => (w.domReady ??= now()));
  // first frame painted after the first real document commits = first paint of the real page
  wc.on("did-navigate", (_e, url) => { if (!url.startsWith("data:") && w.commit === undefined) { w.commit = now(); } });
  wc.on("paint", () => { if (w.commit !== undefined && w.paint === undefined) { w.paint = now(); if (r.firstRealPaint === undefined) r.firstRealPaint = w.paint; } });
  wc.on("did-fail-load", (_e, code, desc, url, main) => main && code !== -3 && r.errors.push({ at: now(), code, desc, url: String(url).slice(0, 80) }));
  wc.on("did-finish-load", async () => {
    const url = wc.getURL();
    const real = !url.startsWith("data:");
    const rec = { at: now(), url: real ? url.replace(/[?#].*$/, "") : "data:" };
    (w.loads ||= []).push(rec);
    try {
      const fcp = await wc.executeJavaScript(
        "(()=>{const e=performance.getEntriesByName('first-contentful-paint')[0];return e?Math.round(performance.timeOrigin+e.startTime):null})()",
      );
      if (fcp) rec.fcp = fcp - t0;
    } catch {}
    if (real && w.finish === undefined) {
      w.finish = rec.at;
      w.fcp = rec.fcp;
      if (r.firstReal === undefined) {
        r.firstReal = rec.at;
        r.firstRealFcp = rec.fcp;
        r.firstRealUrl = rec.url;
        setTimeout(settle, SETTLE);
      }
    }
  });
  sessions.add(wc.session);
  try {
    wc.session.webRequest.onCompleted((d) => {
      const u = d.url.replace(/[?#].*$/, "");
      if (d.url.startsWith("data:") || d.url.startsWith("devtools:")) return;
      r.requests.push({ at: now(), u: u.slice(0, 90), s: d.statusCode, c: d.fromCache ? 1 : 0 });
    });
    // a stream (SSE) never "completes", so "usable" is read at the first response headers instead
    wc.session.webRequest.onResponseStarted((d) => {
      if (!d.url.startsWith("data:") && /events/.test(d.url)) r.requests.push({ at: now(), u: d.url.replace(/[?#].*$/, "").slice(0, 90), s: d.statusCode, c: 2 });
      if (READY_URL && r.ready === undefined && d.url.includes(READY_URL) && d.statusCode < 400) r.ready = now();
    });
  } catch {}
}

function settle() {
  if (finished) return;
  finished = true;
  const { app } = require("electron");
  try {
    const m = app.getAppMetrics();
    r.procs = m.length;
    r.workingSetMB = Math.round(m.reduce((a, p) => a + (p.memory.workingSetSize || 0), 0) / 1024);
    r.privateMB = Math.round(m.reduce((a, p) => a + (p.memory.privateBytes || 0), 0) / 1024);
    r.pids = m.map((p) => p.pid);
  } catch (e) {
    r.errors.push({ metrics: String(e) });
  }
  r.appReady = r.appReady ?? null;
  r.version = app.getVersion();
  r.reqCount = r.requests.length;
  r.fromCache = r.requests.filter((q) => q.c).length;
  if (out) fs.appendFileSync(out, JSON.stringify(r) + "\n");
  setTimeout(() => process.exit(0), 50);
}

// app ready time, plus the hard stop
setImmediate(() => {
  try {
    const { app } = require("electron");
    app.whenReady().then(() => (r.appReady = now()));
  } catch {}
});
setTimeout(settle, MAX).unref?.();

// a process that dies before settling (a payload swap relaunches it) still reports what it measured
process.on("exit", () => {
  if (finished || !out) return;
  r.exitedAt = now();
  r.pid = process.pid;
  try { fs.appendFileSync(out, JSON.stringify(r) + "\n"); } catch {}
});
