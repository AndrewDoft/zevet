/**
 * Transcript code blocks, highlighted by the highlighter the board already has.
 *
 * The registry ships `elements/syntax-highlighter.tsx`, which is Prism via
 * `react-syntax-highlighter`. Wiring it in cost 2.3 MB of source — 1,339 kB of
 * `highlight.js` and 939 kB of `refractor`, two complete highlighting engines,
 * in a board that already loads its own as a committed side bundle
 * (`hub/public/highlight.js`, built from `editor/`, with `highlight.test.mjs`
 * in the gate). Deep-importing the Prism-only entry did not shake either of
 * them out.
 *
 * So this is the registry's component with zevet's engine behind it. Same
 * contract — it plugs into `memoizeMarkdownComponents` as `SyntaxHighlighter`
 * — and no second engine. The one thing it does NOT do is match the registry's
 * light/dark Prism themes, because `zevetHighlight` emits `--syntax-*` tokens
 * which masora.css already defines for both themes.
 *
 * ⚠️ INNERHTML, DELIBERATELY AND NARROWLY. `zevetHighlight.highlight` is the
 * same function the file viewer has always used this way; it escapes the text
 * it is given and emits only `<span class="tok-*">`. The input here is model
 * output, so that escaping is load-bearing — this is the reason
 * `test/highlight.test.mjs` exists and asserts it. If the highlighter is not
 * on the page at all, the code renders as plain text rather than as markup.
 */
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import { Mermaid } from "./mermaid";

export function SyntaxHighlighter({ components, language, code }: SyntaxHighlighterProps) {
  const { Pre, Code } = components;
  const engine = window.zevetHighlight;

  /* ```mermaid is a DRAWING, not a listing. Agents emit these constantly —
     "here is the flow", "here is the schema" — and highlighting the source of
     one is answering a different question than the agent was answering. This
     is the one branch where the block is rendered rather than coloured.
     The registry's own MermaidDiagram statically imports `beautiful-mermaid`,
     which is ~1.5 MB and would ship in board.js on every load (measured:
     1,268,601 -> 2,807,376 bytes) even though most transcripts never contain
     a diagram. `./mermaid` is zevet's own component — same shape as this
     file's engine, a committed side bundle at hub/public/mermaid.js fetched
     only when this branch actually runs. */
  if ((language || "").toLowerCase() === "mermaid") {
    return <Mermaid code={code} />;
  }

  if (!engine || typeof engine.highlight !== "function") {
    return (
      <Pre>
        <Code>{code}</Code>
      </Pre>
    );
  }

  let html: string;
  try {
    html = engine.highlight(code, language || "plain");
  } catch {
    // A language the engine does not know, or malformed input. Plain text is
    // the right answer; a transcript that drops a code block is not.
    return (
      <Pre>
        <Code>{code}</Code>
      </Pre>
    );
  }

  return (
    <Pre>
      <Code dangerouslySetInnerHTML={{ __html: html }} />
    </Pre>
  );
}
