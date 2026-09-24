#!/usr/bin/env node
// A driving harness for the zevet Electron app, for other agents to poke the
// UI from bash. See README.md in this directory for usage.
"use strict";

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const DESKTOP = path.join(ROOT, "desktop");
const STATE_FILE = path.join(HERE, ".state.json");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForCDP(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`CDP never came up on port ${port}: ${lastErr && lastErr.message}`);
}

async function cmdLaunch() {
  const existing = loadState();
  if (existing && alive(existing.pid)) {
    throw new Error(`already launched (pid ${existing.pid}); run "close" first`);
  }

  // A fresh, empty profile: no ~/.zevet config (ZEVET_HOME), no Electron
  // userData (--user-data-dir), so the app looks exactly like a first install.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "zevet-drive-"));
  const home = path.join(base, "zevet-home");
  const userData = path.join(base, "user-data");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });

  const require = createRequire(path.join(DESKTOP, "package.json"));
  const electronPath = require("electron");
  const port = 9333 + Math.floor(Math.random() * 5000);

  const outLog = fs.openSync(path.join(base, "stdout.log"), "w");
  const errLog = fs.openSync(path.join(base, "stderr.log"), "w");
  const child = spawn(
    electronPath,
    [DESKTOP, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`],
    {
      cwd: DESKTOP,
      env: {
        ...process.env,
        ZEVET_HOME: home,
        // The installer writes ~/.codex, ~/.config/opencode and ~/.claude, so a
        // throwaway ZEVET_HOME alone still edits the real user's agent configs.
        HOME: base,
        USERPROFILE: base,
        // Never let a test run start a pairing against a Masora that is really running here.
        ZEVET_MASORA_URL: process.env.ZEVET_MASORA_URL || "http://127.0.0.1:1",
        APPDATA: path.join(base, "appdata"),
        LOCALAPPDATA: path.join(base, "localappdata"),
        ZEVET_TEST_HOOKS: "1",
        ZEVET_ALLOW_MULTI: "1",
      },
      detached: true,
      stdio: ["ignore", outLog, errLog],
    },
  );
  child.unref();

  const state = { pid: child.pid, port, home, userData, base };
  saveState(state);

  await waitForCDP(port);
  return { ok: true, ...state };
}

async function connect() {
  const state = loadState();
  if (!state) throw new Error('not launched; run "launch" first');
  if (!alive(state.pid)) throw new Error("the app process is gone; run \"launch\" again");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${state.port}`);
  return { browser, state };
}

function realPages(browser) {
  const pages = [];
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      const url = p.url();
      if (url.startsWith("devtools://")) continue;
      pages.push(p);
    }
  }
  return pages;
}

async function pickPage(browser, windowIndex) {
  const pages = realPages(browser);
  const p = pages[windowIndex ?? 0];
  if (!p) throw new Error(`no window at index ${windowIndex ?? 0} (${pages.length} window(s) open)`);
  return p;
}

async function cmdWindows() {
  const { browser } = await connect();
  const pages = realPages(browser);
  const out = pages.map((p, i) => ({ index: i, url: p.url(), title: undefined }));
  for (const row of out) {
    try {
      row.title = await pages[row.index].title();
    } catch {
      row.title = null;
    }
  }
  await browser.close();
  return out;
}

/** A compact DOM outline: tag, id, role/type, visible text, disabled/hidden. */
async function cmdSnapshot(windowIndex) {
  const { browser } = await connect();
  const page = await pickPage(browser, windowIndex);
  const outline = await page.evaluate(() => {
    const lines = [];
    const interesting = "button, a, input, select, textarea, summary, details, [role], h1, h2, label, [id]";
    const seen = new Set();
    for (const el of document.querySelectorAll(interesting)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const role = el.getAttribute("role") || (tag === "button" ? "button" : tag === "a" ? "link" : tag === "input" ? `input[${el.type || "text"}]` : "");
      const text = (el.value !== undefined && (tag === "input" || tag === "textarea")
        ? el.value
        : el.textContent || ""
      ).trim().replace(/\s+/g, " ").slice(0, 80);
      const placeholder = el.placeholder ? ` placeholder="${el.placeholder}"` : "";
      const disabled = el.disabled ? " disabled" : "";
      const hidden = el.hidden || el.closest("[hidden]") ? " hidden" : "";
      lines.push(`${tag}${id}${role ? ` role=${role}` : ""}${placeholder}${disabled}${hidden} "${text}"`);
    }
    return lines.join("\n");
  });
  await browser.close();
  return { url: page.url(), outline };
}

async function cmdClick(target, windowIndex) {
  const { browser } = await connect();
  const page = await pickPage(browser, windowIndex);
  if (target.startsWith("text=")) {
    await page.getByText(target.slice(5), { exact: false }).first().click();
  } else {
    await page.click(target);
  }
  await browser.close();
  return { ok: true };
}

async function cmdType(selector, text, windowIndex) {
  const { browser } = await connect();
  const page = await pickPage(browser, windowIndex);
  await page.fill(selector, text);
  await browser.close();
  return { ok: true };
}

async function cmdPress(key, windowIndex) {
  const { browser } = await connect();
  const page = await pickPage(browser, windowIndex);
  await page.keyboard.press(key);
  await browser.close();
  return { ok: true };
}

async function cmdEval(code, windowIndex) {
  const { browser } = await connect();
  const page = await pickPage(browser, windowIndex);
  const result = await page.evaluate((src) => {
    // eslint-disable-next-line no-eval
    return eval(src);
  }, code);
  await browser.close();
  return { result };
}

async function cmdScreenshot(dest, windowIndex) {
  const { browser } = await connect();
  const page = await pickPage(browser, windowIndex);
  await page.screenshot({ path: dest });
  await browser.close();
  return { ok: true, path: dest };
}

/** Read this harness's own record of shell.openExternal calls for the current run. */
async function cmdOpened() {
  const state = loadState();
  if (!state) throw new Error('not launched; run "launch" first');
  const file = path.join(state.home, "opened-external.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function killTree(pid) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

async function cmdClose() {
  const state = loadState();
  if (!state) return { ok: true, wasRunning: false };
  if (alive(state.pid)) killTree(state.pid);
  fs.rmSync(STATE_FILE, { force: true });
  return { ok: true, wasRunning: true };
}

function parseWindowFlag(args) {
  const i = args.indexOf("--window");
  if (i === -1) return { windowIndex: undefined, rest: args };
  const windowIndex = Number(args[i + 1]);
  const rest = args.slice(0, i).concat(args.slice(i + 2));
  return { windowIndex, rest };
}

async function main() {
  const [, , cmd, ...rawArgs] = process.argv;
  const { windowIndex, rest: args } = parseWindowFlag(rawArgs);

  let out;
  switch (cmd) {
    case "launch":
      out = await cmdLaunch();
      break;
    case "windows":
      out = await cmdWindows();
      break;
    case "snapshot":
      out = await cmdSnapshot(windowIndex);
      break;
    case "click":
      out = await cmdClick(args[0], windowIndex);
      break;
    case "type":
      out = await cmdType(args[0], args[1], windowIndex);
      break;
    case "press":
      out = await cmdPress(args[0], windowIndex);
      break;
    case "eval":
      out = await cmdEval(args[0], windowIndex);
      break;
    case "screenshot":
      out = await cmdScreenshot(args[0], windowIndex);
      break;
    case "opened":
      out = await cmdOpened();
      break;
    case "close":
      out = await cmdClose();
      break;
    default:
      console.error(
        "usage: drive.mjs launch|windows|snapshot [--window N]|click <selector|text=...>|type <selector> <text>|press <key>|eval <js>|screenshot <path>|opened|close",
      );
      process.exit(1);
  }

  if (typeof out === "string") {
    console.log(out);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}

main().catch((err) => {
  console.error(`drive: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
