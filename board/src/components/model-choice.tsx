/**
 * Picking a model to start an agent on.
 *
 * ⚠️ WHAT WAS WRONG WITH THE LAST ONE, in Andrew's words: "this one prompt
 * thing under signed in on each model makes no sense."
 *
 * It was `ModelPicker`, a flat list, and every row carried "signed in" and
 * "one prompt" — both of which are facts about the AGENT, not the model. So
 * "one prompt" appeared under all four codex models and all ten opencode ones,
 * saying the same thing eleven times and reading as if it described the model.
 * Those facts belong to the group, once.
 *
 * It is `ModelSelector` now, which is the right component for this: a
 * searchable combobox that groups, carries a description per model, matches on
 * keywords, and has reasoning effort built in. Ten free opencode ids with
 * provider-qualified names are a list you search, not one you scroll.
 */
import { useContext, useEffect, useMemo, useState } from "react";
import {
  ModelSelectorContent,
  ModelSelectorEffort,
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorRoot,
  ModelSelectorSearch,
  ModelSelectorTrigger,
  ModelSelectorValue,
  type ModelOption,
} from "./assistant-ui/elements/model-selector";
import { mono } from "./assistant-ui/elements/surfaces";
import { AgentLogo } from "./brand";
import { cn } from "@/lib/utils";
import { MODELS } from "../lib/constants";
import { aliasOf, describeModel } from "../lib/models.mjs";
import { modelLimitedUntil, sortByLimit } from "../lib/model-limits.mjs";
import { whenText } from "../lib/when.mjs";
import { useBoard } from "../lib/board";
import { useChat } from "../lib/chat";
import { ChatSurface } from "../lib/surface";
import { zStorage } from "../lib/bridge";
import type { UsableAgent } from "../lib/types";

/** codex is the one CLI here that takes a reasoning-effort flag. Offering the
 *  control for models that ignore it would be inventing a setting. */
const HAS_EFFORT = new Set(["codex"]);


/** `running`: the console in front, whose model the trigger shows instead of
 *  the launch default — "Opus 5.5" over a Sonnet 5 run read as the wrong model.
 *  Picking still only sets the next start. */
export function ModelChoice({
  agents,
  running,
}: {
  agents: UsableAgent[];
  running?: { id: string; name: string };
}) {
  const launchModel = useBoard((s) => s.launchModel);
  const setLaunchAgent = useBoard((s) => s.setLaunchAgent);
  const setLaunchModel = useBoard((s) => s.setLaunchModel);
  const launchEffort = useBoard((s) => s.launchEffort);
  const setLaunchEffort = useBoard((s) => s.setLaunchEffort);
  const modelSelectorOpen = useBoard((s) => s.modelSelectorOpen);
  const setModelSelectorOpen = useBoard((s) => s.setModelSelectorOpen);
  /* ⚠️ TWO OF THESE ARE MOUNTED — Code's composer and Chat's, one hidden. Both
     bound to the one store signal, a click opened both and the hidden one's
     outside-click closed them again, so the picker never opened (seen live
     2026-09-23). Only the surface in front takes the /model signal. */
  const inChat = useContext(ChatSurface);
  const front = useChat((s) => s.mode === "chat") === inChat;
  const [ownOpen, setOwnOpen] = useState(false);
  const open = front ? modelSelectorOpen : ownOpen;
  const setOpen = front ? setModelSelectorOpen : setOwnOpen;

  /** One group per agent. The id carries `<agent>:<alias>` so two CLIs can
   *  offer the same alias without colliding; aliasOf() reads it back. */
  const groups = useMemo(
    () =>
      agents.map((a) => {
        // What the CLI knows today, when the desktop app could read it;
        // otherwise what zevet shipped with. Catalogue order is kept — both
        // CLIs lead with their newest flagship, which is what all[0] below
        // makes the default — except a model past its free daily cap sinks
        // below the rest of its group: still offered, just not first.
        // Keyed `<agent>:<alias>` in storage too, same as the option id below —
        // opencode's provider-prefixed ids and claude/codex's short ones share
        // one namespace otherwise, and a limit on one agent's "sonnet" would
        // wrongly gray another's.
        const rawAliases = a.models?.map((m) => m.id) ?? MODELS[a.name] ?? [];
        const aliases = sortByLimit(
          rawAliases.map((alias) => `${a.name}:${alias}`),
          zStorage,
        ).map((qualified) => qualified.slice(a.name.length + 1));
        return {
          agent: a,
          models: aliases.map((alias): ModelOption & { resetLabel?: string } => {
            const { label, from, note, trains } = describeModel(alias);
            const notes = [from, note, trains ? "may train on prompts" : null].filter(Boolean);
            const resetAt = modelLimitedUntil(zStorage, `${a.name}:${alias}`);
            return {
              id: `${a.name}:${alias}`,
              // The name comes from one place for every row and every surface.
              name: label,
              description: notes.join(" · ") || undefined,
              // The raw id is what someone types when they are looking for
              // `inkling` inside `openrouter/thinkingmachines/inkling:free`.
              // No "" row reaches here any more (constants.ts MODELS dropped
              // it), so alias is always a real model id — the old `alias ?
              // ... : [...]` fallback for the empty-alias row is unreachable
              // and gone.
              keywords: [alias, a.name],
              // The provider's own mark, where one is honest. opencode fronts a
              // dozen providers, so the MODEL is what identifies it, not the CLI.
              icon: <AgentLogo agent={a.name} model={alias} className="size-3.5" />,
              efforts: HAS_EFFORT.has(a.name) && alias ? true : undefined,
              // Grayed and unselectable until it clears — a model that would
              // only fail the same way again is not a real choice. The reset
              // time is the tooltip (ModelSelectorItem's `title` below).
              disabled: Boolean(resetAt),
              resetLabel: resetAt ? `Resets ${whenText(resetAt)}` : undefined,
            };
          }),
        };
      }),
    [agents],
  );

  const all = useMemo(() => groups.flatMap((g) => g.models), [groups]);
  const match = all.find((m) => aliasOf(m.id) === launchModel);
  const selected = match?.id ?? all[0]?.id ?? "";

  /* ⚠️ THE FALLBACK WAS DISPLAY-ONLY, so the picker showed one model and the
     run started on another. `launchModel` is what board.ts § startConsole
     reads, and this component fell back to `all[0]` for the trigger without
     ever writing that back — so whenever the stored model was not in the list
     (a first run before anything was chosen, or a model the CLI has since
     dropped from its catalogue) you read one name and got a different one,
     with nothing on screen disagreeing.

     Write-back, not a different fallback: the displayed model becomes the real
     one. Guarded on there being no match AND a list to pick from, so this
     settles in a single pass and cannot ping-pong. */
  useEffect(() => {
    if (match || !selected) return;
    setLaunchModel(aliasOf(selected));
    const cut = selected.indexOf(":");
    if (cut > 0) setLaunchAgent(selected.slice(0, cut));
  }, [match, selected, setLaunchModel, setLaunchAgent]);

  return (
    <ModelSelectorRoot
      models={all}
      value={running && all.some((m) => m.id === running.id) ? running.id : selected}
      onValueChange={(id) => {
        // A ModelOption id is `<agent>:<alias>`, so picking a model picks the
        // CLI as well — which is what the composer starts when it is the first
        // thing anybody touches.
        setLaunchModel(aliasOf(id));
        const cut = id.indexOf(":");
        if (cut > 0) setLaunchAgent(id.slice(0, cut));
      }}
      effort={launchEffort || undefined}
      onEffortChange={(e) => setLaunchEffort(e)}
      open={open}
      onOpenChange={setOpen}
    >
      <ModelSelectorTrigger className="w-full justify-between" variant="outline">
        {running ? (
          <span data-slot="model-selector-value" className="truncate">
            {running.name}
          </span>
        ) : (
          <ModelSelectorValue />
        )}
      </ModelSelectorTrigger>

      <ModelSelectorContent className="w-(--radix-popover-trigger-width) min-w-[18rem]">
        {/* Ten free opencode ids, and more the moment sync-models runs again.
            A list that long is searched, not scrolled. */}
        <ModelSelectorSearch placeholder="Search models…" />
        <ModelSelectorList>
          {groups.map(({ agent, models }) => (
            <ModelSelectorGroup
              key={agent.name}
              heading={
                <span className="flex items-baseline justify-between gap-3">
                  <span className="flex items-center gap-1.5">
                    <AgentLogo agent={agent.name} className="size-3" />
                    {agent.name}
                  </span>
                  {/* Only what you can act on: the sign-in state and turn style on
                      every group was noise. */}
                  {!agent.signedIn && <span className={cn(mono, "text-foreground/35")}>Not signed in</span>}
                </span>
              }
            >
              {models.map((m) => (
                <ModelSelectorItem key={m.id} model={m} {...(m.resetLabel ? { title: m.resetLabel } : undefined)} />
              ))}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
        {/* Only rendered for a model that declares efforts, i.e. codex. */}
        <ModelSelectorEffort />
      </ModelSelectorContent>
    </ModelSelectorRoot>
  );
}
