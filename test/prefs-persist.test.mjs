// Board defaults and wiring around board/src/lib/prefs-mirror.mjs. The pure
// merge/mirror logic is tested directly in test/prefs-mirror.test.mjs; this
// pins the plumbing that connects it to the store and to startup — the part
// that would break silently (a typo, a wrong import order) with nothing else
// to catch it. Same style as test/roster.test.mjs and test/board-theme.test.mjs.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const src = (file) => readFileSync(path.join(ROOT, "board", "src", file), "utf8");
const board = src("lib/board.ts");
const bridge = src("lib/bridge.ts");
const main = src("main.tsx");

describe("new users land on Agent view; an existing choice survives", () => {
  test("the store seeds viewMode from the saved pref, defaulting to agent", () => {
    assert.ok(
      board.includes('viewMode: (pref("view", "agent") === "ide" ? "ide" : "agent") as ViewMode'),
      "viewMode no longer defaults new users to agent, or stopped honouring an existing ide choice",
    );
  });
});

describe("the launch model and posture last picked in the composer persist", () => {
  test("both seed their initial state from the saved pref", () => {
    assert.ok(board.includes('launchModel: pref("launchModel", "")'), "launchModel no longer restores across a reload");
    assert.ok(board.includes('pref("launchMode", "auto")'), "launchMode no longer restores across a reload");
    assert.ok(board.includes("MODES.some((m) => m.id === saved)"), "a stale/bad saved launchMode is no longer guarded");
  });

  test("both setters persist the pick, not just the in-memory state", () => {
    assert.match(
      board,
      /setLaunchMode:\s*\(m\)\s*=>\s*\{\s*setPref\("launchMode",\s*m\);\s*set\(\{\s*launchMode:\s*m\s*\}\);\s*\}/,
      "setLaunchMode no longer saves the pick",
    );
    assert.match(
      board,
      /setLaunchModel:\s*\(m\)\s*=>\s*\{\s*setPref\("launchModel",\s*m\);\s*set\(\{\s*launchModel:\s*m\s*\}\);\s*\}/,
      "setLaunchModel no longer saves the pick",
    );
  });
});

describe("every zevet.* preference goes through the mirrored store", () => {
  test("board.ts no longer touches window.localStorage directly", () => {
    assert.ok(!/\blocalStorage\b/.test(board), "a raw localStorage call reappeared in board.ts — route it through zStorage");
  });

  test("bridge.ts exports zStorage, backed by the desktop mirror", () => {
    assert.ok(bridge.includes('import { mirroredStorage } from "./prefs-mirror.mjs";'), "zStorage no longer wraps prefs-mirror.mjs");
    assert.ok(
      bridge.includes("export const zStorage = mirroredStorage(window.localStorage, () => bridge.local);"),
      "zStorage no longer mirrors through bridge.local",
    );
  });

  test("the desktop bridge type carries the prefs mirror pair", () => {
    assert.match(bridge, /prefs\?:\s*\(\)\s*=>\s*Promise<Record<string,\s*string>>/);
    assert.match(bridge, /setPref\?:\s*\(key:\s*string,\s*value:\s*string \| null\)\s*=>\s*Promise<unknown>/);
  });
});

describe("startup hydrates the mirror before the store reads its initial state", () => {
  test("main.tsx awaits hydratePrefsMirror before importing ./App or ./lib/board", () => {
    const hydrateAt = main.indexOf("await hydratePrefsMirror(");
    const appAt = main.indexOf('import("./App")');
    const boardAt = main.indexOf('import("./lib/board")');
    assert.ok(hydrateAt >= 0, "main.tsx no longer hydrates the prefs mirror");
    assert.ok(appAt >= 0, "main.tsx no longer lazily imports ./App");
    assert.ok(hydrateAt < appAt, "the mirror must be hydrated before ./App (and lib/board with it) is imported");
    if (boardAt >= 0) assert.ok(hydrateAt < boardAt, "the dev fixture branch imports lib/board before the mirror is hydrated");
  });
});
