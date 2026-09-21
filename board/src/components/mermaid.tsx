/**
 * ```mermaid blocks, rendered through the side bundle at /mermaid.js.
 *
 * hub/public/mermaid.js is `beautiful-mermaid` alone — see
 * board/src/mermaid-entry.ts for why it is not part of board.js. This
 * component's whole job is: load that bundle once (a module-level promise, so
 * ten diagrams in one transcript trigger one `<script>` tag, not ten), and
 * fall back to the raw source — never an empty box or an error card — while
 * it is loading, if it fails to load, or if the code does not parse.
 */
import { useEffect, useState } from "react";
import { Diagram } from "./assistant-ui/elements/diagram";

export type MermaidProps = { code: string };

type Engine = { renderMermaidSVG: (code: string, options?: Record<string, unknown>) => string };

let bundlePromise: Promise<Engine> | null = null;

function loadBundle(): Promise<Engine> {
  if (window.zevetMermaid?.renderMermaidSVG) {
    return Promise.resolve(window.zevetMermaid as Engine);
  }
  if (!bundlePromise) {
    bundlePromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/mermaid.js";
      script.onload = () => {
        if (window.zevetMermaid?.renderMermaidSVG) resolve(window.zevetMermaid as Engine);
        else reject(new Error("/mermaid.js loaded but did not set window.zevetMermaid"));
      };
      script.onerror = () => reject(new Error("failed to load /mermaid.js"));
      document.head.appendChild(script);
    });
  }
  return bundlePromise;
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.25;

export function Mermaid({ code }: MermaidProps) {
  const [engine, setEngine] = useState<Engine | null>(
    window.zevetMermaid?.renderMermaidSVG ? (window.zevetMermaid as Engine) : null,
  );
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (engine) return;
    let cancelled = false;
    // Errors are swallowed here on purpose: the render below already falls
    // back to plain source when `engine` stays null, which is the whole of
    // what a failed load should do to the transcript.
    loadBundle().then((loaded) => {
      if (!cancelled) setEngine(loaded);
    }, () => {});
    return () => {
      cancelled = true;
    };
  }, [engine]);

  let svg: string | null = null;
  if (engine) {
    try {
      svg = engine.renderMermaidSVG(code, {
        bg: "var(--background)",
        fg: "var(--foreground)",
        muted: "var(--muted-foreground)",
        border: "var(--border)",
        accent: "var(--foreground)",
        transparent: true,
      });
    } catch {
      // Not yet parseable (e.g. a mid-stream, unclosed block) or genuinely
      // invalid mermaid — either way, plain source below.
      svg = null;
    }
  }

  if (!svg) {
    return (
      <pre className="overflow-x-auto p-4 text-sm">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <Diagram
      title="Diagram"
      zoom={zoom}
      onZoomIn={() => setZoom((z) => Math.min(ZOOM_MAX, z * ZOOM_STEP))}
      onZoomOut={() => setZoom((z) => Math.max(ZOOM_MIN, z / ZOOM_STEP))}
      onReset={() => setZoom(1)}
    >
      {/* ⚠️ INNERHTML, DELIBERATELY AND NARROWLY — same discipline as
          highlight.tsx. `code` is model output. `renderMermaidSVG`'s own
          renderer (board/node_modules/beautiful-mermaid/src/renderer.ts)
          passes every label, id and edge text through its own escapeXml /
          escapeAttr before it reaches a string, never emits <script> or
          <foreignObject>, and its one raw-tag feature — <b>/<i>/<u>/<s> — is
          parsed into a closed allowlist of tspan attributes rather than
          passed through. Checked directly in source, not assumed. */}
      {/* ⚠️ FIT THE SVG TO THE CARD. `renderMermaidSVG` emits an SVG at its
          own natural size — a five-node flowchart is about 900px wide — and
          dropped into the transcript column it hung out of both sides of its
          own card with the first and last nodes clipped. `[&>svg]` reaches
          the emitted element itself; `h-auto` keeps the aspect ratio while
          the width comes down, and the overflow rule means a genuinely huge
          diagram scrolls inside the card rather than over the conversation.
          Zoom still works: the Diagram chrome scales this whole box. */}
      <div
        className="overflow-auto [&>svg]:h-auto [&>svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </Diagram>
  );
}
