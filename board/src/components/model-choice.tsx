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
import { useMemo } from "react";
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
import { MODELS, MULTI_TURN } from "../lib/constants";
import { aliasOf, describeModel } from "../lib/models.mjs";
import { useBoard } from "../lib/board";
import type { UsableAgent } from "../lib/types";

/** codex is the one CLI here that takes a reasoning-effort flag. Offering the
 *  control for models that ignore it would be inventing a setting. */
const HAS_EFFORT = new Set(["codex"]);

/** What is true of the AGENT, said once on its group rather than on each of
 *  its models. */
function agentNote(a: UsableAgent): string {
  const turns = MULTI_TURN.has(a.name) ? "keeps talking" : "one prompt per run";
  return `${a.signedIn ? "signed in" : "no account found"} · ${turns}`;
}

export function ModelChoice({ agents }: { agents: UsableAgent[] }) {
  const launchModel = useBoard((s) => s.launchModel);
  const setLaunchAgent = useBoard((s) => s.setLaunchAgent);
  const setLaunchModel = useBoard((s) => s.setLaunchModel);
  const launchEffort = useBoard((s) => s.launchEffort);
  const setLaunchEffort = useBoard((s) => s.setLaunchEffort);

  /** One group per agent. The id carries `<agent>:<alias>` so two CLIs can
   *  offer the same alias without colliding; aliasOf() reads it back. */
  const groups = useMemo(
    () =>
      agents.map((a) => ({
        agent: a,
        models: (MODELS[a.name] ?? []).map((alias): ModelOption => {
          const { label, from, note, trains } = describeModel(alias);
          const notes = [from, note, trains ? "may train on prompts" : null].filter(Boolean);
          return {
            id: `${a.name}:${alias}`,
            // Including "" — describeModel calls that one "CLI Choice", so the
            // name comes from one place for every row and every surface.
            name: label,
            description: notes.join(" · ") || undefined,
            // The raw id is what someone types when they are looking for
            // `inkling` inside `openrouter/thinkingmachines/inkling:free`.
            keywords: alias ? [alias, a.name] : [a.name, "default"],
            // The provider's own mark, where one is honest. opencode fronts a
            // dozen providers, so the MODEL is what identifies it, not the CLI.
            icon: <AgentLogo agent={a.name} model={alias} className="size-3.5" />,
            efforts: HAS_EFFORT.has(a.name) && alias ? true : undefined,
          };
        }),
      })),
    [agents],
  );

  const all = useMemo(() => groups.flatMap((g) => g.models), [groups]);
  const selected =
    all.find((m) => aliasOf(m.id) === launchModel)?.id ?? all[0]?.id ?? "";

  return (
    <ModelSelectorRoot
      models={all}
      value={selected}
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
    >
      <ModelSelectorTrigger className="w-full justify-between" variant="outline">
        <ModelSelectorValue />
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
                  <span className={cn(mono, "text-foreground/35")}>{agentNote(agent)}</span>
                </span>
              }
            >
              {models.map((m) => (
                <ModelSelectorItem key={m.id} model={m} />
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
