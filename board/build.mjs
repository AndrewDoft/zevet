#!/usr/bin/env node
/**
 * Bundles the React board into ../hub/public — board.js, board.css and a
 * regenerated index.html.
 *
 * Mission: the hub has no build step. It deploys by archive + extract + docker
 * restart and serves hub/public verbatim, so a bundle that is not committed is
 * a bundle that does not ship. Same contract as editor/build.mjs: build here,
 * commit the output, let the gate assert the committed bundle matches the
 * source tree.
 *
 * One deliberate difference from editor/: this also rewrites ../hub/public/
 * index.html, because the board page IS the app entry. The output is still
 * committed, and the existing script-tag side bundles (highlight.js,
 * agent-sprites.js, editor.js) are preserved untouched by vite.config.ts.
 *
 * This also runs the separate vite.mermaid.config.ts build, producing
 * ../hub/public/mermaid.js — the same "side bundle, fetched on demand" move
 * as highlight.js, kept out of the main build for the reason documented in
 * vite.config.ts's `inlineDynamicImports` comment: ONE board.js, always.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "src");
/** The hash of every source file that went into the bundle. Read by
 *  test/board-bundle.test.mjs to catch a committed bundle that drifted from
 *  the source tree without being rebuilt. */
const STAMP = path.join(HERE, "..", "hub", "public", "board.js.srchash");

try {
  await build({ configFile: path.join(HERE, "vite.config.ts") });
  await build({ configFile: path.join(HERE, "vite.mermaid.config.ts") });

  const srcHash = createHash("sha256");
  function hashDir(dir) {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) hashDir(full);
      else {
        srcHash.update(name);
        srcHash.update(readFileSync(full));
      }
    }
  }
  hashDir(SRC);
  writeFileSync(STAMP, srcHash.digest("hex") + "\n", "utf8");

  const out = path.join(HERE, "..", "hub", "public");
  console.log(`built ${path.relative(path.join(HERE, ".."), out)}`);
  for (const name of ["board.js", "board.css", "index.html", "board.js.srchash", "mermaid.js"]) {
    const bytes = readFileSync(path.join(out, name)).length;
    console.log(`  ${name} ${bytes} bytes`);
  }
} catch (err) {
  console.error("board build FAILED — hub/public was not updated.");
  console.error(err?.message ?? err);
  process.exit(1);
}