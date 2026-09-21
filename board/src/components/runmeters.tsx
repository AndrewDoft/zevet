/**
 * Context, spend and timing for the console you are watching.
 *
 * The rail's strip has always carried these numbers — `ctx 62k`, `cache 71%`,
 * `$0.18` — in a 258px mono line, which is the right density for a status bar
 * and the wrong one for actually reading them. The registry has elements built
 * for exactly this, sized for a chat column, and the conversation column has
 * the room the rail does not.
 *
 * So the strip keeps saying it at a glance, and this says it properly, under
 * the transcript, for the thread in front. Nothing new is measured: every
 * number here is already in the store, put there by `usageOf` off the agent's
 * own usage payloads.
 */
import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { ContextBreakdown, type ContextSegment } from "./assistant-ui/elements/context-breakdown";
import { CostMeter } from "./assistant-ui/elements/cost-meter";
import { MessageTiming } from "./assistant-ui/elements/message-timing";
import { selectActiveConsole, selectStrip, useBoard } from "../lib/board";
import { ContextChart, ContextTicker, RunUsageTable } from "./usageviews";
import { ContextGauge } from "./mapviews";
import { tokens } from "../lib/fmt";

/** The fallback context window, used only when the agent hasn't said what its
 *  real one is (ConsoleUsage.window, lib/types.ts — claude's result payload
 *  carries `modelUsage[<model>].contextWindow`, which is 1,000,000 on
 *  opus-5[1m], not this). Smallest common window across agents, so a bar
 *  drawn against it undersells rather than oversells how full it is. */
const CONTEXT_LIMIT = 200_000;

const money = (n: number | null) => (n == null ? "$0.00" : `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".00")}`);

export function RunMeters() {
  const { live } = useBoard(selectStrip);
  const active = useBoard(selectActiveConsole);
  const [open, setOpen] = useState(false);

  // Nothing has reported usage yet. An empty meter is worse than no meter —
  // it reads as "zero tokens", which is never true of a running agent.
  if (!active || live.context == null) return null;

  const context = live.context;
  // The console's own reported window, when it said — see the CONTEXT_LIMIT
  // comment above.
  const window = active.usage.window ?? CONTEXT_LIMIT;
  const cached = live.cacheHit != null ? Math.round(context * (live.cacheHit / 100)) : 0;
  const fresh = Math.max(0, context - cached);

  const segments: ContextSegment[] = [
    { label: "cached", tokens: cached, tint: "var(--chart-3)" },
    { label: "prompt", tokens: fresh, tint: "var(--chart-1)" },
  ].filter((s) => s.tokens > 0);

  const model = live.model || active.model || active.agent;
  const messages = active.transcript.messages.length;
  // ThreadMessageLike allows content to be a bare string, which has no parts.
  const tools = active.transcript.messages.reduce(
    (n, m) => n + (Array.isArray(m.content) ? m.content.filter((part) => part.type === "tool-call").length : 0),
    0,
  );

  return (
    <div className="run-meters">
      <button
        type="button"
        className="run-meters-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRightIcon className="chev size-3.5 shrink-0 opacity-60" />
        <span>Context, cost and timing</span>
        <span className="spacer" />
        {/* The one number worth carrying on the closed row: how full the
            window is, which is what makes a long session go wrong. */}
        <span className="tabular-nums">{Math.round((context / window) * 100)}% of {tokens(window)}</span>
      </button>

      {!open ? null : (
      <div className="run-meters-body">
      <ContextBreakdown className="max-w-none" segments={segments} limit={window} />

      {/* The same window, three ways, because they answer different questions:
          the gauge is "how close to full", the chart is "how fast did it get
          there", the ticker is the count itself. All three read the console's
          OWN usage rather than the strip, which is one global set of numbers
          for however many agents are running. */}
      <ContextGauge />
      <ContextChart />
      <ContextTicker />

      <CostMeter
        className="max-w-none"
        runCost={money(live.cost)}
        sessionCost={money(live.cost)}
        lines={[
          {
            model,
            inputTokens: context,
            outputTokens: 0,
            cost: money(live.cost),
            share: 1,
          },
        ]}
      />

      <MessageTiming
        className="max-w-none"
        streaming={active.running}
        stats={[
          { label: "messages", value: String(messages) },
          { label: "tool calls", value: String(tools) },
          // cacheHit is a raw ratio off the usage payload; printing it
          // unrounded put "70.74109720885467%" on screen.
          ...(live.cacheHit != null ? [{ label: "cache", value: `${Math.round(live.cacheHit)}%` }] : []),
          { label: "posture", value: active.mode },
        ]}
      />

      {/* Every console, not just this one. With three agents running the
          question is which of them is burning the window. */}
      <RunUsageTable />
      </div>
      )}
    </div>
  );
}
