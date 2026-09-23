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
  /** `slash_commands` from claude's init line; null until the first run. */
  slashCommands: string[] | null;
  /** The claude model this turn was actually sent on — chat.ts's noteModelLimit
   *  bookkeeping reads this rather than a live launch preference that may
   *  have moved on by the time an event arrives. Null before the first send. */
  model: string | null;
}

export interface StoredMessage {
  role: "user" | "assistant";
  text: string;
  at?: number;
}

export function emptyChatThread(): ChatThread;
export function fromStored(messages: StoredMessage[]): ChatThread;
export function sendUser(thread: ChatThread, text: string, model?: string | null): ChatThread;
export function chatEvent(thread: ChatThread, evt: unknown): ChatThread;
export function failTurn(thread: ChatThread, error: string): ChatThread;
export function visibleMessages(thread: ChatThread): ThreadMessageLike[];
