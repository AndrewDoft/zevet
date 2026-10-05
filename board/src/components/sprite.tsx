import type { CSSProperties } from "react";
import { consoleSprite } from "../lib/roster.mjs";
import { hueOf, selectActiveConsole, useBoard } from "../lib/board";

/**
 * An agent's figure from `window.zevetSprites`, in its owner's colour,
 * holding the tool it is using right now.
 *
 * `scale` is the whole size control and it is an INTEGER: the figure is a pixel
 * grid (22x11 cells), so every cell lands on whole device pixels and stays
 * crisp. 3 is the size Andrew can read on the rail and in the conversation
 * header (66x33); 2 is the file-tree rider (44x22).
 *
 * ⚠️ THE ONE TRUSTED SOURCE. `spriteFor` returns first-party markup from our
 * own bundle (agent-sprites.js), so it is safe for `dangerouslySetInnerHTML`;
 * `title` is event-derived text and goes on a plain prop, never into the HTML.
 *
 * Colour comes from CSS: set `--who` on this element or an ancestor.
 */
export function Sprite({
  tool,
  kind,
  scale = 3,
  title,
  who,
  className = "agent-sprite",
}: {
  tool?: string | null;
  kind?: string;
  scale?: number;
  title?: string;
  /** A CSS colour (`var(--who-2)`); omitted, the figure inherits `--who`. */
  who?: string;
  className?: string;
}) {
  const z = window.zevetSprites;
  if (!z?.spriteFor) return null; // no bundle script, or a plain browser tab
  const w = (z.WIDTH ?? 22) * scale;
  const h = (z.HEIGHT ?? 11) * scale;
  const svg = z.spriteFor({ tool, kind, width: w, height: h });
  if (!svg) return null;
  return (
    <span
      className={className}
      role="img"
      aria-label={title || "Agent"}
      title={title}
      style={{ width: w, height: h, color: "var(--who)", ...(who ? { "--who": who } : {}) } as CSSProperties}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** The conversation header's figure: the console in front, when it is running. */
export function ActiveSprite() {
  const c = useBoard(selectActiveConsole);
  const me = useBoard((s) => s.myActor);
  if (!c || !c.running) return null;
  return <Sprite {...consoleSprite(c)} who={hueOf(me)} title="Running" className="agent-sprite agent-sprite-head" />;
}
