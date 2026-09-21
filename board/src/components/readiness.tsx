/**
 * Readiness — the one question only zevet, running on this machine, is
 * positioned to answer: is this machine actually set up for an agent to
 * work here? Every criterion below is read from state other panels already
 * rely on (agentviews' agent picker, settings.tsx's index/account sections,
 * the strip's git status) — nothing is probed or invented for this panel.
 *
 * Renders null with no desktop bridge at all (`bridge.local` absent):
 * none of these facts exist off the desktop app, and a zero score there
 * would be a claim about the machine rather than about zevet's view of it.
 */
import { useEffect } from "react";
import { bridge } from "../lib/bridge";
import { useBoard } from "../lib/board";
import type { UsableAgentShape } from "../lib/board";
import type { Conn, LocalWorkspace } from "../lib/types";
import type { StatusResult } from "../lib/bridge";
import {
  ScoreBreakdown,
  type ScoreCriterion,
} from "./assistant-ui/elements/score-breakdown";

/* ---------------------------------------------------------------------------
 * WEIGHTS — zevet's opinion, not a measurement.
 *
 * Every `score` and `note` below is a fact read straight from the store.
 * These weights are an editorial judgement about how much each fact matters
 * to "can an agent actually work here", stated separately so a reader can
 * tell the two apart. An agent that is not signed in is fatal — nothing
 * runs — so it carries the most weight. No workspace open is nearly as
 * fatal: there is nothing to point an agent at. A dead hub loses zevet's own
 * view of the run, not the agent's ability to run, so it counts for less. A
 * git state the agent can't parse (no repo, detached HEAD) makes commits
 * and diffs unreliable but doesn't stop it reading or editing files. An
 * index that isn't built just makes search slower — the lowest weight here.
 * ------------------------------------------------------------------------- */
const WEIGHT = { agent: 5, workspace: 4, hub: 2, git: 2, index: 1 };

/** Mirrors the shape settings.tsx reads off `s.indexStatus` — duplicated
 *  locally rather than imported because settings.tsx does not export it. */
type IndexStatusView = {
  capable?: boolean;
  reasons?: string[];
  model?: { present?: boolean };
  stats?: { files?: number; chunks?: number };
};

function agentCriterion(agents: UsableAgentShape[]): ScoreCriterion {
  const eligible = agents.filter((a) => a.ok && a.signedIn);
  const installed = agents.filter((a) => a.ok);
  const note = eligible.length
    ? `${eligible.map((a) => a.name).join(", ")} signed in`
    : installed.length
      ? `${installed.map((a) => a.name).join(", ")} installed, none signed in`
      : "no agent CLI found on this machine";
  return { label: "Agent signed in", score: eligible.length ? 10 : 0, weight: WEIGHT.agent, note };
}

function workspaceCriterion(localRoot: string | null, workspaces: LocalWorkspace[]): ScoreCriterion {
  if (!localRoot) {
    return { label: "Workspace open", score: 0, weight: WEIGHT.workspace, note: "no folder open" };
  }
  const ws = workspaces.find((w) => w.dir === localRoot);
  const name = ws?.name ?? localRoot;
  return ws?.repo
    ? { label: "Workspace open", score: 10, weight: WEIGHT.workspace, note: `${name} is a git repo` }
    : { label: "Workspace open", score: 5, weight: WEIGHT.workspace, note: `${name} is open but is not a git repo` };
}

function hubCriterion(conn: Conn): ScoreCriterion {
  const score = conn === "live" ? 10 : conn === "init" ? 5 : 0;
  const note = conn === "live" ? "hub connection live" : conn === "init" ? "hub still connecting" : "hub unreachable";
  return { label: "Hub reachable", score, weight: WEIGHT.hub, note };
}

/** `null` when the store has not polled a git status yet — that is "board
 *  doesn't know", not "score zero", so the criterion is left out entirely. */
function gitCriterion(machine: StatusResult | null): ScoreCriterion | null {
  const repo = machine?.repo;
  if (!repo) return null;
  if (!repo.sha) {
    return { label: "Git state", score: 0, weight: WEIGHT.git, note: "workspace is not a git repository" };
  }
  if (!repo.branch) {
    return { label: "Git state", score: 5, weight: WEIGHT.git, note: `detached HEAD at ${repo.sha}` };
  }
  const sync = [repo.ahead ? `${repo.ahead} ahead` : "", repo.behind ? `${repo.behind} behind` : ""]
    .filter(Boolean)
    .join(", ");
  return {
    label: "Git state",
    score: 10,
    weight: WEIGHT.git,
    note: `on ${repo.branch} at ${repo.sha}${sync ? ` (${sync})` : ""}`,
  };
}

/** `null` when this build has no index feature, or the store has not heard
 *  back from it yet — same "don't know" reasoning as `gitCriterion`. */
function indexCriterion(
  machine: StatusResult | null,
  status: unknown,
  hasIndexStatus: boolean,
): ScoreCriterion | null {
  const m = machine as (StatusResult & { cindex?: boolean; cindexPort?: number }) | null;
  if (m?.cindex === true) {
    return {
      label: "Semantic index",
      score: 10,
      weight: WEIGHT.index,
      note: `external index running on port ${m.cindexPort ?? 8080}`,
    };
  }
  if (!hasIndexStatus) return null;
  const st = status as IndexStatusView | null;
  if (!st) return null;
  if (!st.capable) {
    return {
      label: "Semantic index",
      score: 0,
      weight: WEIGHT.index,
      note: (st.reasons && st.reasons.join("; ")) || "not capable on this machine",
    };
  }
  if (st.stats && st.stats.files) {
    return {
      label: "Semantic index",
      score: 10,
      weight: WEIGHT.index,
      note: `${st.stats.files} files, ${st.stats.chunks ?? 0} chunks indexed`,
    };
  }
  return {
    label: "Semantic index",
    score: 3,
    weight: WEIGHT.index,
    note: st.model?.present ? "model downloaded, index not built yet" : "index not built yet",
  };
}

/** Short phrase per criterion for the verdict sentence — the note above is
 *  the full fact, this is the couple of words that belong in a sentence
 *  next to four other criteria. Keyed on the label set this file defines. */
function phraseFor(c: ScoreCriterion): string {
  switch (c.label) {
    case "Agent signed in":
      return c.score >= 10 ? "signed in" : "no agent signed in";
    case "Workspace open":
      return c.score >= 10 ? "repo open" : c.score > 0 ? "workspace open, not a repo" : "no workspace open";
    case "Hub reachable":
      return c.score >= 10 ? "hub live" : c.score > 0 ? "hub connecting" : "hub down";
    case "Git state":
      return c.score >= 10 ? "git ready" : c.score > 0 ? "detached HEAD" : "not a git repo";
    case "Semantic index":
      return c.score >= 10 ? "index built" : "index not built";
    default:
      return c.note ?? c.label;
  }
}

export function Readiness() {
  const localAgents = useBoard((s) => s.localAgents);
  const localRoot = useBoard((s) => s.localRoot);
  const localWorkspaces = useBoard((s) => s.localWorkspaces);
  const conn = useBoard((s) => s.conn);
  const machine = useBoard((s) => s.strip.machine);
  const indexStatus = useBoard((s) => s.indexStatus);
  const refreshIndexStatus = useBoard((s) => s.refreshIndexStatus);

  const hasIndexStatus = Boolean(bridge.local && typeof bridge.local.indexStatus === "function");

  // Same trigger settings.tsx's IndexSection uses: don't bother asking when
  // an external index already answers for `cindex`, otherwise ask once.
  useEffect(() => {
    if (!hasIndexStatus) return;
    if (machine && (machine as { cindex?: boolean }).cindex === true) return;
    refreshIndexStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasIndexStatus]);

  if (!bridge.local) return null;

  const criteria = [
    agentCriterion(localAgents),
    workspaceCriterion(localRoot, localWorkspaces),
    hubCriterion(conn),
    gitCriterion(machine),
    indexCriterion(machine, indexStatus, hasIndexStatus),
  ].filter((c): c is ScoreCriterion => c !== null);

  if (!criteria.length) return null;

  const weightSum = criteria.reduce((sum, c) => sum + c.weight, 0);
  const total = weightSum ? criteria.reduce((sum, c) => sum + c.score * c.weight, 0) / weightSum : 0;
  const verdict = criteria.map(phraseFor).join(", ");

  return (
    <ScoreBreakdown
      className="max-w-none"
      verdict={verdict}
      total={total}
      outOf={10}
      criteria={criteria}
      visibleCount={criteria.length}
    />
  );
}
