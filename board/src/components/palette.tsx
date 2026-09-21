/**
 * A Ctrl/Cmd+K command palette over real store state — no separate "palette
 * data" to keep in sync, so a new console or workspace shows up for free.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CommandPalette,
  type PaletteCommand,
} from "./assistant-ui/elements/command-palette";
import {
  selectMyConsoles,
  selectStats,
  selectTheme,
  toggleSelection,
  useBoard,
} from "../lib/board";

const NO_KEYS: readonly string[] = [];

interface Entry {
  command: PaletteCommand;
  run: () => void;
}

export function Palette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  // One listener for both halves of the shortcut: opening needs a global
  // handler because there is nothing focused yet to attach to, and closing
  // on Escape rides the same listener rather than a second effect.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((o) => !o);
      } else if (event.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveId("");
      return;
    }
    // Focus the query input on open; the element doesn't expose a ref to it.
    containerRef.current?.querySelector("input")?.focus();
  }, [open]);

  const consoles = useBoard(selectMyConsoles);
  const localWorkspaces = useBoard((s) => s.localWorkspaces);
  const stats = useBoard(selectStats);
  const theme = useBoard(selectTheme);
  const setActiveConsole = useBoard((s) => s.setActiveConsole);
  const openLocalRoot = useBoard((s) => s.openLocalRoot);
  const openLauncher = useBoard((s) => s.openLauncher);
  const openSettings = useBoard((s) => s.openSettings);
  const setTheme = useBoard((s) => s.setTheme);

  const entries = useMemo<Entry[]>(() => {
    const threads: Entry[] = consoles.map((c) => ({
      command: {
        id: `thread:${c.key}`,
        // An empty model is the common case ("whatever the CLI picks"), and
        // `claude — ` with nothing after the dash reads as a truncation.
        label: c.model ? `${c.agent} — ${c.model}` : c.agent,
        group: "Threads",
        keys: NO_KEYS,
      },
      run: () => setActiveConsole(c.key),
    }));

    const repos: Entry[] = localWorkspaces.map((w) => ({
      command: {
        id: `repo:${w.dir}`,
        label: w.name || w.dir,
        group: "Repos",
        keys: NO_KEYS,
      },
      run: () => openLocalRoot(w.dir),
    }));

    // stats.lines has no timestamps, so "recently touched" is approximated
    // by files that currently show a diff (uncommitted = just written).
    const diffPaths = stats.diff ? Object.keys(stats.diff) : [];
    const rest = Object.keys(stats.lines).filter((p) => !diffPaths.includes(p));
    const files: Entry[] = [...diffPaths, ...rest].slice(0, 40).map((path) => ({
      command: { id: `file:${path}`, label: path, group: "Files", keys: NO_KEYS },
      run: () => toggleSelection(path),
    }));

    const actions: Entry[] = [
      {
        command: { id: "action:launch", label: "Start an agent", group: "Actions", keys: NO_KEYS },
        run: openLauncher,
      },
      {
        command: { id: "action:settings", label: "Settings", group: "Actions", keys: NO_KEYS },
        run: openSettings,
      },
      {
        command: {
          id: "action:theme",
          label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
          group: "Actions",
          keys: NO_KEYS,
        },
        run: () => setTheme(theme === "dark" ? "light" : "dark"),
      },
    ];

    return [...threads, ...repos, ...files, ...actions];
  }, [
    consoles,
    localWorkspaces,
    stats,
    theme,
    setActiveConsole,
    openLocalRoot,
    openLauncher,
    openSettings,
    setTheme,
  ]);

  if (!open) return null;

  const commands = entries.map((e) => e.command);
  const run = (id: string) => {
    entries.find((e) => e.command.id === id)?.run();
    setOpen(false);
  };

  return (
    <div
      className="fixed inset-0 isolate z-50 flex items-start justify-center bg-black/10 pt-[15vh] backdrop-blur-xs"
      onClick={() => setOpen(false)}
    >
      <div ref={containerRef} onClick={(event) => event.stopPropagation()}>
        <CommandPalette
          commands={commands}
          query={query}
          activeId={activeId}
          onQueryChange={setQuery}
          onActiveChange={setActiveId}
          onRun={run}
        />
      </div>
    </div>
  );
}
