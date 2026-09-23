import type { ThreadMessageLike } from "@assistant-ui/react";
import type { TranscriptState } from "./transcript.d.mts";

export interface ChatThread {
  transcript: TranscriptState;
  /** Streamed text of the block in flight; replaced when the block lands. */
  draft: string;
  /** A turn is in flight. */
  busy: boolean;
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
