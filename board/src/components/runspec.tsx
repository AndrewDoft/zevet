/**
 * Three cards over facts zevet did not have anywhere else to show: the active
 * console's own launch spec, what the agent has written to its memory
 * directory, and how the locally installed CLIs compare.
 */
import { SpecSheet, type SpecRow } from "./assistant-ui/elements/spec-sheet";
import { MemoryChips, type MemoryChip } from "./assistant-ui/elements/memory-chips";
import { ComparisonCard, type ComparisonOption } from "./assistant-ui/elements/comparison-card";
import { selectActiveConsole, useBoard } from "../lib/board";
import { MODE_LABEL, MULTI_TURN } from "../lib/constants";
import { whenText } from "../lib/when.mjs";

export function RunSpec() {
  const active = useBoard(selectActiveConsole);
  if (!active) return null;

  const model = active.usage.model || active.model || "default";
  const repo = String(active.root).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || active.root;

  const rows: SpecRow[] = [
    { label: "agent", value: active.agent },
    { label: "model", value: model },
    { label: "posture", value: MODE_LABEL[active.mode] ?? active.mode, emphasis: active.mode === "dangerous" },
    { label: "repo", value: repo },
    { label: "started", value: whenText(active.startedAt) },
  ];
  if (active.exitCode != null) {
    rows.push({ label: "exit", value: String(active.exitCode) });
  }

  return (
    <SpecSheet
      className="max-w-none"
      title={active.agent}
      subtitle={active.usage.model || active.model || undefined}
      rows={rows}
      visibleCount={rows.length}
    />
  );
}

export function Memories() {
  const memories = useBoard((s) => s.memories);
  if (!memories.length) return null;

  const chips: MemoryChip[] = memories.map((m) => ({
    id: m.id,
    text: m.text,
    change: m.fresh ? "added" : "existing",
  }));

  // NO `onForget`, deliberately: `local:memories` is read-only — desktop/main.js
  // has no counterpart that deletes a memory file. A forget button that
  // silently did nothing would be the same mistake repoviews.tsx's missing
  // `onRestore` avoided, so this one is left off too.
  return <MemoryChips className="max-w-none" chips={chips} />;
}

export function AgentComparison() {
  const agents = useBoard((s) => s.localAgents);
  if (agents.length < 2) return null;

  const eligible = agents.filter((a) => a.ok && a.signedIn);
  if (!eligible.length) return null;

  const multiTurnEligible = eligible.filter((a) => MULTI_TURN.has(a.name));
  const picked = multiTurnEligible[0] ?? eligible[0]!;
  const picksFollowUp = MULTI_TURN.has(picked.name);

  const reason = picksFollowUp
    ? multiTurnEligible.length === 1
      ? "installed, signed in, and the only one that takes a follow-up prompt"
      : "installed, signed in, and takes a follow-up prompt"
    : "installed and signed in";

  const options: ComparisonOption[] = agents.map((a) => ({
    id: a.name,
    name: a.name,
    headline: a.detail,
    traits: [
      a.ok ? "Installed" : false,
      a.signedIn ? "Signed in" : false,
      MULTI_TURN.has(a.name) ? "Follow-up prompts" : false,
    ],
  }));

  return (
    <ComparisonCard
      className="max-w-none"
      traitLabels={["Installed", "Signed in", "Follow-up prompts"]}
      options={options}
      recommendedId={picked.name}
      reason={reason}
    />
  );
}
