"use strict";
// The mod seam: every `mods/*.js` (and `mods/<name>/index.js`) is loaded at startup, and its
// `beforeQuit` runs when the app quits. A batch adds a feature by dropping a file in mods/, so
// nobody edits main.js. `mods/tools/` is the MCP tool registry (mod-tools.js), not a mod.
//
// A mod is `module.exports = { name?, start(ctx), beforeQuit(ctx) }` or just a function (= start).
// A mod that throws is logged and skipped: a broken extra must never be why the app fails to start.
// start() runs while main.js is still wiring handlers, BEFORE bridge.assertComplete(), so a mod can
// register its own IPC handlers (ctx.bridge.handle) but must wait for app.whenReady() before
// touching windows or app paths.
const fs = require("node:fs");
const path = require("node:path");

const MODS_DIR = path.join(__dirname, "mods");
const NOT_MODS = new Set(["tools"]);

function modFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (NOT_MODS.has(e.name)) continue;
    if (e.isFile() && e.name.endsWith(".js")) out.push(path.join(dir, e.name));
    else if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, "index.js"))) out.push(path.join(dir, e.name, "index.js"));
  }
  return out;
}

function loadMods(ctx, { dir = MODS_DIR, log = console } = {}) {
  const loaded = [];
  const swallow = (name, what) => (err) => log.error(`zevet: mod ${name} ${what} failed: ${err && err.message}`);
  for (const file of modFiles(dir)) {
    const rel = path.relative(dir, file).replaceAll("\\", "/");
    try {
      const exported = require(file);
      const mod = typeof exported === "function" ? { start: exported } : exported;
      if (!mod || (typeof mod.start !== "function" && typeof mod.beforeQuit !== "function")) throw new Error("exports neither start nor beforeQuit");
      const name = String(mod.name || rel.replace(/(\/index)?\.js$/, ""));
      loaded.push({ name, mod });
      if (typeof mod.start === "function") Promise.resolve().then(() => mod.start(ctx)).catch(swallow(name, "start"));
    } catch (err) {
      swallow(rel, "load")(err);
    }
  }
  return {
    names: loaded.map((m) => m.name),
    /** Newest first, each isolated; before-quit cannot wait, so a promise is not awaited. */
    beforeQuit() {
      for (const { name, mod } of loaded.slice().reverse()) {
        if (typeof mod.beforeQuit !== "function") continue;
        try {
          Promise.resolve(mod.beforeQuit(ctx)).catch(swallow(name, "beforeQuit"));
        } catch (err) {
          swallow(name, "beforeQuit")(err);
        }
      }
    },
  };
}

module.exports = { loadMods, modFiles, MODS_DIR };
