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
  /** The id the AGENT sent -> where the NEWEST call with that id lives, so a
   *  result finds the call it belongs to. */
  toolIndex: Record<string, ToolIndexEntry>;
  /** Every part id already handed out, so a repeated one can be made unique.
   *  assistant-ui keys parts by toolCallId and throws on a duplicate. */
  byPartId: Record<string, true>;
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
