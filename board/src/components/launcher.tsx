/**
 * Starting an agent.
 *
 * assistant-ui's "new thread" is one button, because it assumes one model
 * behind one endpoint. zevet has three CLIs on this machine, each with its own
 * models, four permission postures, and a real difference in what a console can
 * do once it exists — so this stays zevet's own screen, built out of the
 * registry's parts rather than delegated to a component that models something
 * else.
 *
 * The one thing it will not do is hide the asymmetry: codex and opencode take
 * ONE prompt per run and then close stdin (agent-console.js § send, facts 4
 * and 5). That is on the card, before you pick, rather than discovered when a
 * follow-up silently goes nowhere.
 */
import { useMemo } from "react";
import { inkButton, mono, field, paper } from "./assistant-ui/elements/surfaces";
import { cn } from "@/lib/utils";
import { MODES } from "../lib/constants";
import { ModelChoice } from "./model-choice";
import { selectMyConsoles, useBoard } from "../lib/board";
import { AgentComparison } from "./runspec";
import { AgentLogo } from "./brand";
import type { LaunchMode } from "../lib/types";

/** What each posture actually does, in the words the board uses elsewhere. */
const MODE_NOTE: Record<LaunchMode, string> = {
  plan: "Reads and plans. Changes nothing.",
  ask: "Asks before each command or edit.",
  auto: "Edits files. Asks before commands.",
  dangerous: "Runs commands and edits files without asking.",
};

function ModeSelector() {
  const launchMode = useBoard((s) => s.launchMode);
  const setLaunchMode = useBoard((s) => s.setLaunchMode);

  return (
    <div className="flex w-full flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[13.5px] font-medium">Posture</span>
        <span className={cn(mono, "text-foreground/35")}>{launchMode}</span>
      </div>

      {/* ⚠️ role="radiogroup" IS A PROMISE ABOUT THE ARROW KEYS. It was made
          and not kept: each option was a plain onClick button in the tab
          order, so a keyboard user Tabbed through all three and the arrows did
          nothing — while a screen reader, told this was a radio group,
          announced "1 of 3" and waited for a Left/Right that never worked.

          So: roving tabindex (only the checked option is tabbable, which is
          what makes a group one tab stop) plus the four arrows, Home and End.
          APG "Radio Group Pattern". */}
      <div
        className={cn(field, "flex gap-0.5 rounded-full p-0.5")}
        role="radiogroup"
        aria-label="Permission posture"
        onKeyDown={(e) => {
          const i = MODES.findIndex((m) => m.id === launchMode);
          const step =
            e.key === "ArrowRight" || e.key === "ArrowDown"
              ? 1
              : e.key === "ArrowLeft" || e.key === "ArrowUp"
                ? -1
                : 0;
          let next = -1;
          if (step) next = (i + step + MODES.length) % MODES.length;
          else if (e.key === "Home") next = 0;
          else if (e.key === "End") next = MODES.length - 1;
          if (next < 0) return;
          e.preventDefault();
          setLaunchMode(MODES[next].id);
          // The newly checked option is the only tabbable one, so focus has to
          // follow the selection or it lands outside the group.
          const group = e.currentTarget;
          requestAnimationFrame(() => {
            const btn = group.children[next];
            if (btn instanceof HTMLElement) btn.focus();
          });
        }}
      >
        {MODES.map((m) => {
          const active = m.id === launchMode;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              onClick={() => setLaunchMode(m.id)}
              className={cn(
                "flex-1 whitespace-nowrap rounded-full px-2 py-1 text-[11.5px] font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.97]",
                active ? "bg-background text-foreground/90" : "text-foreground/45 hover:text-foreground/70",
                m.id === "dangerous" && active && "text-destructive",
              )}
            >
              {m.label}
            </button>
          );
        })}
      </div>

      <p className={cn("text-[12.5px]", launchMode === "dangerous" ? "text-destructive" : "text-muted-foreground")}>
        {MODE_NOTE[launchMode]}
      </p>
    </div>
  );
}

export function Launcher() {
  const localRoot = useBoard((s) => s.localRoot);
  const localAgents = useBoard((s) => s.localAgents);
  const launchMode = useBoard((s) => s.launchMode);
  const startAgent = useBoard((s) => s.startAgent);
  const addWorkspace = useBoard((s) => s.addWorkspace);
  const started = useBoard(selectMyConsoles).length;

  const usable = useMemo(() => localAgents.filter((a) => a.ok), [localAgents]);

  /* ⚠️ THIS USED TO `return null`, and that was the dead end Andrew hit:
     open the agent view before a folder has been opened and the column showed
     a sentence saying to pick an agent, with no picker under it and no way
     forward. An agent needs somewhere to run, so the honest answer is not
     nothing — it is the one action that fixes it. */
  if (!localRoot) {
    return (
      <div className={cn(paper, "mx-auto flex w-full max-w-sm flex-col items-center gap-3 rounded-2xl p-4 text-center")}>
        <p className="text-[13px] text-muted-foreground">
          No folder open. An agent runs in a repo, on this machine.
        </p>
        <button
          type="button"
          onClick={() => addWorkspace()}
          className={cn(inkButton, "rounded-full px-4 py-2 text-[13px] transition-transform active:scale-[0.97]")}
        >
          Open a folder…
        </button>
      </div>
    );
  }

  if (!usable.length) {
    return (
      <div className={cn(paper, "mx-auto w-full max-w-sm rounded-2xl p-4 text-center text-[13px] text-muted-foreground")}>
        {localAgents.length ? "No usable agents found on this machine." : "Looking for agents…"}
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col items-stretch gap-6 py-4">
      <ModeSelector />

      <div className="flex flex-col gap-2.5">
        <span className="text-[13.5px] font-medium">Model</span>
        <ModelChoice agents={usable} />
      </div>

      <div className="flex flex-wrap gap-2">
        {usable.map((a) => (
          <button
            key={a.name}
            type="button"
            onClick={() => startAgent(a.name)}
            title={a.detail + (a.signedIn ? "  (signed in)" : "  (no account found)")}
            className={cn(
              inkButton,
              "flex-1 rounded-full px-4 py-2 text-[13px] transition-transform active:scale-[0.97]",
              launchMode === "dangerous" && "bg-destructive text-background",
            )}
          >
            <AgentLogo agent={a.name} className="mr-1.5 inline-block size-3.5 align-[-2px]" />
            {(started ? "Another " : "Start ") + a.name}
            {!a.signedIn ? <span className="ml-1.5 inline-block size-1.5 rounded-full bg-current opacity-50" /> : null}
          </button>
        ))}
      </div>

      {/* Under the buttons, not above them: the choice is usually already made,
          and this is for the time it is not. Everything on it is a fact this
          screen already had — installed, signed in, and whether the CLI will
          take a second prompt. */}
      <AgentComparison />
    </div>
  );
}
