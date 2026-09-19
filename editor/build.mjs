#!/usr/bin/env node
/**
 * Bundles src/index.js to ../hub/public/editor.js.
 *
 * This is the first bundler in a repository that is otherwise proudly
 * zero-dependency, and it is deliberately the smallest one that could work:
 * one esbuild call, no config file, no plugins, no watch mode. The output is
 * committed to git, because the hub has no build step — it deploys by
 * `git pull && docker restart` and serves hub/public as plain static files.
 * A bundle that is not committed is a bundle that is not deployed.
 *
 * Run it with `npm run build` from editor/.
 */
import { build } from "esbuild";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, "src", "index.js");
const OUT = path.join(HERE, "..", "hub", "public", "editor.js");

// esbuild resolves nothing by itself on failure — it throws, and an unhandled
// rejection in an ESM entry point exits non-zero on its own. But relying on
// that means the failure prints a stack trace with no statement of WHICH thing
// failed, and this script is going to be run by someone who does not otherwise
// think about bundlers. So it is caught, named, and re-exited explicitly.
//
// The gate (scripts/gate.sh) does NOT run this. It runs the test suite, and the
// test suite asserts on the committed artefact. So a failure here that exits 0
// would mean committing a stale editor.js against a changed src/ — silently.
// That is the specific bad outcome the explicit exit(1) below prevents.
try {
  const result = await build({
    entryPoints: [ENTRY],
    outfile: OUT,
    bundle: true,
    minify: true,
    sourcemap: true, // emits hub/public/editor.js.map, also committed
    format: "iife",

    // The board is a plain script-tag page: `window.zevetEditor.createEditor(...)`.
    // It is NOT a module page, and making it one is out of scope for this task.
    globalName: "zevetEditor",

    // es2022 because the hub's audience is current Chrome/Safari/Firefox on
    // developer machines. Lowering further would inflate a bundle that is
    // already the largest file in the repository, for browsers nobody here has.
    target: "es2022",
    platform: "browser",

    // Yjs and lib0 both branch on process.env.NODE_ENV. Without this, the
    // bundle carries a `process` reference that does not exist in a browser and
    // throws on load — the failure mode is a blank editor and a ReferenceError,
    // which is exactly the kind of thing a committed bundle must not ship with.
    define: { "process.env.NODE_ENV": '"production"' },

    // Not a legal notice we are stripping: esbuild's default keeps every
    // /*! */ comment, which in this dependency set is several kilobytes of
    // duplicated MIT text. The licences are recorded in editor/package.json's
    // dependency list and in editor/node_modules at build time; see README.md.
    legalComments: "none",

    logLevel: "warning",
    metafile: true,
  });

  for (const warning of result.warnings ?? []) {
    console.warn(`warning: ${warning.text}`);
  }

  const bytes = statSync(OUT).size;
  const mapBytes = statSync(`${OUT}.map`).size;
  console.log(`built ${path.relative(path.join(HERE, ".."), OUT)}`);
  console.log(`  ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB) minified`);
  console.log(`  ${mapBytes} bytes source map`);
} catch (err) {
  console.error("editor build FAILED — hub/public/editor.js was not updated.");
  console.error(err?.message ?? err);
  process.exit(1);
}
