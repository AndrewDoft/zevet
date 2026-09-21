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
 * `launchEffort`/`launchMode`), which is what the NEXT start reads — a fresh
 * one (`onNew` in lib/runtime.tsx, when there is no active console), a
 * launcher Start button, or a fork. A running console's own CLI cannot be
 * re-flagged mid-session, so what it actually launched with is shown
 * alongside as a FACT once one exists — provider mark, model name, posture —
 * plus what only exists once the run has reported usage: context against the
 * window, and cost. runmeters.tsx keeps the full breakdown behind its
 * collapsed row; this is the glance version, so it never repeats that — no
 * gauge, no chart, no table, one line.
 *
 * Renders nothing when it has nothing honest to say: no usable agents and no
 * console running.
 */
import { AgentLogo } from "./brand";
import { ContextCardButton, PastPromptsButton } from "./composercards";
import { PromptLibraryPanel } from "./promptlib";
import { QuotaChip } from "./quota";
import { RunMeterCard } from "./runmeters";
import { ModelChoice } from "./model-choice";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { mono } from "./assistant-ui/elements/surfaces";
import { cn } from "@/lib/utils";
import { MODES, MODE_LABEL } from "../lib/constants";
import { selectActiveConsole, useBoard } from "../lib/board";
import { describeModel } from "../lib/models.mjs";
import { tokens } from "../lib/fmt";
import type { LaunchMode } from "../lib/types";

/** The fallback context window — the same 200k floor runmeters.tsx's
 *  CONTEXT_LIMIT uses, duplicated rather than imported because that file
 *  does not export it (moreviews.tsx duplicates its own readers for the same
 *  reason). See runmeters.tsx's comment for why 200k and not the model's
 *  real one: it is the smallest common window, so a bar drawn against it
 *  undersells rather than oversells how full the context is. */
const CONTEXT_LIMIT = 200_000;

/** Same rounding as runmeters.tsx's `money`, minus the null branch — callers
 *  here only reach it once `usage.cost != null` has already been checked. */
const money = (n: number) => `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".00")}`;

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
  const active = useBoard(selectActiveConsole);
  const localAgents = useBoard((s) => s.localAgents);
  const launchMode = useBoard((s) => s.launchMode);
  const launchModel = useBoard((s) => s.launchModel);
  const setLaunchMode = useBoard((s) => s.setLaunchMode);
  const usable = localAgents.filter((a) => a.ok);

  /* The pickers below set `launchModel`/`launchAgent`/`launchEffort`/
   * `launchMode` — global launch state, not anything on this console. A
   * running console cannot be re-flagged (the CLI was already started with
   * whatever it was started with), but that state is exactly what the NEXT
   * start uses: `onNew` in lib/runtime.tsx reads it when there is no active
   * console, the launcher's Start buttons read it, and a fork reads it too
   * (board.ts's `startAgent`). So the pickers stay live for the whole time a
   * console runs — Andrew: "you should still be able to choose model and
   * effort and posture" — they are just no longer the only thing on the row:
   * what THIS console actually launched with is added alongside as a fact,
   * since the two can diverge the moment the pickers are touched again. */
  /* ⚠️ ONLY WHAT DIVERGED. The fact row printed the model and the posture
     unconditionally, beside the pickers that were showing the same two
     values — "nemotron-3-ultra  Auto   nemotron-3-ultra Auto" on one line,
     seen in a real run. It is worth saying only when this console is running
     something other than what the pickers would start next; when they agree,
     the pickers have already said it. The numbers (context, cost) belong to
     the console alone and always show. */
  const sameModel = Boolean(active) && active!.model === launchModel;
  const sameMode = Boolean(active) && active!.mode === launchMode;

  const facts = active
    ? (() => {
        const { usage } = active;
        const window = usage.window ?? CONTEXT_LIMIT;
        const model = describeModel(active.model).label || active.model;
        return (
          <span className={cn(mono, "flex min-w-0 shrink items-center gap-1.5 text-foreground/50")}>
            {!sameModel && (
              <>
                <AgentLogo agent={active.agent} model={active.model} className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{model}</span>
              </>
            )}
            {!sameMode && (
              <span className="shrink-0 text-foreground/35">{MODE_LABEL[active.mode] ?? active.mode}</span>
            )}
            {usage.context != null && (
              <span className="shrink-0">
                {tokens(usage.context)}/{tokens(window)}
              </span>
            )}
            {usage.cost != null && <span className="shrink-0">{money(usage.cost)}</span>}
            {/* The provider's own rate-limit window, beside the two numbers it
                belongs with rather than as a banner over the transcript. */}
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
    <div className="flex min-w-0 items-center gap-1.5">
      {/* Left of the chat box: the prompts you have written before. A button,
          not a collapsed row — see composercards.tsx for why the card is an
          overlay and not a dropdown. */}
      {active ? (
        <PastPromptsButton>
          <PromptLibraryPanel />
        </PastPromptsButton>
      ) : null}
      <div className={compactModelChoice}>
        <ModelChoice agents={usable} />
      </div>

      <Select
        value={launchMode}
        onValueChange={(v: string | null) => {
          if (v) setLaunchMode(v as LaunchMode);
        }}
      >
        <SelectTrigger
          size="sm"
          className="h-7 shrink-0 gap-1 rounded-full border-transparent bg-foreground/[0.04] px-2 text-xs"
          aria-label="Permission posture"
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
 * that hosts both. It renders nothing until the run has reported usage, for
 * the same reason RunMeterCard does: an empty meter reads as "zero tokens",
 * which is never true of a running agent.
 */
export function ComposerExtras() {
  const active = useBoard(selectActiveConsole);
  const live = useBoard((s) => s.strip.live);
  if (!active || live.context == null) return null;
  return (
    <ContextCardButton>
      <RunMeterCard />
    </ContextCardButton>
  );
}
