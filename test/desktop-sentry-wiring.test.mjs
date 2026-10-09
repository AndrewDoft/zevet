// Sentry wiring in main.js and preload.js, asserted against SOURCE TEXT —
// same precedent as test/desktop-bridges.test.mjs and test/desktop-packaging
// .test.mjs: importing main.js under plain `node --test` throws on
// `require("electron")` before a single line of it runs, so there is no way
// to exercise `Sentry.init` for real here. What IS worth locking down at this
// level: the init call happens before any window, every agent-launch call
// site is wrapped rather than a few of them, the exact-pinned dependency
// electron-builder needs to package is declared, and the ZEVET_SENTRY_TEST
// trigger actually reaches both processes.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = path.join(ROOT, "desktop");
const main = readFileSync(path.join(DESKTOP, "main.js"), "utf8");
const preload = readFileSync(path.join(DESKTOP, "preload.js"), "utf8");
const setupHtml = readFileSync(path.join(DESKTOP, "setup.html"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(DESKTOP, "package.json"), "utf8"));

describe("the dependency electron-builder must package", () => {
  test("@sentry/electron is an exact-pinned runtime dependency, not a devDependency", () => {
    const version = pkg.dependencies && pkg.dependencies["@sentry/electron"];
    assert.ok(version, "@sentry/electron is missing from desktop/package.json dependencies");
    assert.match(version, /^\d+\.\d+\.\d+$/, `not pinned to an exact version: ${version}`);
    assert.ok(
      !(pkg.devDependencies && pkg.devDependencies["@sentry/electron"]),
      "a devDependency would not ship in the packaged app",
    );
  });

  test("desktop/sentry.js is in build.files", () => {
    assert.ok(pkg.payload.files.includes("sentry.js"), "sentry.js was added but never told to electron-builder");
  });
});

describe("main.js: init before any window, tagged from the start", () => {
  test("the shell's stuck-payload reporter uses initialized and scrubbed Sentry", () => {
    const reporter = main.indexOf("bootShell.reportPayloadStuck =");
    assert.ok(reporter > main.indexOf("sentry.initMain("));
    assert.match(main.slice(reporter, reporter + 140), /sentry\.capturePayloadStuck\(Sentry, details\)/);
  });
  test("Sentry.init runs before app.whenReady, not inside it", () => {
    const initIdx = main.indexOf("sentry.initMain(");
    const readyIdx = main.indexOf("app.whenReady()");
    assert.ok(initIdx > 0, "sentry.initMain(...) call not found");
    assert.ok(readyIdx > 0, "app.whenReady() not found");
    assert.ok(initIdx < readyIdx, "Sentry must be initialized before app.whenReady, to catch startup failures too");
  });

  test("the release name and platform/arch/member tags are supplied", () => {
    const idx = main.indexOf("sentry.initMain(");
    const block = main.slice(idx, main.indexOf("}", main.indexOf("tags:", idx)) + 1);
    assert.match(block, /release: sentry\.releaseName\(APP_VERSION\)/);
    assert.match(block, /platform: process\.platform/);
    assert.match(block, /arch: process\.arch/);
    assert.match(block, /member:/);
  });

  test("ZEVET_SENTRY_TEST=1 sends the test message from main", () => {
    assert.match(main, /ZEVET_SENTRY_TEST.*===\s*"1"[\s\S]{0,40}sentry\.sendTestMessage\(Sentry\)/);
  });

  test("signing in corrects the member tag immediately, not just on next launch", () => {
    const idx = main.indexOf("function writeConfig(");
    const body = main.slice(idx, main.indexOf("\n}\n", idx));
    assert.match(body, /Sentry\.setTag\("member"/, "writeConfig does not refresh the member tag");
  });
});

describe("every agent launch is wrapped, not just some of them", () => {
  test("agentConsole.startConsole is only ever handed to the wrapper, never called directly", () => {
    const bare = main.match(/[^\w]agentConsole\.startConsole\b/g) || [];
    // Exactly one reference: the wrapper's own construction. Any other bare
    // use is a launch site that bypassed failure reporting.
    assert.equal(bare.length, 1, `expected exactly one bare agentConsole.startConsole (the wrapper build): ${bare.length}`);
  });

  test("the wrapper is used at every known launch site", () => {
    const uses = main.match(/instrumentedStartConsole/g) || [];
    // 1 definition + 3 Code launch sites (start, scheduled, resume/fork) + 3
    // chat providers (claude, codex, opencode) + 1 routed-console rung
    // (startZevetConsole) = 8.
    assert.equal(uses.length, 8, `instrumentedStartConsole reference count changed (${uses.length}) — a launch site may have been added or missed`);
  });
});

describe("auto-update failures reach Sentry, once per failure", () => {
  test("captureUpdateFailure is called on entry into the error phase", () => {
    const idx = main.indexOf("const appUpdater = new AppUpdater(");
    const block = main.slice(idx, main.indexOf("app.on(\"before-quit\"", idx));
    assert.match(block, /sentry\.captureUpdateFailure\(Sentry/);
    assert.match(block, /lastUpdatePhase !== "error"/, "must not fire on every repeated status poll");
  });
});

describe("the renderer test trigger reaches both windows", () => {
  test("the board URL carries &sentryTest=1 under the test flag", () => {
    assert.match(main, /sentryTestParam = process\.env\.ZEVET_SENTRY_TEST === "1" \? "&sentryTest=1" : ""/);
  });

  test("setup.html's query carries sentryTest too", () => {
    const idx = main.indexOf("setupWindow.loadFile(");
    const block = main.slice(idx, main.indexOf(");", idx));
    assert.match(block, /sentryTest: "1"/);
  });
});

describe("preload.js: a client per isolated realm", () => {
  test("the IPC bridge is hooked up for the page's own realm", () => {
    assert.match(preload, /shellRequire\("@sentry\/electron\/preload"\)/);
  });

  test("the preload realm gets its own client, tagged so it reads apart from the page", () => {
    const idx = preload.indexOf('shellRequire("@sentry/electron/renderer")');
    const block = preload.slice(idx, idx + 400);
    assert.match(block, /\.init\(\{\s*sendDefaultPii:\s*false\s*\}\)/);
    assert.match(block, /setTag\("realm",\s*"preload"\)/);
  });

  test("no dsn/release/environment passed to the renderer init — deprecated, and ignored, on this SDK version", () => {
    const idx = preload.indexOf('shellRequire("@sentry/electron/renderer")');
    const block = preload.slice(idx, idx + 400);
    assert.doesNotMatch(block, /dsn:/, "the renderer client never talks to Sentry directly; only main does");
  });
});

describe("setup.html: no bundler, so it forwards through preload instead", () => {
  test("preload exposes a narrow reportError/reportMessage bridge, not the raw Sentry client", () => {
    const idx = preload.indexOf('contextBridge.exposeInMainWorld("zevetSentry"');
    assert.ok(idx > 0, "zevetSentry bridge not found");
    const block = preload.slice(idx, idx + 1200);
    assert.match(block, /reportError:/);
    assert.match(block, /reportMessage:/);
    // Never a raw Error/object across the bridge: contextBridge's structured
    // clone does not reliably preserve either, so this must be built from
    // plain fields on the preload side.
    assert.match(block, /new Error\(/);
  });

  test("setup.html listens for uncaught errors and unhandled rejections", () => {
    assert.match(setupHtml, /addEventListener\("error"/);
    assert.match(setupHtml, /addEventListener\("unhandledrejection"/);
    assert.match(setupHtml, /window\.zevetSentry\.reportError/);
  });

  test("setup.html's own sentryTest query fires the same test message", () => {
    assert.match(setupHtml, /sentryTest.*===\s*"1"[\s\S]{0,120}reportMessage\("zevet sentry test"\)/);
  });
});

describe("preload.js requires @sentry/electron, so no window may sandbox it", () => {
  test("every window that loads preload.js sets sandbox: false", () => {
    const blocks = main.split("preload: path.join(__dirname, \"preload.js\")").slice(1);
    assert.ok(blocks.length >= 2);
    for (const b of blocks) assert.match(b.slice(0, 900), /sandbox: false/);
  });
});
