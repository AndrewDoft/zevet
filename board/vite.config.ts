import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

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