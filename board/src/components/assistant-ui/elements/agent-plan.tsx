"use client";

import type { ComponentProps } from "react";
import { CheckIcon, Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { mono } from "./surfaces";
import { pct, progressOf } from "../utils/range";

export function AgentPlan({
  steps,
  activeIndex,
  owners,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "steps" | "activeIndex"> & {
  steps: readonly string[];
  activeIndex: number;
  /** Who claimed each step (D-087), by index; "" for none. */
  owners?: readonly string[];
}) {
  const total = steps.length;
  const completed = progressOf(activeIndex, total);
  const allDone = completed >= total;
  const progress = pct(completed, total);
  const current = allDone ? "" : steps[completed] || steps[total - 1] || "";

  return (
    <div
      data-slot="agent-plan"
      className={cn("flex w-full max-w-sm flex-col gap-3", className)}

      {...props}
    >
      <details open={false}>
        <summary className="flex cursor-pointer list-none items-center justify-between">
          <span className="min-w-0 truncate text-[13.5px] font-medium">{current || "Plan"}</span>
          <span className={cn(mono, "ml-3 shrink-0 text-foreground/35 tabular-nums")}>
            {completed}/{total}
          </span>
        </summary>
      <div className="bg-foreground/[0.06] h-[3px] w-full overflow-hidden rounded-full">
        <span
          className="bg-foreground/80 block h-full rounded-full transition-[width] duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>
      <ul className="mt-3 flex flex-col gap-2.5">
        {steps.map((step, i) => {
          const done = allDone || i < completed;
          const active = !allDone && i === completed;
          return (
            <li key={step} className="flex items-center gap-2.5 text-[13.5px]">
              <span className="flex size-4 shrink-0 items-center justify-center">
                {done ? (
                  <CheckIcon className="text-foreground/35 size-3.5" />
                ) : active ? (
                  <Loader2Icon className="text-foreground/90 size-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <span
                    aria-hidden
                    className="bg-foreground/15 size-1.5 rounded-full"
                  />
                )}
              </span>
              <span
                className={cn(
                  done && "text-foreground/40",
                  active && "text-foreground/90",
                  !done && !active && "text-foreground/35",
                )}
              >
                {step}
              </span>
              {owners?.[i] ? (
                <span data-step-owner={owners[i]} className={cn(mono, "ml-auto shrink-0 text-foreground/45")}>
                  {owners[i]}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      </details>
    </div>
  );
}
