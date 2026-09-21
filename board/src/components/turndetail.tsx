/**
 * What the agent actually did this turn, on request.
 *
 * ⚠️ CLOSED BY DEFAULT, for the reason the meters are. The first version of
 * the run meters was three cards always open under the transcript; on a real
 * window that took two thirds of the pane's height and left the conversation —
 * the thing the view exists for — a strip at the top. These are five more
 * panels. They sit behind a row.
 *
 * Everything here is derived from the transcript that is already on screen.
 * Nothing new is fetched, and nothing is shown that the agent did not do: each
 * view returns null rather than render an empty card.
 */
import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import {
  AgentPlanView,
  Artifacts,
  Handoffs,
  TaskCards,
  TurnTrace,
} from "./agentviews";
import { CommandRuns, NextStep, Pages, StoppedRuns } from "./moreviews";
import { Citations, MathBlocks, Reads } from "./knowledge";
import { Provenance } from "./provenance";
import { ComputerUse } from "./permits";
import { RawOutput } from "./rawoutput";
import { ResearchReportView, SubagentGraph } from "./graphviews";
import { RunSpec } from "./runspec";
import { AskAgain, Branches, EditAndAsk } from "./rewind";
import { Speakers } from "./speech";
import { McpServerPanel } from "./assistant-ui/elements/mcp-server-panel";
import { selectActiveConsole, useBoard } from "../lib/board";

/** The MCP servers claude announced at startup, if it announced any. Which
 *  tools an agent can actually reach is worth seeing before you believe what
 *  it says it cannot do. */
function McpServers() {
  const active = useBoard(selectActiveConsole);
  const servers = useBoard((s) => (active ? s.mcpServers[active.key] : undefined));
  if (!servers || !servers.length) return null;

  return (
    <McpServerPanel
      className="max-w-none"
      servers={servers.map((s, i) => ({
        id: `${s.name}-${i}`,
        name: s.name,
        transport: "stdio",
        status: s.status === "connected" ? "connected" : s.status === "failed" ? "failed" : "connecting",
        tools: s.tools,
      }))}
    />
  );
}

export function TurnDetail() {
  const active = useBoard(selectActiveConsole);
  const [open, setOpen] = useState(false);
  if (!active) return null;

  const tools = active.transcript.messages.reduce(
    (n, m) => n + (Array.isArray(m.content) ? m.content.filter((p) => p.type === "tool-call").length : 0),
    0,
  );
  // Nothing has happened yet. A row that opens onto five empty panels is worse
  // than no row.
  if (!tools) return null;

  return (
    <div className="turn-detail">
      <button
        type="button"
        className="run-meters-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRightIcon className="chev size-3.5 shrink-0 opacity-60" />
        <span>What it did</span>
        <span className="spacer" />
        <span className="tabular-nums">{tools} tool {tools === 1 ? "call" : "calls"}</span>
      </button>

      {open ? (
        <div className="turn-detail-body">
          {/* Ordered the way you would ask: what was the plan, what stopped
              it, what is next, how long did each step take, then the detail —
              what it ran, what it read, what it looked up, who it handed to,
              and finally what it was launched with. */}
          <AgentPlanView />
          <ResearchReportView />
          <StoppedRuns />
          <NextStep />
          <TurnTrace />
          <CommandRuns />
          <Reads />
          {/* What it saw, and where it clicked on it. Empty on every run with
              computer use switched off, which is every run by default. */}
          <ComputerUse />
          <Pages />
          <Citations />
          {/* Which paths it named, and whether they exist. The one panel here
              that can catch the agent being wrong rather than just show what
              it did. */}
          <Provenance />
          <MathBlocks />
          <TaskCards />
          <SubagentGraph />
          <Handoffs />
          <Artifacts />
          <McpServers />
          <RawOutput />
          <Speakers />
          {/* Asking again, from here. A fork leaves this run where it is and
              starts a branch — see rewind.tsx, and note that it is not a
              rewind into the middle of the conversation, which neither CLI
              can do. */}
          <Branches />
          <AskAgain />
          <EditAndAsk />
          <RunSpec />
        </div>
      ) : null}
    </div>
  );
}
