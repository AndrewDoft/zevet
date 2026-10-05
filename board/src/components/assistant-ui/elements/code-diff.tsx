"use client";

import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { codeScroll, codeSurface, mono, paper } from "./surfaces";
import { authorChangeTokens } from "@/lib/change-colors.mjs";

export type DiffKind = "context" | "added" | "removed";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

const GUTTER: Record<DiffKind, string> = {
  context: "",
  added: "+",
  removed: "−",
};

export function CodeDiff({
  filename,
  additions,
  deletions,
  lines,
  cycle,
  author,
  roster = [],
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "filename" | "additions" | "deletions" | "lines" | "cycle" | "author" | "roster"
> & {
  filename: string;
  additions: number;
  deletions: number;
  lines: readonly DiffLine[];
  cycle: number;
  author?: string;
  roster?: readonly { actor: string }[];
}) {
  const addedStyle = authorChangeTokens(author, roster, "added");
  const removedStyle = authorChangeTokens(author, roster, "removed");
  return (
    <div
      data-slot="code-diff"
      className={cn(
        paper,
        "w-full max-w-md overflow-hidden rounded-2xl font-mono text-xs",
        className,
      )}

      {...props}
    >
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <span className="text-foreground/90">{filename}</span>
        <span className={cn(mono, "tabular-nums")}>
          <span style={addedStyle} className="text-[color:var(--change-fg)]">
            +{additions}
          </span>{" "}
          <span style={removedStyle} className="text-[color:var(--change-fg)]">−{deletions}</span>
        </span>
      </div>
      <div className={codeScroll}>
        <div className={codeSurface}>
          {lines.map((line, i) => (
            <div
              key={`${cycle}-${i}-${line.text}`}
              className={cn(
                "fade-in animate-in fill-mode-both flex px-4 py-0.5 leading-relaxed whitespace-pre duration-300",
                line.kind === "context" && "text-foreground/45",
                line.kind === "added" && "text-[color:var(--change-fg)]",
                line.kind === "removed" && "text-[color:var(--change-fg)]",
              )}
              style={{ ...(line.kind === "removed" ? removedStyle : addedStyle), backgroundColor: "var(--change-bg)", animationDelay: `${i * 60}ms` }}
            >
              <span className="w-4 shrink-0 select-none">
                {GUTTER[line.kind]}
              </span>
              <span>{line.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
