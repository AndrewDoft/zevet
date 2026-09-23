/**
 * More views onto the active console's transcript, in the same spirit as
 * agentviews.tsx: dashboard cards, not thread children, each reading
 * `useBoard(selectActiveConsole)` directly and rendering nothing when it has
 * nothing honest to show.
 *
 * Reader helpers (`rec`/`str`/`pick`) are duplicated from agentviews.tsx
 * rather than imported — that file does not export them, same as tools.tsx.
 */
import { useState } from "react";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { selectActiveConsole, useBoard } from "../lib/board";
import { CodeRunner, type RunState } from "./assistant-ui/elements/code-runner";
import {
  RecommendationCard,
  type RecommendationState,
} from "./assistant-ui/elements/recommendation-card";
import { StoppedRun } from "./assistant-ui/elements/stopped-run";
import { WebPreview } from "./assistant-ui/elements/web-preview";

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

/** A tool result flattened to text — same collapsing rule as tools.tsx's
 *  `resultText`, duplicated because it is not exported. */
function resultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map(resultText).filter(Boolean).join("\n");
  const o = rec(result);
  for (const k of ["text", "output", "aggregated_output", "stdout", "content", "result"]) {
    if (o[k] != null) return resultText(o[k]);
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

const lines = (text: string): string[] => (text ? text.replace(/\n+$/, "").split("\n") : []);

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
      // whole panel down. Same guard as knowledge.tsx's copy of this loop.
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

/** The text parts of a message, concatenated — content may be a plain
 *  string or an array, per the same guard every reader here uses. */
function textOf(content: ThreadMessageLike["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ");
}

function useTranscriptMessages(): readonly ThreadMessageLike[] {
  return useBoard(selectActiveConsole)?.transcript.messages ?? [];
}

/* ---------------------------------------------------------------------------
 * 1. CommandRuns — one CodeRunner per shell tool call in the most recent
 *    assistant message.
 * ------------------------------------------------------------------------- */

const isBash = (n: string) =>
  n === "bash" || n === "shell" || n === "run_command" || n === "command_execution";

export function CommandRuns() {
  const messages = useTranscriptMessages();
  const turn = lastAssistantMessage(messages);
  const calls = turn ? toolCalls(turn.content).filter((c) => typeof c.toolName === "string" && isBash(c.toolName.toLowerCase())) : [];
  if (!calls.length) return null;

  return (
    <div className="flex w-full flex-col gap-2">
      {calls.map((c, i) => {
        const code = pick(c.args, "command", "cmd", "script");
        if (!code) return null;
        const durationMs =
          c.startedAt && c.endedAt ? Math.max(0, c.endedAt - c.startedAt) : undefined;
        const state: RunState = !c.endedAt ? "running" : c.isError ? "error" : "ok";
        return (
          <CodeRunner
            key={c.toolCallId || i}
            language="bash"
            code={code}
            state={state}
            output={lines(resultText(c.result))}
            durationMs={durationMs}
          />
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * 2. Pages — one WebPreview per WebFetch tool call.
 * ------------------------------------------------------------------------- */

const isWebFetch = (n: string) => n === "webfetch" || n === "web_fetch";

export function Pages() {
  const messages = useTranscriptMessages();
  const calls = allToolCalls(messages, isWebFetch);
  if (!calls.length) return null;

  return (
    <div className="flex w-full flex-col gap-2">
      {calls.map((c, i) => {
        const url = pick(c.args, "url", "uri");
        if (!url) return null;
        let origin = url;
        try {
          origin = new URL(url).origin;
        } catch {
          // Not a parseable absolute URL — show it verbatim.
        }
        const text = resultText(c.result);
        return (
          <WebPreview
            key={c.toolCallId || i}
            origin={origin}
            loading={!c.endedAt}
            // No re-fetch capability to wire to a reload button — left off,
            // same reasoning as CommandRuns' missing onRun. Opening the real
            // fetched URL is an honest action, so that one is wired.
            onOpenExternal={() => window.open(url, "_blank", "noopener,noreferrer")}
          >
            {text ? (
              <div className="max-h-48 overflow-y-auto whitespace-pre-wrap px-3.5 py-2.5 text-xs leading-relaxed text-foreground/70">
                {text.slice(0, 4000)}
                {text.length > 4000 ? <span className="text-foreground/40">{"…truncated"}</span> : null}
              </div>
            ) : null}
          </WebPreview>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * 3. StoppedRuns — the last assistant turn, if it ended badly.
 * ------------------------------------------------------------------------- */

export function StoppedRuns() {
  const messages = useTranscriptMessages();
  const turn = lastAssistantMessage(messages);
  const status = turn?.status;
  if (!status || status.type !== "incomplete") return null;

  const reason = status.error != null ? str(status.error, status.reason) : status.reason;
  const text = textOf(turn.content);
  if (!text) return null;

  return <StoppedRun words={text.split(/\s+/).filter(Boolean)} reason={reason} />;
}

/* ---------------------------------------------------------------------------
 * 4. NextStep — the agent's own next pending todo, offered as a prompt.
 * ------------------------------------------------------------------------- */

const isTodoWrite = (n: string) => n === "todowrite" || n === "todo_write" || n === "todo";

export function NextStep() {
  const active = useBoard(selectActiveConsole);
  const sendPrompt = useBoard((s) => s.sendPrompt);
  const [state, setState] = useState<RecommendationState>("idle");
  const messages = active?.transcript.messages ?? [];
  const calls = allToolCalls(messages, isTodoWrite);
  const latest = calls[calls.length - 1];

  const raw = latest ? rec(latest.args).todos : undefined;
  const todos = Array.isArray(raw) ? raw : [];
  const pending = todos.find((t) => str(rec(t).status).toLowerCase() === "pending");
  if (!pending) return null;

  const text = str(rec(pending).content);
  if (!text) return null;

  return (
    <RecommendationCard
      state={state}
      question="Send this as the next prompt?"
      confidenceLabel="from the agent's plan"
      acceptedLabel="Sent"
      onAccept={() => {
        if (active) sendPrompt(active.key, text);
        setState("accepted");
      }}
    >
      {text}
    </RecommendationCard>
  );
}
