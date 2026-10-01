"use strict";
// The board window reopens where it was left: size, position and maximized (Metrodora's window-state.json).
// Pure but for the file: Electron's `screen` and the window are passed in, so node --test loads it.

const fs = require("node:fs");

const DEFAULT = { width: 1240, height: 820 };
const MIN = { width: 720, height: 420 };
const SAVE_DELAY_MS = 400;

const num = (v) => typeof v === "number" && Number.isFinite(v);

/** The saved state, or the default when there is none or it is unreadable. Never throws. */
function load(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!num(s.width) || !num(s.height)) return { ...DEFAULT };
    const out = { width: Math.max(MIN.width, Math.round(s.width)), height: Math.max(MIN.height, Math.round(s.height)) };
    if (num(s.x) && num(s.y)) { out.x = Math.round(s.x); out.y = Math.round(s.y); }
    if (s.maximized === true) out.maximized = true;
    return out;
  } catch {
    return { ...DEFAULT };
  }
}

/**
 * A saved position can fall off every screen after a monitor is unplugged or rearranged. Pull the window back
 * inside the work area of the display it overlaps most; `workAreaFor(rect)` is `screen.getDisplayMatching(rect).workArea`.
 */
function clamp(state, workAreaFor) {
  if (!num(state.x) || !num(state.y)) return state;
  const { x: dx, y: dy, width: dw, height: dh } = workAreaFor({ x: state.x, y: state.y, width: state.width, height: state.height });
  const width = Math.min(state.width, dw);
  const height = Math.min(state.height, dh);
  return { ...state, width, height, x: Math.min(Math.max(state.x, dx), dx + dw - width), y: Math.min(Math.max(state.y, dy), dy + dh - height) };
}

/** Write the window's current state. A maximized window saves its restored bounds, so un-maximizing lands somewhere sane. */
function save(file, win, write) {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  try {
    const maximized = win.isMaximized();
    write(file, { ...(maximized ? win.getNormalBounds() : win.getBounds()), ...(maximized ? { maximized: true } : {}) });
  } catch {
    // The window is still fine without a remembered position; nothing to tell the person.
  }
}

/** Save on resize/move (debounced) and on close. `write` is atomicWriteJson. */
function track(win, file, write, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null;
  const later = () => { clearTimer(timer); timer = setTimer(() => save(file, win, write), SAVE_DELAY_MS); };
  win.on("resize", later);
  win.on("move", later);
  win.on("close", () => { clearTimer(timer); save(file, win, write); });
}

module.exports = { DEFAULT, MIN, load, clamp, save, track };
