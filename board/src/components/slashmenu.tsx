/**
 * The `/` menu over the composer: type a slash and the commands appear,
 * filtered as you type.
 *
 * Out of flow (`absolute bottom-full`), like every other card on this row, so
 * opening it never moves the chat box. The catalog and the matching live in
 * lib/slash.mjs where the gate can test them; this file is only the view and
 * the keys.
 *
 * KEYS. Up/Down move, Tab completes, Escape closes. Enter completes too — but
 * only while the text is still a PREFIX of the highlighted command. Once the
 * composer holds exactly `/compact`, Enter has nothing left to complete and
 * falls through to Send, so choosing a command is not a two-Enter chore.
 */
import { ChatSurface } from "../lib/surface";
import { useAui, useAuiState } from "@assistant-ui/react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { selectActiveConsole, useBoard } from "../lib/board";
import { commandsFor, matchSlash, type SlashCommand } from "../lib/slash.mjs";
import { cn } from "@/lib/utils";

export function SlashMenu() {
  return useContext(ChatSurface) ? null : <SlashMenuCode />;
}

function SlashMenuCode() {
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const active = useBoard(selectActiveConsole);
  const launchAgent = useBoard((s) => s.launchAgent);
  const agent = active?.agent ?? launchAgent;
  const commands = useMemo(() => commandsFor(agent, active?.slashCommands), [agent, active?.slashCommands]);
  const matches = useMemo(() => matchSlash(text, commands), [text, commands]);

  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // A new query starts at the top, and un-dismisses: Escape closes THIS
  // query, not the feature.
  useEffect(() => {
    setIndex(0);
    if (dismissed !== null && dismissed !== text) setDismissed(null);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = matches.length > 0 && dismissed !== text;
  const chosen = matches[Math.min(index, matches.length - 1)];

  const complete = (c: SlashCommand) => aui.composer().setText(`/${c.name} `);

  // Latest state for the listener below, which is installed once.
  const live = useRef({ open, matches, chosen, text, complete });
  live.current = { open, matches, chosen, text, complete };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = live.current;
      const shell = root.current?.closest(".aui-composer-root");
      if (!s.open || !shell || !shell.contains(e.target as Node)) return;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === "ArrowDown") {
        stop();
        setIndex((i) => (i + 1) % s.matches.length);
      } else if (e.key === "ArrowUp") {
        stop();
        setIndex((i) => (i - 1 + s.matches.length) % s.matches.length);
      } else if (e.key === "Escape") {
        stop();
        setDismissed(s.text);
      } else if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && s.chosen && s.text !== `/${s.chosen.name}`)) {
        if (!s.chosen) return;
        stop();
        s.complete(s.chosen);
      }
    };
    // Capture: the composer's own Enter-to-send handler is on the textarea,
    // and would otherwise run first.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index, open]);

  return (
    <div ref={root} className="slash-anchor">
      {open ? (
        <div
          ref={listRef}
          role="listbox"
          aria-label="Commands"
          className="bg-popover text-popover-foreground border-foreground/10 absolute bottom-full left-0 z-50 mb-2 max-h-64 w-full max-w-md overflow-y-auto rounded-xl border p-1.5 shadow-lg"
        >
          {matches.map((c, i) => (
            <button
              key={c.name}
              type="button"
              role="option"
              aria-selected={i === index}
              data-active={i === index}
              // mousedown, not click: click fires after the textarea has lost focus.
              onMouseDown={(e) => {
                e.preventDefault();
                complete(c);
              }}
              onMouseEnter={() => setIndex(i)}
              className={cn(
                "flex w-full items-baseline gap-3 rounded-lg px-2.5 py-1.5 text-start text-sm",
                i === index && "bg-accent text-accent-foreground",
              )}
            >
              <span className="font-mono text-[13px]">/{c.name}</span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{c.description}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
