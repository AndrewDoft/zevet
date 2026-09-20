import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";

function dedupeCssLink(): Plugin {
  return {
    name: "dedupe-css-link",
    transformIndexHtml(html) {
      return html.replace('<link rel="stylesheet" crossorigin href="/board.css">', "");
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), dedupeCssLink()],
  base: "/",
  /* The `@/*` alias exists in tsconfig.json and did NOT exist here, so tsc was
   * happy and vite could not resolve a single `@/...` import. The registry
   * writes every component against that alias, so nothing from it would have
   * built. */
  resolve: {
    alias: { "@": path.resolve(dirname(fileURLToPath(import.meta.url)), "src") },
  },
  /* `npm run dev` against a hub you are running locally:
   *     ZEVET_TOKEN=<anything> node hub/server.mjs
   *     cd board && npm run dev
   * Everything the page needs that vite does not build — the event stream, the
   * auth probe, the side bundles and the fonts — is proxied to it. Without this
   * the dev server serves a page that renders once and then sits there
   * disconnected, which is not a thing worth looking at.
   * ws:true because /events is an SSE stream and /ws is a WebSocket. */
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/auth": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/events": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/ws": { target: "http://127.0.0.1:8787", ws: true },
      "/fonts": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/highlight.js": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/agent-sprites.js": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/editor.js": { target: "http://127.0.0.1:8787", changeOrigin: true },
      /* The hub exchanges `?token=` for an HttpOnly cookie on `/` and only on
       * `/`, and in dev `/` is vite's page, not the hub's — so the exchange
       * never happened and every request came back 401. Open
       * http://localhost:5173/__dev-auth?token=<ZEVET_TOKEN> once; the hub
       * redirects to `/` with the cookie set for the dev origin. */
      "/__dev-auth": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/__dev-auth/, "/"),
      },
    },
  },
  build: {
    outDir: "../hub/public",
    emptyOutDir: false,
    sourcemap: true,
    codeSplitting: false,
    rollupOptions: {
      input: "index.html",
      output: {
        entryFileNames: "board.js",
        chunkFileNames: "board.js",
        assetFileNames: (info) => {
          if (info.name && /\.css$/.test(info.name)) return "board.css";
          return "board-assets/[name][extname]";
        },
      },
    },
  },
});