/**
 * QuotaNotice — elements/quota-banner.tsx over the ACTIVE console's
 * `limits` (lib/board.ts's `limitsOf`, off claude's `rate_limit_event`
 * payload; see RateWindow in lib/types.ts).
 *
 * This was refused a release ago: QuotaBanner wants `used`/`limit` as counts,
 * and the provider only ever hands over a ratio (`utilization`, 0..1) plus a
 * reset time. But a percentage IS a used-against-limit pair — used=the whole
 * number of points, limit=100, unit="%" — so nothing here is invented, it is
 * just measured in points-of-a-hundred instead of tokens. `unit` also carries
 * the window's own name ("5h", "7d"), since QuotaBanner has no separate slot
 * for it and the banner would otherwise show a bare, unlabelled percentage.
 *
 * Shows only the FULLEST window — the one closest to being hit is the one
 * worth a glance — not all of them.
 */
import { selectActiveConsole, useBoard } from "../lib/board";
import { whenText } from "../lib/when.mjs";
import { QuotaBanner } from "./assistant-ui/elements/quota-banner";

/** The provider's own window ids, as claude's `rate_limit_info.unifiedWindows`
 *  keys them. An id this doesn't know falls back to itself rather than being
 *  mislabelled as one of these two. */
const WINDOW_LABEL: Record<string, string> = {
  five_hour: "5h",
  seven_day: "7d",
};

/**
 * The same window, as a chip for the composer's own row.
 *
 * ⚠️ THE BANNER IS GONE FROM ABOVE THE TRANSCRIPT. Andrew: "a weird usage bar
 * under that skip permissions thing which should be in the chatbox next to
 * 126k/1.0M $0.1376". He is right that it belongs with the other two numbers
 * about this run — they answer one question together ("can I keep going"),
 * and a full-width banner over the conversation answers it far louder than it
 * deserves. Same data, same "fullest window only" rule, one chip.
 */
export function QuotaChip() {
  const active = useBoard(selectActiveConsole);
  const limits = active?.limits ?? [];
  if (!limits.length) return null;
  const fullest = limits.reduce((a, b) => (b.utilization > a.utilization ? b : a));
  const resetsIn = whenText(fullest.resetsAt);
  if (!resetsIn) return null;
  const used = Math.round(fullest.utilization * 100);
  const label = WINDOW_LABEL[fullest.key] ?? fullest.key;
  return (
    <span
      className="quota-chip"
      /* Coloured only when it is close enough to matter. A permanently amber
         number is a number nobody reads. */
      data-hot={String(used >= 80)}
      title={`${used}% of the ${label} window used, resets ${resetsIn}`}
    >
      {label} {used}%
    </span>
  );
}

export function QuotaNotice() {
  const active = useBoard(selectActiveConsole);
  const limits = active?.limits ?? [];
  if (!limits.length) return null;

  // The fullest window, not all of them — the one nearest its cap is the one
  // that explains why the agent is about to stop working.
  const fullest = limits.reduce((a, b) => (b.utilization > a.utilization ? b : a));

  // resetsAt is 0 when the agent gave no reset time (see RateWindow). Nothing
  // honest to put in the required `resetsIn` then, so the notice sits out
  // rather than printing "resets in ".
  const resetsIn = whenText(fullest.resetsAt);
  if (!resetsIn) return null;

  const used = Math.round(fullest.utilization * 100);
  const label = WINDOW_LABEL[fullest.key] ?? fullest.key;

  return (
    <QuotaBanner
      used={used}
      limit={100}
      unit={`% (${label})`}
      resetsIn={resetsIn}
      upgradeLabel="Upgrade"
      // No upgrade flow exists in zevet to wire this to — left unset, same
      // reasoning moreviews.tsx gives CommandRuns' missing onRun.
    />
  );
}
