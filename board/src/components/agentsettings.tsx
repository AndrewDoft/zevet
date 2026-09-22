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
  useBoard,
} from "../lib/board";

export function AgentSettings() {
  const localRoot = useBoard((s) => s.localRoot);
  const agentSettings = useBoard((s) => s.agentSettings);

  // Local draft + a short debounce, so typing isn't a save-to-disk per
  // keystroke and the textarea isn't a controlled value that snaps back
  // between the keystroke and the async round trip through the bridge.
  const [draft, setDraft] = useState(agentSettings?.systemPrompt ?? "");
  const savedRef = useRef(agentSettings?.systemPrompt ?? "");
  const timerRef = useRef<number | undefined>(undefined);
  // What the debounce still owes the disk, for the flush on unmount below.
  const pendingRef = useRef<string | null>(null);

  useEffect(() => {
    const incoming = agentSettings?.systemPrompt ?? "";
    /* ⚠️ OUR OWN SAVE ECHOES BACK THROUGH HERE. This used to adopt the store
       value unconditionally, so a save that landed after later keystrokes
       reset the textarea to the older saved text and ate what you had typed
       in the meantime. `savedRef` is what we last sent, so a value equal to
       it is the round trip coming home and there is nothing to adopt. A value
       DIFFERENT from it came from somewhere else — a different repo opened —
       and should replace the draft. */
    if (incoming === savedRef.current) return;
    setDraft(incoming);
    savedRef.current = incoming;
  }, [agentSettings?.systemPrompt]);

  useEffect(
    () => () => {
      /* ⚠️ FLUSH, DO NOT JUST CANCEL. The cleanup cleared the timer and
         stopped, so anything typed within the 500ms before the panel closed
         was silently dropped — and closing the panel right after typing is
         the ordinary way to finish editing standing instructions. */
      window.clearTimeout(timerRef.current);
      const pending = pendingRef.current;
      if (pending != null && pending !== savedRef.current) {
        savedRef.current = pending;
        void saveAgentSettings({ systemPrompt: pending });
      }
    },
    [],
  );

  if (!bridge.local || !localRoot || !agentSettings) return null;

  // ponytail: plain setTimeout debounce, not a save queue — one textarea,
  // one field. Revisit if agentSettings grows more free text that needs it.
  function onSystemPromptChange(next: string) {
    setDraft(next);
    pendingRef.current = next;
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      if (next !== savedRef.current) {
        savedRef.current = next;
        void saveAgentSettings({ systemPrompt: next });
      }
    }, 500);
  }

  // Only the per-project controls live here; model, view and theme have their own homes.
  const toggles: SettingToggle[] = [
    {
      key: "computerUse",
      label: "Computer use",
      detail: "",
      on: agentSettings.computerUse,
    },
  ];

  function onToggle(key: string) {
    if (key === "computerUse") void saveAgentSettings({ computerUse: !agentSettings!.computerUse });
  }

  return (
    <SettingsPanel
      className="max-w-none"
      model=""
      models={[]}
      systemPrompt={draft}
      onSystemPromptChange={onSystemPromptChange}
      toggles={toggles}
      onToggle={onToggle}
    />
  );
}
