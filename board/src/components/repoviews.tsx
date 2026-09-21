/**
 * The repo's own history, and the agent runs waiting on a clock.
 *
 * Both of these were left unbuilt in 0.2.14 for the same reason: the elements
 * ask for facts zevet did not have. Rather than feed them invented numbers,
 * the facts were built.
 *
 * - `checkpoint-history` wants a files-changed count per commit. The status
 *   poll only ever knew the sha had MOVED; `repo-stats.js` reads what moved in
 *   it, from `git log --shortstat`.
 * - `schedule-card` wants scheduled runs. zevet had none; `desktop/schedule.js`
 *   and the timer in main.js are them.
 */
import { CheckpointHistory, type Checkpoint } from "./assistant-ui/elements/checkpoint-history";
import { ScheduleCard, type ScheduleRun } from "./assistant-ui/elements/schedule-card";
import { cadenceLabel, whenText } from "../lib/when.mjs";
import { selectStrip, toggleSchedule, useBoard } from "../lib/board";

export function Checkpoints() {
  const commits = useBoard((s) => s.repoCommits);
  const { machine } = useBoard(selectStrip);

  // One commit is "the repo exists", not a history. And a build whose desktop
  // app predates `commits` reports none at all, which is not an error.
  if (commits.length < 2) return null;

  const head = (machine && (machine.repo as { sha?: string } | undefined)?.sha) || "";
  const items: Checkpoint[] = commits.map((c) => ({
    id: c.sha,
    label: c.subject || c.sha.slice(0, 8),
    at: whenText(c.at),
    files: c.files,
  }));

  /* ⚠️ NO `onRestore`, deliberately. The element offers one and zevet's
   * contract is that it does not touch your git history — `repo-stats.js` runs
   * `log` and has no counterpart that checks out. A restore button that did
   * nothing would be the ToolError Retry mistake again; one that worked would
   * be a different product. */
  return (
    <CheckpointHistory
      className="max-w-none"
      checkpoints={items}
      currentId={items.some((i) => i.id.startsWith(head)) ? items.find((i) => i.id.startsWith(head))!.id : items[0].id}
    />
  );
}

export function Schedules() {
  const schedules = useBoard((s) => s.schedules);
  if (!schedules.length) return null;

  return (
    <>
      {schedules.map((s) => {
        const history: ScheduleRun[] = s.history.map((h) => ({
          id: h.id,
          at: whenText(h.at),
          ok: h.ok,
        }));
        return (
          <ScheduleCard
            key={s.id}
            className="max-w-none"
            name={s.name}
            cadence={cadenceLabel(s.cadence)}
            // A disabled schedule has a nextAt in its record, and printing it
            // would say it is about to run when it is not.
            nextRun={s.enabled ? whenText(s.nextAt) : "paused"}
            enabled={s.enabled}
            history={history}
            onToggle={() => void toggleSchedule(s.id)}
          />
        );
      })}
    </>
  );
}
