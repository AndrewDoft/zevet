export const REPEAT_SAME: number;
export const ERROR_LOOP: number;
export const PING_PONG: number;
export const MONOLOGUE: number;
export function detectStuck(
  messages: ReadonlyArray<{ role?: string; content?: unknown }>,
): { pattern: "repeat" | "error-loop" | "ping-pong" | "monologue"; detail: string } | null;
