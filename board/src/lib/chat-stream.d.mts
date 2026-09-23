import type { ThreadMessageLike } from "@assistant-ui/react";
import type { TranscriptState } from "./transcript.d.mts";

/** Usage reading shape shared with ConsoleEntry.usage */
export interface UsageReading {
  context: number;
  cacheHit: number | null;
  model: string | null;
  input: number;
  cachedInput: number;
  output: number;
}

export interface ChatThread {
  transcript: TranscriptState;
  /** Streamed text of the block in flight; replaced when the block lands. */
  draft: string;
  /** A turn is in flight. */
  busy: boolean;
  /** Usage from the last assistant message, same shape as ConsoleEntry.usage. */
  usage: UsageReading | null;
}

export interface StoredMessage {
  role: "user" | "assistant";
  text: string;
  at?: number;
}

export function emptyChatThread(): ChatThread;
export function fromStored(messages: StoredMessage[]): ChatThread;
export function sendUser(thread: ChatThread, text: string): ChatThread;
export function chatEvent(thread: ChatThread, evt: unknown): ChatThread;
export function failTurn(thread: ChatThread, error: string): ChatThread;
export function visibleMessages(thread: ChatThread): ThreadMessageLike[];
