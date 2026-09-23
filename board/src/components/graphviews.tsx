/**
 * Graph views onto the active console's transcript, same spirit as
 * moreviews.tsx and agentviews.tsx: dashboard cards, each reading
 * `useBoard(selectActiveConsole)` directly and rendering nothing when it has
 * nothing honest to show.
 *
 * Reader helpers (`rec`/`str`/`pick`) are duplicated from agentviews.tsx
 * rather than imported — that file does not export them, same as tools.tsx.
 * Only the helpers each component below actually needs are duplicated;
 * copying the unused ones too would trip noUnusedLocals for no reason.
 */
import { useState } from "react";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { selectActiveConsole, useBoard } from "../lib/board";
import { Diagram } from "./assistant-ui/elements/diagram";
import { FlowGraph, type FlowEdge, type FlowNode, type FlowNodeState } from "./assistant-ui/elements/flow-graph";
import { ResearchReport, type ReportSection, type SectionState } from "./assistant-ui/elements/research-report";
import { clamp } from "./assistant-ui/utils/range";

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function str(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

function pick(args: unknown, ...keys: string[]): string {
  const o = rec(args);
  for (const k of keys) {
    const v = str(o[k]);
    if (v) return v;
  }
  return "";
}

interface ToolCallLike {
  type: "tool-call";
  toolCallId?: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  startedAt?: number;
  endedAt?: number;
}

function toolCalls(content: ThreadMessageLike["content"]): ToolCallLike[] {
  if (!Array.isArray(content)) return [];
  return content.filter((p) => p.type === "tool-call") as unknown as ToolCallLike[];
}

function allToolCalls(
  messages: readonly ThreadMessageLike[],
  match: (toolNameLower: string) => boolean,
): ToolCallLike[] {
  const out: ToolCallLike[] = [];
  for (const m of messages) {
    for (const c of toolCalls(m.content)) {
      // `toolCalls` casts; a part with no toolName threw here and took the
      // whole graph down. Same guard as knowledge.tsx's copy of this loop.
      if (typeof c.toolName === "string" && match(c.toolName.toLowerCase())) out.push(c);
    }
  }
  return out;
}

/** A label truncated to fit a fixed-width box — FlowGraph's node div does
 *  not clip overflow itself, so long labels need shortening before they get
 *  there rather than after. */
function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…` : trimmed;
}

/* ---------------------------------------------------------------------------
 * 1. SubagentGraph — the run and its Task dispatches, as a flow diagram.
 * ------------------------------------------------------------------------- */

const isTask = (n: string) => n === "task" || n === "subagent";

export function SubagentGraph() {
  // Hooks first, unconditionally — the early `return null` below happens
  // after both, so render order never changes across renders.
  const active = useBoard(selectActiveConsole);
  const [zoom, setZoom] = useState(1);

  const messages = active?.transcript.messages ?? [];
  const taskCalls = allToolCalls(messages, isTask);
  if (!active || !taskCalls.length) return null;

  // The root sits at the vertical middle of its fan of children — a layout
  // choice, not a data value, so it doesn't run afoul of "nothing invented".
  const rootRow = Math.floor((taskCalls.length - 1) / 2);

  const taskNodes: FlowNode[] = taskCalls.map((c, i) => {
    const kind = pick(c.args, "subagent_type", "agent", "type") || "agent";
    const label = pick(c.args, "description", "prompt", "task") || kind;
    const hasResult = c.result !== undefined && c.result !== null;
    const state: FlowNodeState = c.isError
      ? "failed"
      : hasResult || !active.running || Boolean(c.endedAt)
        ? "done"
        : Boolean(c.startedAt)
          ? "active"
          : "pending";
    return {
      id: c.toolCallId || `task-${i}`,
      label: truncate(label, 14),
      column: 1,
      row: i,
      state,
    };
  });

  const nodes: FlowNode[] = [
    {
      id: "root",
      label: truncate(active.agent, 14),
      column: 0,
      row: rootRow,
      state: active.running ? "active" : "done",
    },
    ...taskNodes,
  ];
  const edges: FlowEdge[] = taskNodes.map((n) => ({ from: "root", to: n.id }));

  return (
    <Diagram
      title="Subagents"
      zoom={zoom}
      onZoomIn={() => setZoom((z) => clamp(z + 0.25, 0.5, 2))}
      onZoomOut={() => setZoom((z) => clamp(z - 0.25, 0.5, 2))}
      onReset={() => setZoom(1)}
      // No full-screen surface exists to expand into, so onExpand is left
      // unwired rather than faked — Diagram disables the button on its own
      // when the prop is undefined.
      className="max-w-none"
    >
      <FlowGraph nodes={nodes} edges={edges} visibleCount={nodes.length} className="max-w-none" />
    </Diagram>
  );
}

/* ---------------------------------------------------------------------------
 * 2. ResearchReportView — the plan's sections, credited with the web calls
 *    made while each was the active todo.
 * ------------------------------------------------------------------------- */

const isTodoWrite = (n: string) => n === "todowrite" || n === "todo_write" || n === "todo";
const isWebCall = (n: string) =>
  n === "websearch" || n === "web_search" || n === "webfetch" || n === "web_fetch";

/** The text parts of a message, concatenated — same guard every reader here
 *  uses for content that may be a plain string or an array of parts. */
function textOf(content: ThreadMessageLike["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ");
}

export function ResearchReportView() {
  const active = useBoard(selectActiveConsole);
  const messages = active?.transcript.messages ?? [];

  // One pass over every tool call in transcript order (message order, then
  // content order within a message — the same order toolCalls/allToolCalls
  // read elsewhere). `currentTodo` is whichever todo was in_progress as of
  // the most recent TodoWrite snapshot seen so far; a web call seen while it
  // is set gets credited to it. That is the attribution the transcript
  // actually supports — not a guess, since a TodoWrite snapshot always
  // precedes the work it describes.
  let currentTodo: string | undefined;
  let latestTodos: unknown[] = [];
  const sourceCounts = new Map<string, number>();
  let sourcesRead = 0;

  for (const m of messages) {
    for (const c of toolCalls(m.content)) {
      if (typeof c.toolName !== "string") continue;
      const name = c.toolName.toLowerCase();
      if (isTodoWrite(name)) {
        const raw = rec(c.args).todos;
        const todos = Array.isArray(raw) ? raw : [];
        latestTodos = todos;
        const inProgress = todos.find((t) => str(rec(t).status).toLowerCase() === "in_progress");
        currentTodo = inProgress ? str(rec(inProgress).content) : undefined;
      } else if (isWebCall(name)) {
        sourcesRead += 1;
        if (currentTodo) sourceCounts.set(currentTodo, (sourceCounts.get(currentTodo) ?? 0) + 1);
      }
    }
  }

  // A plan, not a research report, when nothing was actually looked up —
  // agentviews.tsx's AgentPlanView already covers that case.
  if (sourcesRead === 0) return null;

  const sections: ReportSection[] = latestTodos
    .map((t, i) => {
      const heading = str(rec(t).content);
      const status = str(rec(t).status).toLowerCase();
      const state: SectionState =
        status === "completed" ? "done" : status === "in_progress" ? "writing" : "pending";
      return { id: `sec-${i}`, heading, state, sources: sourceCounts.get(heading) ?? 0 };
    })
    .filter((s) => s.heading);

  let title = "";
  for (const m of messages) {
    if (m.role !== "user") continue;
    const text = textOf(m.content);
    if (text) {
      title = truncate(text, 80);
      break;
    }
  }

  return (
    <ResearchReport
      title={title}
      sections={sections}
      sourcesRead={sourcesRead}
      className="max-w-none"
    />
  );
}
