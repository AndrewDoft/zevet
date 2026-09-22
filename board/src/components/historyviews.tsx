/**
 * The repo's history laid across one clock, and the shape of its recent work.
 *
 * repoviews.tsx already tells the repo's history and its scheduled runs as
 * two separate cards. This file is the same facts read a different way: one
 * timeline that runs past -> now -> future, and one heat map of when commits
 * actually land.
 */
import { Timeline, type TimelineEvent } from "./assistant-ui/elements/timeline";
import { ActivityGraph } from "./assistant-ui/elements/activity-graph";
import type { DataPoint } from "heat-graph";
import { cadenceLabel, whenText } from "../lib/when.mjs";
import { MODE_LABEL } from "../lib/constants";
import { useBoard } from "../lib/board";

function fileCount(n: number) {
  return `${n} file${n === 1 ? "" : "s"}`;
}

function localDayKey(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function RepoTimeline() {
  const commits = useBoard((s) => s.repoCommits);
  const consoles = useBoard((s) => s.myConsoles);
  const schedules = useBoard((s) => s.schedules);

  const past: TimelineEvent[] = commits
    .slice()
    .sort((a, b) => b.at - a.at)
    .slice(0, 6)
    .reverse()
    .map((c) => ({
      id: c.sha,
      when: "past",
      time: whenText(c.at),
      title: c.subject,
      detail: fileCount(c.files),
    }));

  const now: TimelineEvent[] = consoles
    .filter((c) => c.running)
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((c) => ({
      id: `console-${c.key}`,
      when: "now",
      time: whenText(c.startedAt),
      title: `${c.agent} running`,
      detail: MODE_LABEL[c.mode],
    }));

  // repoviews.tsx's Schedules keeps a disabled schedule and prints "paused"
  // on its own card. A timeline has no such slot for something that is not
  // going to happen, so a disabled schedule is left out entirely here.
  const future: TimelineEvent[] = schedules
    .filter((s) => s.enabled)
    .slice()
    .sort((a, b) => a.nextAt - b.nextAt)
    .map((s) => ({
      id: `schedule-${s.id}`,
      when: "future",
      time: whenText(s.nextAt),
      title: s.name,
      detail: cadenceLabel(s.cadence),
    }));

  const events: TimelineEvent[] = [...past, ...now, ...future];
  if (!events.length) return null;

  return (
    <Timeline
      className="max-w-none"
      events={events}
      visibleCount={events.length}
    />
  );
}

export function CommitActivity() {
  const commits = useBoard((s) => s.repoCommits);

  // heat-graph's own computeGrid defaults `start` to `end - 364 days` when a
  // caller omits it — that is the bounded, GitHub-style span the element is
  // built to draw. repoCommits is now fetched 200 deep, which for a quiet
  // repo can reach back years, so the range is capped to that same 364 days
  // and `total` counts only the commits that land inside it, not all 200.
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const capStart = new Date(end);
  capStart.setDate(capStart.getDate() - 364);

  const counts = new Map<string, number>();
  let earliest = end;
  for (const c of commits) {
    const day = new Date(c.at);
    day.setHours(0, 0, 0, 0);
    if (day < capStart) continue;
    counts.set(localDayKey(c.at), (counts.get(localDayKey(c.at)) ?? 0) + 1);
    if (day < earliest) earliest = day;
  }

  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  // Fewer than 5 commits, or every one on the same day, isn't a heat map.
  if (total < 5 || counts.size <= 1) return null;

  const data: DataPoint[] = [...counts.entries()].map(([date, count]) => ({ date, count }));

  return (
    <ActivityGraph
      className="max-w-none"
      data={data}
      start={earliest}
      end={end}
      title="Commits"
      total={`${total} commit${total === 1 ? "" : "s"}`}
    />
  );
}
