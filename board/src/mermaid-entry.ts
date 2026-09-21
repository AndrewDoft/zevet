/**
 * The `zevetMermaid` global: `beautiful-mermaid`, bundled alone.
 *
 * Why alone: `beautiful-mermaid` adds ~1.5 MB to board.js (measured: board.js
 * goes from 1,268,601 to 2,807,376 bytes the moment mermaid-diagram.tsx is
 * statically imported), and hub/server.mjs serves board.js with
 * `cache-control: no-store` — every board load, every transcript, whether or
 * not it contains a diagram. Same problem highlight.js already solved for the
 * syntax highlighter: a side bundle, fetched by a `<script>` tag only when a
 * ```mermaid block actually appears. See board/src/components/mermaid.tsx.
 *
 * A bare re-export: vite.mermaid.config.ts builds this in `lib` mode with
 * `name: "zevetMermaid"`, which is what turns this module's exports into
 * `window.zevetMermaid` — no manual `window.zevetMermaid = ...` needed (and
 * writing one here would race the wrapper's own assignment and lose).
 */
export { renderMermaidSVG } from "beautiful-mermaid";
