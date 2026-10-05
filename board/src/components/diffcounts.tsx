import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { mono } from "./assistant-ui/elements/surfaces";

/** "+N −N" in the author's colour. `style` is authorStyle(actor) — {} falls
 *  back to green/red. Zero counts are hidden unless `showZero` (a total). */
export function DiffCounts({
  added,
  removed,
  style,
  className,
  showZero,
}: {
  added?: number | null;
  removed?: number | null;
  style?: CSSProperties;
  className?: string;
  showZero?: boolean;
}) {
  const a = showZero ? added ?? 0 : added;
  const r = showZero ? removed ?? 0 : removed;
  const has = (n?: number | null) => Boolean(n) || (showZero && n === 0);
  return (
    <span className={cn(mono, "tabular-nums", className)} style={style}>
      {has(a) ? <span className="d-add">+{a}</span> : null}
      {has(a) && has(r) ? " " : null}
      {has(r) ? <span className="d-del">{"−" + r}</span> : null}
    </span>
  );
}
