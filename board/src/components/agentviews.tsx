/**
 * Views onto the active console's transcript that are not "the conversation":
 * a trace of the last turn's tool calls, the live plan, running subagents,
 * files touched, and subagent handoffs. Each reads `useBoard(selectActiveConsole)`
 * directly rather than taking props — these are dashboard cards, not children
 * of the thread, and every one of them renders nothing when it has nothing to
 * show. A card of zeros is a worse signal than no card.
 *
 * Same untrusted-args problem as tools.tsx (three CLIs, fields renamed across
 * versions), so the same small reader helpers are duplicated here rather than
 * imported — tools.tsx does not export them.
 */
import type { ThreadMessageLike } from "@assistant-ui/react";
import { selectActiveConsole, useBoard } from "../lib/board";
import { AgentHandoff } from "./assistant-ui/elements/agent-handoff";
import { AgentPlan } from "./assistant-ui/elements/agent-plan";
import { ArtifactCard } from "./assistant-ui/elements/artifact-card";
import { TaskCard, type TaskCardState } from "./assistant-ui/elements/task-card";
import { TraceWaterfall, type SpanStatus, type TraceSpan } from "./assistant-ui/elements/trace-waterfall";

/* ---------------------------------------------------------------------------
 * Readers. Same shape as tools.tsx's `rec` / `str` / `pick`: each answers
 * "what is this, if it is anything" rather than assuming a CLI's shape.
 * ------------------------------------------------------------------------- */

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

/** The last two path segments — the same trim `tools.tsx#shortPath` uses,
 *  duplicated because it is not exported. */
function shortPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length <= 2 ? p : parts.slice(-2).join("/");
}

/**
 * The tool-call part transcript.mjs actually produces, including `startedAt`
 * / `endedAt` — fields real at runtime but absent from @assistant-ui/react's
 * own `ThreadMessageLike` type, so a plain narrow leaves them untyped. The
 * cast below is the boundary where that gap is bridged, once.
 */
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
      // whole card down. Same guard as knowledge.tsx's copy of this loop.
      if (typeof c.toolName === "string" && match(c.toolName.toLowerCase())) out.push(c);
    }
  }
  return out;
}

function lastAssistantMessage(
  messages: readonly ThreadMessageLike[],
): ThreadMessageLike | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") return messages[i];
  }
  return undefined;
}

function useTranscriptMessages(): readonly ThreadMessageLike[] {
  return useBoard(selectActiveConsole)?.transcript.messages ?? [];
}

/* ---------------------------------------------------------------------------
 * 1. TurnTrace — the most recent assistant message's tool calls as a
 *    waterfall, timed off zevet's own startedAt/endedAt stamps.
 * ------------------------------------------------------------------------- */

export function TurnTrace() {
  const messages = useTranscriptMessages();
  const turn = lastAssistantMessage(messages);
  const calls = turn ? toolCalls(turn.content) : [];
  if (!calls.length) return null;

  /* ⚠️ THE CLOCK, NOT Date.now() IN THE RENDER BODY. A running span is
     drawn from its start to "now", and reading `now` here meant it advanced
     only when something ELSE caused a re-render — so the waterfall crept
     forward on unrelated hub traffic, stood still while the app was quiet,
     and every other bar changed width with it because the total moved. The
     store already publishes a 1s tick for exactly this; subscribing makes the
     bars advance because time passed rather than because React ran. Same fix
     as the file tree's staleness marks. */
  useBoard((s) => s.tick);
  const nowMs = Date.now();
  const baseline = Math.min(...calls.map((c) => c.startedAt ?? nowMs));

  // Flat, not nested: a tool call carries no parent id, so there is nothing
  // in the data that would justify a depth other than 0.
  const spans: TraceSpan[] = calls.map((c, i) => {
    const start = c.startedAt ?? baseline;
    const end = c.endedAt ?? nowMs;
    const status: SpanStatus = !c.endedAt ? "running" : c.isError ? "failed" : "completed";
    return {
      id: c.toolCallId || String(i),
      name: c.toolName,
      depth: 0,
      startMs: start - baseline,
      durationMs: Math.max(0, end - start),
      status,
    };
  });
  const totalMs = Math.max(1, ...spans.map((s) => s.startMs + s.durationMs));

  return <TraceWaterfall spans={spans} totalMs={totalMs} visibleCount={spans.length} />;
}

/* ---------------------------------------------------------------------------
 * 2. AgentPlanView — the plan from the most recent TodoWrite call.
 * ------------------------------------------------------------------------- */

const isTodoWrite = (n: string) => n === "todowrite" || n === "todo_write" || n === "todo";
const isActiveStatus = (s: string) => s === "in_progress" || s === "active";
const isDoneStatus = (s: string) => s === "completed" || s === "done";

export function AgentPlanView() {
  const messages = useTranscriptMessages();
  const calls = allToolCalls(messages, isTodoWrite);
  const latest = calls[calls.length - 1];
  if (!latest) return null;

  const raw = rec(latest.args).todos;
  const todos = Array.isArray(raw) ? raw : [];
  if (!todos.length) return null;

  const steps = todos.map((t, i) => str(rec(t).content, `step ${i + 1}`));
  const activeIndex = todos.findIndex((t) => isActiveStatus(str(rec(t).status).toLowerCase()));
  const completedCount = todos.filter((t) => isDoneStatus(str(rec(t).status).toLowerCase())).length;

  return <AgentPlan steps={steps} activeIndex={activeIndex >= 0 ? activeIndex : completedCount} />;
}

/* ---------------------------------------------------------------------------
 * 3. TaskCards — one card per subagent dispatch.
 * ------------------------------------------------------------------------- */

const isTask = (n: string) => n === "task" || n === "subagent";

export function TaskCards() {
  const messages = useTranscriptMessages();
  const calls = allToolCalls(messages, isTask);
  if (!calls.length) return null;

  return (
    <div className="flex w-full flex-col gap-2">
      {calls.map((c, i) => {
        const kind = pick(c.args, "subagent_type", "agent", "type") || "agent";
        const label = pick(c.args, "description", "prompt", "task") || kind;
        const state: TaskCardState = !c.endedAt ? "working" : c.isError ? "failed" : "done";
        const elapsed =
          c.startedAt && c.endedAt
            ? `${Math.max(0, Math.round((c.endedAt - c.startedAt) / 1000))}s`
            : undefined;
        return (
          <TaskCard
            key={c.toolCallId || i}
            label={label}
            meta={kind}
            state={state}
            elapsed={elapsed}
          />
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * 4. Artifacts — files the agent wrote, one card per path, most recent last.
 * ------------------------------------------------------------------------- */

const isWrite = (n: string) =>
  n === "write" || n === "edit" || n === "multiedit" || n === "patch" || n === "file_change";

function artifactPath(args: unknown): string {
  return pick(args, "file_path", "filePath", "path", "file");
}

export function Artifacts() {
  const messages = useTranscriptMessages();
  const calls = allToolCalls(messages, isWrite);

  // Dedupe by path, keeping insertion order so re-touching a file moves its
  // card to the end — "most recent last", as asked.
  const byPath = new Map<string, { count: number; last: ToolCallLike }>();
  for (const c of calls) {
    const path = artifactPath(c.args);
    if (!path) continue;
    const prev = byPath.get(path);
    byPath.delete(path);
    byPath.set(path, { count: (prev?.count ?? 0) + 1, last: c });
  }
  if (!byPath.size) return null;

  return (
    <div className="flex w-full flex-col gap-2">
      {[...byPath.entries()].map(([path, { count, last }]) => {
        const generating = !last.endedAt;
        const failed = Boolean(last.isError);
        const meta = `${count} edit${count === 1 ? "" : "s"}${failed ? " · failed" : ""}`;
        // Only meaningful while writing: the new content an in-flight Write/
        // Edit carries in its args, before there is any result to read.
        const afterText = pick(last.args, "new_string", "newString", "new", "content", "replace");
        const words = afterText ? afterText.trim().split(/\s+/).filter(Boolean).length : 0;
        return (
          <ArtifactCard
            key={path}
            title={shortPath(path)}
            meta={meta}
            generating={generating}
            words={words}
          />
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * 5. Handoffs — one per Task dispatch, this console handing off to a subagent.
 * ------------------------------------------------------------------------- */

export function Handoffs() {
  const active = useBoard(selectActiveConsole);
  const messages = active?.transcript.messages ?? [];
  const calls = allToolCalls(messages, isTask);
  if (!calls.length) return null;

  const from = active?.agent || "agent";

  return (
    <div className="flex w-full flex-col gap-3">
      {calls.map((c, i) => {
        const to = pick(c.args, "subagent_type", "agent", "type") || "agent";
        const reason = pick(c.args, "description", "prompt", "task");
        return (
          <AgentHandoff
            key={c.toolCallId || i}
            from={from}
            to={to}
            reason={reason}
            // Nothing in a Task call's args names what context it was handed —
            // that lives in the subagent's own prompt, which zevet does not
            // parse apart from `description`/`prompt`. Left empty rather than
            // guessed.
            carried={[]}
            settled={Boolean(c.endedAt)}
          />
        );
      })}
    </div>
  );
}
