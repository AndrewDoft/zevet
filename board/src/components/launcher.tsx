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
import { ModelPicker, type PickableModel } from "./assistant-ui/elements/model-picker";
import { field, inkButton, mono, paper } from "./assistant-ui/elements/surfaces";
import { cn } from "@/lib/utils";
import { MODELS, MODES, MULTI_TURN } from "../lib/constants";
import { aliasOf, describeModel } from "../lib/models.mjs";
import { selectMyConsoles, useBoard } from "../lib/board";
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
    <div className="flex w-full max-w-sm flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[13.5px] font-medium">Posture</span>
        <span className={cn(mono, "text-foreground/35")}>{launchMode}</span>
      </div>

      <div className={cn(field, "flex gap-0.5 rounded-full p-0.5")} role="radiogroup" aria-label="Permission posture">
        {MODES.map((m) => {
          const active = m.id === launchMode;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={active}
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
  const launchModel = useBoard((s) => s.launchModel);
  const launchMode = useBoard((s) => s.launchMode);
  const setLaunchModel = useBoard((s) => s.setLaunchModel);
  const startAgent = useBoard((s) => s.startAgent);
  const started = useBoard(selectMyConsoles).length;

  const usable = useMemo(() => localAgents.filter((a) => a.ok), [localAgents]);

  /** One row per model, grouped by the CLI that offers it. The empty-string
   *  alias each CLI accepts means "whatever it defaults to", which is a real
   *  choice and is labelled as one.
   *
   *  ⚠️ The row's `name` is a LABEL, not the value passed to the CLI. The value
   *  is carried in `id` as `<agent>:<alias>` and read back with aliasOf(). They
   *  used to be the same string, which was fine for "opus" and broke for the
   *  opencode ids: those are provider-qualified, the row truncates, and
   *  `openrouter/thinkingmachines/inkling:free` and `…/inkling-small:free` both
   *  render as `openrouter/thinkingmachines/in…` — two different models the user
   *  cannot tell apart. */
  const models = useMemo<PickableModel[]>(() => {
    const out: PickableModel[] = [];
    const seen = new Set<string>();
    for (const agent of usable) {
      for (const alias of MODELS[agent.name] ?? []) {
        const id = `${agent.name}:${alias}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const { label, from, trains } = describeModel(alias);
        out.push({
          id,
          name: label,
          family: agent.name,
          context: agent.signedIn ? "signed in" : "no account",
          price: MULTI_TURN.has(agent.name) ? "keeps talking" : "one prompt",
          capabilities: [
            ...(alias ? [] : ["whatever the CLI picks"]),
            ...(from ? [from] : []),
            // The contributor builds are free because the prompt may be used
            // for training. Someone picking a model to point at their own repo
            // should be told that here, not in a doc they have not read.
            ...(trains ? ["may train on prompts"] : []),
          ],
        });
      }
    }
    // A model typed by hand, or restored from a previous session, belongs in
    // the list too — otherwise selecting it would look like it did nothing.
    if (launchModel && !out.some((m) => aliasOf(m.id) === launchModel)) {
      out.push({
        id: `custom:${launchModel}`,
        name: describeModel(launchModel).label,
        family: "custom",
        context: "",
        price: "",
        capabilities: ["typed by hand"],
      });
    }
    return out;
  }, [usable, launchModel]);

  if (!localRoot) return null;

  if (!usable.length) {
    return (
      <div className={cn(paper, "mx-auto w-full max-w-sm rounded-2xl p-4 text-center text-[13px] text-muted-foreground")}>
        {localAgents.length ? "No usable agents found on this machine." : "Looking for agents…"}
      </div>
    );
  }

  const selectedId = models.find((m) => aliasOf(m.id) === launchModel)?.id ?? models[0]?.id ?? "";

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col items-stretch gap-6 py-4">
      <ModeSelector />

      <div className="flex flex-col gap-2.5">
        <span className="text-[13.5px] font-medium">Model</span>
        <ModelPicker
          className="max-w-none"
          models={models}
          selectedId={selectedId}
          onSelect={(id) => setLaunchModel(aliasOf(id))}
        />
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
            {(started ? "Another " : "Start ") + a.name}
            {!a.signedIn ? <span className="ml-1.5 inline-block size-1.5 rounded-full bg-current opacity-50" /> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
