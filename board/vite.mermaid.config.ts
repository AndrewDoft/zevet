import { defineConfig } from "vite";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds hub/public/mermaid.js, the side bundle for ```mermaid rendering.
 * Beside vite.config.ts on purpose (see the comment there on why the main
 * board build must stay one file) — this is the second, deliberate exception,
 * built and served the same way highlight.js and editor.js already are.
 */
export default defineConfig({
  build: {
    outDir: "../hub/public",
    emptyOutDir: false,
    // No source map, matching highlight.js/agent-sprites.js: those bundles
    // have no drift-check test either, because unlike board.js/editor.js
    // there is no other source tree it could silently fall out of sync with.
    sourcemap: false,
    lib: {
      entry: path.resolve(dirname(fileURLToPath(import.meta.url)), "src/mermaid-entry.ts"),
      name: "zevetMermaid",
      formats: ["iife"],
      fileName: () => "mermaid.js",
    },
  },
});
