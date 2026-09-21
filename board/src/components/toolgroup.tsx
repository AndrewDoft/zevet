/**
 * The "N tool calls" dropdown on an assistant turn.
 *
 * THE TRIGGER IS BELOW THE CALLS, not above them. Open, the list can be dozens
 * of rows tall, and a trigger at the top is off screen by the time you want to
 * close it. At the bottom it is where the list ends, so it is both the last
 * thing you read and the thing that shuts it — and a running turn that adds
 * calls grows the list upward into the page, away from it.
 *
 * WHILE OPEN, IT FOLLOWS THE TURN. A new call (or a running one growing its
 * output) scrolls the trigger back into view. `nearest`, so it does nothing
 * when the end of the list is already on screen.
 */
import { useEffect, useRef, useState, type PropsWithChildren } from "react";
import type { ThreadGroupPart } from "./assistant-ui/elements/thread.aui";
import { ToolGroupContent, ToolGroupRoot, ToolGroupTrigger } from "./assistant-ui/elements/tool-group.aui";

export function TurnToolGroup({ group, children }: PropsWithChildren<{ group: ThreadGroupPart }>) {
  const [open, setOpen] = useState(false);
  const count = group.indices.length;
  const running = group.status.type === "running";
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  // A call arriving while open.
  useEffect(() => {
    if (open) trigger.current?.scrollIntoView({ block: "nearest" });
  }, [open, count]);

  // The list growing without a new call: a result landing, a card opening.
  useEffect(() => {
    const el = box.current;
    if (!open || !running || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => trigger.current?.scrollIntoView({ block: "nearest" }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, running]);

  return (
    <ToolGroupRoot variant="ghost" open={open} onOpenChange={setOpen}>
      <div ref={box}>
        <ToolGroupContent>{children}</ToolGroupContent>
      </div>
      <ToolGroupTrigger ref={trigger} count={count} active={running} />
    </ToolGroupRoot>
  );
}
