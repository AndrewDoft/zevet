/**
 * The composer's own controls: model, posture, and — once a console exists —
 * what that run has spent.
 *
 * Lives beside the attachment button, at the left end of the composer's
 * action row. thread.aui.tsx (vendored, re-applied from the registry on every
 * re-install) hosts it with a one-line patch; everything it needs stays in
 * this file so that patch never grows.
 *
 * The model/posture pickers are live whether or not a console is running:
 * they set the global launch state (`launchModel`/`launchAgent`/
 * `launchEffort`/`launchMode`), which is what the NEXT start reads. With a
 * console in front, the model picker DISPLAYS the model that console runs.
 * Once a console exists, a small ring says how full its context is (numbers
 * and cost in its tooltip).
 * runmeters.tsx keeps the full breakdown behind its button; this is the
 * glance version.
 *
 * Renders nothing when it has nothing honest to say: no usable agents and no
 * console running.
 */
import { useContext } from "react";
import { ChatSurface } from "../lib/surface";
import { ContextCardButton, PastPromptsButton } from "./composercards";
import { PromptLibraryPanel } from "./promptlib";
import { QuotaChip } from "./quota";
import { RunMeterCard } from "./runmeters";
import { ModelChoice } from "./model-choice";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { mono } from "./assistant-ui/elements/surfaces";
import { cn } from "@/lib/utils";
import { MODES, MODE_LABEL } from "../lib/constants";
import { CONTEXT_FLOOR, contextShare } from "../lib/meter.mjs";
import { selectActiveConsole, useBoard } from "../lib/board";
import { runningModelName } from "../lib/models.mjs";
import { money, tokens } from "../lib/fmt";
import type { LaunchMode } from "../lib/types";

/** How full the context is, as a ring; the numbers are its tooltip. */
function ContextRing({ share, label }: { share: number; label: string }) {
  const c = 2 * Math.PI * 6;
  return (
    <span role="img" aria-label={label} title={label} className="shrink-0">
      <svg viewBox="0 0 16 16" className="size-3.5 -rotate-90" aria-hidden="true">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - share)}
        />
      </svg>
    </span>
  );
}

/** ModelChoice's trigger is sized for the launcher panel (h-9, w-full) — too
 *  tall for a composer row of size-7 icon buttons. Its own file is off
 *  limits here, so this reclaims the trigger from outside by its data-slot,
 *  the same idiom brand.tsx's AgentLogo uses to reclaim ClaudeLogo's
 *  hardcoded fill without touching the vendored component: a descendant CSS
 *  rule outranks the trigger's own utility classes on specificity alone. */
const compactModelChoice = cn(
  "[&_[data-slot=model-selector-trigger]]:h-7",
  "[&_[data-slot=model-selector-trigger]]:w-auto",
  // ⚠️ WIDE ENOUGH FOR THE DEFAULT LABEL. At max-w-36 the trigger rendered
  // "whatever t…" — the model control, truncated mid-word, saying nothing.
  // The long opencode ids still truncate, and that is fine: they are long on
  // purpose and the picker spells them out.
  "[&_[data-slot=model-selector-trigger]]:max-w-56",
  "[&_[data-slot=model-selector-trigger]]:gap-1",
  "[&_[data-slot=model-selector-trigger]]:rounded-full",
  "[&_[data-slot=model-selector-trigger]]:border-transparent",
  "[&_[data-slot=model-selector-trigger]]:bg-foreground/[0.04]",
  "[&_[data-slot=model-selector-trigger]]:px-2",
  "[&_[data-slot=model-selector-trigger]]:py-1",
  "[&_[data-slot=model-selector-trigger]]:text-xs",
);

export function ComposerControls() {
  return useContext(ChatSurface) ? null : <ComposerControlsCode />;
}

function ComposerControlsCode() {
  const active = useBoard(selectActiveConsole);
  // Usage is mutated onto the console object in place (board.ts recordUsage);
  // only the list itself is replaced, so that is what re-renders the ring.
  useBoard((s) => s.myConsoles);
  const localAgents = useBoard((s) => s.localAgents);
  const launchMode = useBoard((s) => s.launchMode);
  const setLaunchMode = useBoard((s) => s.setLaunchMode);
  const setConsoleMode = useBoard((s) => s.setConsoleMode);
  const usable = localAgents.filter((a) => a.ok);

  /* The pickers below set `launchModel`/`launchAgent`/`launchEffort`/
   * `launchMode` — global launch state, not anything on this console. A
   * running console cannot be re-flagged (the CLI was already started with
   * whatever it was started with), but that state is exactly what the NEXT
   * start uses: `onNew` in lib/runtime.tsx reads it when there is no active
   * console, the launcher's Start buttons read it, and a fork reads it too
   * (board.ts's `startAgent`). So the pickers stay live for the whole time a
   * console runs — Andrew: "you should still be able to choose model and
   * effort and posture". */
  /* ⚠️ ONE MODEL LABEL, AND IT IS THIS CONSOLE'S. A second, mono
     "GPT-5.6-Terra 354k/200k 78% cached" beside the picker read as two models
     and as jargon — but folding the running model into the launch picker then
     showed "Opus 5.5", the NEXT start's default, over a Sonnet 5 run. With a
     console in front, the picker stays live but DISPLAYS what that console
     runs (usage.model, else what it was started with); a pick still sets the
     next start. Token counts and cost live in the ring's tooltip. */
  const model = active ? runningModelName(active.usage.model, active.model) : "";
  const facts = active
    ? (() => {
        const { usage } = active;
        const window = usage.window ?? CONTEXT_FLOOR;
        const share = contextShare(usage.context, usage.window);
        const detail = [
          model,
          usage.context != null ? `${tokens(usage.context)} of ${tokens(window)} context` : null,
          usage.cacheHit != null ? `${Math.round(usage.cacheHit)}% cached` : null,
          usage.cost != null ? money(usage.cost) : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <span className={cn(mono, "flex min-w-0 shrink items-center gap-1.5 text-foreground/50")}>
            {usage.context != null && <ContextRing share={share} label={detail} />}
            {/* The provider's own rate-limit window — only once it is nearly
                used up. */}
            <QuotaChip />
          </span>
        );
      })()
    : null;

  // No usable agent to start or fork with — the pickers have nothing to
  // offer. Facts about an already-running console still stand on their own;
  // with neither, there is nothing honest to say.
  if (!usable.length) return facts;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {/* Left of the chat box: the prompts you have written before. A button,
          not a collapsed row — see composercards.tsx for why the card is an
          overlay and not a dropdown.

          ⚠️ ALWAYS MOUNTED. It was gated on `active`, and that gate was the
          last thing moving the chat box on its own: with no console the row
          held the model picker and Send, and the moment a run started this
          button and ComposerExtras appeared on either side of them, growing
          the row and pushing the box 16px down. Measured in the running app
          2026-09-21 — composer top 669 empty, 685 with the buttons.

          Nothing needed relaxing to fix it. PromptLibraryPanel was already
          written for a null console: it disables Save and says "No active
          console to save from". The gate was preventing a state the panel
          already handled. */}
      <PastPromptsButton>
        <PromptLibraryPanel />
      </PastPromptsButton>
      <div className={compactModelChoice}>
        <ModelChoice
          agents={usable}
          running={
            active
              ? { id: `${active.agent}:${active.usage.model || active.model}`, name: model || "Default" }
              : undefined
          }
        />
      </div>

      {/* The console in front takes the pick on its next turn
          (`setConsoleMode` parks it while a turn runs); the next start takes it
          too. This is the only posture control — the rail's rows lost theirs. */}
      <Select
        value={active ? active.nextMode ?? active.mode : launchMode}
        onValueChange={(v: string | null) => {
          if (!v) return;
          setLaunchMode(v as LaunchMode);
          if (active) setConsoleMode(active.key, v);
        }}
      >
        <SelectTrigger
          size="sm"
          className="h-7 shrink-0 gap-1 rounded-full border-transparent bg-foreground/[0.04] px-2 text-xs"
          aria-label="Permissions"
        >
          <SelectValue>{(v: string) => MODE_LABEL[v] ?? v}</SelectValue>
        </SelectTrigger>
        <SelectContent align="start">
          {MODES.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {facts}
    </div>
  );
}

/**
 * The right end of the composer's action row: context and spend, behind a
 * button, as a card.
 *
 * Separate from ComposerControls because the row has two groups and this one
 * belongs in the other — see the COPY patch in board/scripts/sync-registry.mjs
 * that hosts both.
 *
 * ⚠️ THE BUTTON IS ALWAYS HERE; only its CONTENTS wait for usage. It used to
 * return null until a run reported numbers, which meant the composer's action
 * row grew by a button the moment an agent started and the chat box slid down
 * with it — "the chatbox ... should never change positions or resize
 * autonomously", broken by the very row built to obey it.
 *
 * And the gate read `strip.live`, which is ONE set of numbers for however many
 * consoles are running and which board.ts only ever patches — never clears. So
 * once any agent had run, a brand-new console inherited the button and the
 * card under it showed the other agent's context. RunMeterCard reads the
 * console's own usage now and says so there.
 */
export function ComposerExtras() {
  return useContext(ChatSurface) ? null : <ComposerExtrasCode />;
}

function ComposerExtrasCode() {
  const active = useBoard(selectActiveConsole);
  return (
    <ContextCardButton>
      {active && active.usage.context != null ? (
        <RunMeterCard />
      ) : (
        <p className="text-foreground/50 text-xs">Nothing reported yet — this fills in once the agent speaks.</p>
      )}
    </ContextCardButton>
  );
}
