import type { ThreadMessageLike } from "@assistant-ui/react";

export interface ToolIndexEntry {
  message: number;
  part: number;
}

export interface TranscriptState {
  /** Ready to hand straight to useExternalStoreRuntime. */
  messages: ThreadMessageLike[];
  /** Index of the assistant message being streamed into, or -1. */
  openIndex: number;
  /** toolCallId -> where that call's part lives, so a result can find it. */
  toolIndex: Record<string, ToolIndexEntry>;
  running: boolean;
}

export interface TranscriptOptions {
  agent?: string;
  localRoot?: string | null;
}

export type TranscriptEvent =
  | { type: "you"; text: string }
  | { type: "agent"; payload: unknown }
  | { type: "stdout-line"; line: string }
  | { type: "stderr"; text: string }
  | { type: "exit"; code?: number | null; error?: string | null };

export function emptyTranscript(): TranscriptState;
export function appendUserText(state: TranscriptState, text: string): TranscriptState;
export function appendRaw(state: TranscriptState, text: string): TranscriptState;
export function appendAgentPayload(
  state: TranscriptState,
  payload: unknown,
  opts?: TranscriptOptions,
): TranscriptState;
export function closeTranscript(
  state: TranscriptState,
  ending?: { code?: number | null; error?: string | null },
): TranscriptState;
export function assembleTranscript(
  events: TranscriptEvent[],
  opts?: TranscriptOptions,
): TranscriptState;
export function _resetIds(): void;
