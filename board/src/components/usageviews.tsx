/**
 * Views onto `ConsoleEntry.usage` — the per-console usage record `recordUsage`
 * builds in board.ts, as opposed to `strip.live`, which is a single global
 * set of numbers that whichever console spoke last owns. With three agents
 * running, the strip cannot say whose numbers it is showing; these can,
 * because each one is attributed by the console that reported it.
 *
 * RunUsageTable reads every console in `myConsoles`, on purpose — it is the
 * "several agents at once" view. ContextChart and ContextTicker read only
 * the active console, same as runmeters.tsx.
 */
import { selectActiveConsole, selectMyConsoles, useBoard } from "../lib/board";
import { tokens } from "../lib/fmt";
import { Chart } from "./assistant-ui/elements/chart";
import { DataTable, type ModelUsage } from "./assistant-ui/elements/data-table";
import { NumberTicker } from "./assistant-ui/elements/number-ticker";

const money = (n: number | null) => (n == null ? "$0.00" : `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".00")}`);

/** One row per console that has reported usage, not just the active one —
 *  the point of this table is making the several-agents-at-once case
 *  readable, which the single-console strip and meters cannot do. */
export function RunUsageTable() {
  const consoles = useBoard(selectMyConsoles);
  const rows: ModelUsage[] = consoles
    .filter((c) => c.usage.context != null)
    .map((c) => ({
      name: c.usage.model || c.model || c.agent,
      context: tokens(c.usage.context!),
      cost: money(c.usage.cost),
    }));

  if (!rows.length) return null;

  // `cycle` re-triggers DataTable's row-entrance animation, same as
  // tools.tsx's DataTable uses: the count of rows, not a random number.
  return <DataTable className="max-w-none" rows={rows} cycle={rows.length} />;
}

/** The active console's context series as a trend. One point is not a
 *  trend, so this stays silent until there is a second reading to compare. */
export function ContextChart() {
  const active = useBoard(selectActiveConsole);
  const series = active?.usage.series ?? [];
  if (series.length < 2) return null;

  const value = series[series.length - 1]!;
  const prev = series[series.length - 2]!;
  const diff = value - prev;
  const sign = diff > 0 ? "+" : diff < 0 ? "-" : "";

  return (
    <Chart
      className="max-w-none"
      label="context"
      value={tokens(value)}
      delta={`${sign}${tokens(Math.abs(diff))}`}
      points={series}
      visibleCount={series.length}
      variant="area"
    />
  );
}

/** The active console's current context reading, rolled up as a headline
 *  number. Silent until that console has reported one. */
export function ContextTicker() {
  const active = useBoard(selectActiveConsole);
  const context = active?.usage.context;
  if (context == null) return null;

  return <NumberTicker value={context} label="tokens in context" />;
}
