/**
 * Standing instructions for the open repo, and the capabilities an agent
 * started here is given — settings that live per-repo (`s.agentSettings`,
 * read/written through desktop's `local:agentSettings`), not in the board's
 * own preferences. Built on elements/settings-panel.tsx.
 *
 * Renders nothing without a desktop bridge or an open repo, and nothing
 * before `s.agentSettings` has actually loaded: a build that lacks the
 * capability leaves it null forever, and refreshAgentSettings()'s own comment
 * in board.ts says the same — no panel at all beats one that looks like it
 * saves and does not.
 */
import { useEffect, useRef, useState } from "react";
import { SettingsPanel, type SettingToggle } from "./assistant-ui/elements/settings-panel";
import { bridge } from "../lib/bridge";
import {
  saveAgentSettings,
  selectActiveConsole,
  selectTheme,
  selectViewMode,
  useBoard,
} from "../lib/board";

export function AgentSettings() {
  const localRoot = useBoard((s) => s.localRoot);
  const agentSettings = useBoard((s) => s.agentSettings);
  const active = useBoard(selectActiveConsole);
  const launchModel = useBoard((s) => s.launchModel);
  const theme = useBoard(selectTheme);
  const viewMode = useBoard(selectViewMode);
  const setTheme = useBoard((s) => s.setTheme);
  const setView = useBoard((s) => s.setView);

  // Local draft + a short debounce, so typing isn't a save-to-disk per
  // keystroke and the textarea isn't a controlled value that snaps back
  // between the keystroke and the async round trip through the bridge.
  const [draft, setDraft] = useState(agentSettings?.systemPrompt ?? "");
  const savedRef = useRef(agentSettings?.systemPrompt ?? "");
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    setDraft(agentSettings?.systemPrompt ?? "");
    savedRef.current = agentSettings?.systemPrompt ?? "";
  }, [agentSettings?.systemPrompt]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  if (!bridge.local || !localRoot || !agentSettings) return null;

  // ponytail: plain setTimeout debounce, not a save queue — one textarea,
  // one field. Revisit if agentSettings grows more free text that needs it.
  function onSystemPromptChange(next: string) {
    setDraft(next);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      if (next !== savedRef.current) {
        savedRef.current = next;
        void saveAgentSettings({ systemPrompt: next });
      }
    }, 500);
  }

  // Model: read-only. `AgentSettings` (the store type) has no model field —
  // there is nowhere here to save a choice to. The real picker is
  // model-choice.tsx's ModelSelector: grouped per CLI, searchable, carrying
  // codex's reasoning effort. This panel's model row is a flat single-select
  // with none of that; wiring it to change anything would be a second,
  // divergent picker rather than an honest one. So it shows the one true
  // fact — what's actually running here, or what the launcher will use next —
  // with nothing to click.
  const model = (active && (active.usage.model || active.model)) || launchModel || "default";

  // followMode ("mine" | "all" | "off") is a real, persisted setting too, but
  // it is three-way. A switch has two positions; showing it as one would mean
  // "off" either reads as "on" or can't be reached at all, and that is
  // inventing behavior the control doesn't have. Left out rather than lying
  // about it. `s.conn` was also considered and rejected — that's the hub
  // connection, state nobody chose, not a setting.
  const toggles: SettingToggle[] = [
    {
      key: "computerUse",
      label: "Computer use",
      detail:
        "Gives the agent zevet's own MCP server for this machine: it can see the screen and move the mouse. Off unless turned on here.",
      on: agentSettings.computerUse,
    },
    {
      key: "agentView",
      label: "Agent view",
      detail: "Agent conversations with a compact editor, instead of files and the IDE layout.",
      on: viewMode === "agent",
    },
    {
      key: "darkTheme",
      label: "Dark theme",
      detail: "The board's own color theme. Nothing the agent sees.",
      on: theme === "dark",
    },
  ];

  function onToggle(key: string) {
    if (key === "computerUse") void saveAgentSettings({ computerUse: !agentSettings!.computerUse });
    else if (key === "agentView") setView(viewMode === "agent" ? "ide" : "agent");
    else if (key === "darkTheme") setTheme(theme === "dark" ? "light" : "dark");
  }

  return (
    <SettingsPanel
      className="max-w-none"
      model={model}
      models={[model]}
      systemPrompt={draft}
      onSystemPromptChange={onSystemPromptChange}
      toggles={toggles}
      onToggle={onToggle}
    />
  );
}
