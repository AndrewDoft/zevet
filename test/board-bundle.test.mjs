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

describe("the build emits one bundle, not a chunk farm", () => {
  // ⚠️ NEARLY SHIPPED. The hub serves an exact-name allowlist — board.js,
  // board.js.map, board.css — with no directory listing anywhere, on purpose.
  // Adding react-syntax-highlighter's async Prism made the build emit 486
  // chunk files that the page then asked for by <link rel=modulepreload>. The
  // hub would have 404'd every one: a board that loads and does nothing.
  //
  // `build.codeSplitting: false` was already set and is not the option that
  // governs it. `output.inlineDynamicImports` is.
  const served = new Set(["board.js", "board.js.map", "board.css", "board.js.srchash"]);

  test("hub/public has no extra board chunks", () => {
    const strays = readdirSync(PUBLIC).filter((n) => /^board.+\.js(\.map)?$/.test(n) && !served.has(n));
    assert.deepEqual(strays, [], `the build emitted chunks the hub does not serve:\n        ${strays.join("\n        ")}`);
  });

  test("index.html preloads nothing the hub cannot serve", () => {
    const html = readFileSync(path.join(PUBLIC, "index.html"), "utf8");
    for (const href of [...html.matchAll(/href="\/([^"]+)"/g)].map((m) => m[1])) {
      const known = served.has(href) || ["board.css", "highlight.js", "agent-sprites.js", "editor.js"].includes(href);
      assert.ok(known, `index.html references /${href}, which is not in the hub's allowlist`);
    }
  });

  test("the config still forces a single bundle", () => {
    const cfg = readFileSync(path.join(ROOT, "board", "vite.config.ts"), "utf8");
    assert.match(cfg, /inlineDynamicImports:\s*true/);
  });
});

describe("only one syntax highlighter ships", () => {
  // The board already loads hub/public/highlight.js, a committed side bundle
  // with its own gate test. Wiring the registry's Prism component in brought a
  // SECOND engine: 1,339 kB of highlight.js plus 939 kB of refractor, taking
  // the bundle to 2.77 MB. components/highlight.tsx fills the same slot with
  // the engine that was already on the page.
  //
  // ⚠️ THIS USED TO ASSERT THE PACKAGE WAS NOT INSTALLED, and that was the
  // wrong line to hold. 0.2.16 installs the registry's syntax-highlighter and
  // shiki-highlighter items — both were asked for by name — so their packages
  // are in package.json and their files are in the tree, where tsc needs the
  // types to compile them. What must never happen is either engine reaching
  // the BUNDLE, and that is a fact about the build, not about package.json.
  // test/elements.test.mjs is the other half: it requires both files to stay
  // in the unrendered ledger with the reason.
  test("no second engine is in the bundle", () => {
    const map = JSON.parse(readFileSync(`${BUNDLE}.map`, "utf8"));
    const engines = (map.sources || []).filter((s) =>
      /node_modules[\/](refractor|highlight\.js|shiki|@shikijs|react-shiki|react-syntax-highlighter)[\/]/.test(s),
    );
    assert.deepEqual(engines.slice(0, 3), [], `a second highlighting engine is in the bundle (${engines.length} modules)`);
  });

  test("nothing the board reaches imports one", () => {
    // The bundle check above only sees what the last build produced. This one
    // fails the moment somebody imports the registry highlighters, before a
    // rebuild has had the chance to hide it in a megabyte of minified output.
    const board = path.join(ROOT, "board", "src");
    const skip = new Set(["syntax-highlighter.tsx", "shiki-highlighter.tsx", "shiki-highlighter.aui.tsx"]);
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(tsx?|mts|mjs)$/.test(name) && !skip.has(name)) {
          const src = readFileSync(full, "utf8");
          for (const engine of ["react-syntax-highlighter", "react-shiki"]) {
            assert.ok(
              !src.includes(`"${engine}"`),
              `${path.relative(ROOT, full)} imports ${engine}; components/highlight.tsx is the one highlighter`,
            );
          }
        }
      }
    };
    walk(board);
  });

  test("the mermaid engine is a side bundle, not part of board.js", () => {
    // Same argument, measured: statically importing the registry's mermaid
    // element took board.js from 1.27 MB to 2.81 MB, on a route the hub serves
    // with `cache-control: no-store`. hub/public/mermaid.js is fetched only
    // when a ```mermaid block actually appears.
    const map = JSON.parse(readFileSync(`${BUNDLE}.map`, "utf8"));
    const inBundle = (map.sources || []).filter((s) => /node_modules[\/]beautiful-mermaid[\/]/.test(s));
    assert.deepEqual(inBundle, [], "beautiful-mermaid is in board.js; it belongs in hub/public/mermaid.js");
    assert.ok(
      statSync(path.join(ROOT, "hub", "public", "mermaid.js"), { throwIfNoEntry: false })?.isFile(),
      "hub/public/mermaid.js is missing — run `node build.mjs` in board/ and commit it",
    );
  });
});

describe("no shipped sentence claims something untrue about zevet", () => {
  // The registry is written for chat products with a server-side run loop.
  // zevet's hub relays events and runs nothing, and the agents are on people's
  // own machines — so some of that copy is not a style difference, it is a
  // false statement about where somebody's code is executing.
  //
  // board/scripts/sync-registry.mjs re-applies the corrections after every
  // re-install. This is what notices when one of them silently did not.
  const bundle = readFileSync(BUNDLE, "utf8");

  const FALSE_CLAIMS = [
    ["The run kept going on the server", "zevet's hub runs nothing; the agent is on the user's own machine"],
  ];

  for (const [claim, why] of FALSE_CLAIMS) {
    test(`"${claim}" is not in the bundle`, () => {
      assert.ok(!bundle.includes(claim), `${why}\n        Run \`node scripts/sync-registry.mjs\` in board/ and rebuild.`);
    });
  }

  test("the correction is actually present, not just the claim absent", () => {
    // Absence alone would also pass if the component were dropped entirely.
    assert.ok(bundle.includes("Lost the hub. Your agents keep running on their own machines."));
  });
});
