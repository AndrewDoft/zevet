// The committed board bundle must match the source it was built from.
//
// ⚠️ WHY THIS EXISTS. `board/build.mjs` has claimed since it was written that
// "test/board-bundle.test.mjs" reads its stamp. That file did not exist. So the
// board had exactly the hole editor-bundle.test.mjs was written to close, and
// nothing watching it: `hub/public/board.js` is a megabyte of generated code
// COMMITTED to git, because the hub has no build step — it deploys by archive,
// extract and docker restart, and serves hub/public verbatim.
//
// The failure is: edit board/src, forget `node build.mjs`, commit. The diff
// shows the new source, the hub serves the old behaviour, and everything is
// green.
//
// It hashes the INPUTS rather than rebuilding, because rebuilding needs
// board/node_modules, which the gate does not install.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const SRC = path.join(ROOT, "board", "src");
const PUBLIC = path.join(ROOT, "hub", "public");
const BUNDLE = path.join(PUBLIC, "board.js");
const STAMP = path.join(PUBLIC, "board.js.srchash");

/** The same walk board/build.mjs does, and it has to stay the same one. */
function hashSources() {
  const h = createHash("sha256");
  (function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        h.update(name);
        h.update(readFileSync(full));
      }
    }
  })(SRC);
  return h.digest("hex");
}

describe("the committed board bundle", () => {
  test("the bundle, its map and its stylesheet are present", () => {
    assert.ok(existsSync(BUNDLE), "hub/public/board.js is missing — run `node build.mjs` in board/");
    assert.ok(existsSync(`${BUNDLE}.map`), "the source map is missing");
    assert.ok(existsSync(path.join(PUBLIC, "board.css")), "hub/public/board.css is missing");
  });

  test("it was built from the source that is in the tree", () => {
    assert.ok(existsSync(STAMP), "hub/public/board.js.srchash is missing — run `node build.mjs` in board/");
    assert.equal(
      hashSources(),
      readFileSync(STAMP, "utf8").trim(),
      "board/src has changed since the bundle was built.\n" +
        "        Run `node build.mjs` in board/ and commit hub/public/board.js,\n" +
        "        board.js.map, board.css and board.js.srchash together.",
    );
  });

  test("index.html loads the bundle the build wrote", () => {
    const html = readFileSync(path.join(PUBLIC, "index.html"), "utf8");
    assert.match(html, /src="\/board\.js"/);
    assert.match(html, /href="\/board\.css"/);
    // The side bundles are not built by vite and must survive it rewriting
    // the page — losing one is silent, and the editor simply never appears.
    for (const side of ["highlight.js", "agent-sprites.js", "editor.js"]) {
      assert.ok(html.includes(side), `index.html no longer loads ${side}`);
    }
  });
});

describe("the dev fixture does not ship", () => {
  // board/src/lib/fixture.ts installs a fake desktop bridge so the board's
  // interior can be looked at without running a real agent. It is guarded by
  // import.meta.env.DEV, which is a build-time constant, so rollup drops it —
  // but "should be dropped" and "is not in the file" are different claims, and
  // this is the one that matters. A fixture that shipped would let anyone who
  // can put ?dev=1 on the URL replace the desktop bridge.
  const bundle = readFileSync(BUNDLE, "utf8");

  for (const symbol of ["installFixtureBridge", "__zevet_fixture_bridge__", "CLAUDE_SCRIPT", "some_future_event"]) {
    test(`${symbol} is absent from the shipped bundle`, () => {
      assert.ok(!bundle.includes(symbol), `${symbol} leaked into hub/public/board.js`);
    });
  }

  test("the guard is still a build-time constant, not a runtime check", () => {
    // `if (import.meta.env.DEV)` is what rollup can fold away. A refactor to
    // `const dev = import.meta.env.DEV; if (dev)` still works in dev and stops
    // being eliminated, which is how the fixture would quietly start shipping.
    const main = readFileSync(path.join(ROOT, "board", "src", "main.tsx"), "utf8");
    assert.match(main, /if \(import\.meta\.env\.DEV\) \{/);
  });
});
