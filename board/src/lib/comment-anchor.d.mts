export const QUOTE_MAX: number;
export const HUNK_LINES_MAX: number;
export const HUNK_LINE_MAX: number;
export const AGENT_TEXT_MAX: number;
export type DiffKind = "context" | "added" | "removed";
export type CommentRef =
  | { kind: "turn"; session: string; agent: string; turn: number; quote: string }
  | { kind: "hunk"; file: string; session: string; lines: Array<{ kind: DiffKind; text: string }> };
export interface PlanStepRef { session: string; index: number; text: string }
export function turnRef(o: { session: string; agent?: string; turn: number; quote?: string }): CommentRef | null;
export function hunkRef(o: { file: string; lines: Array<{ kind: DiffKind; text: string }>; session?: string }): CommentRef | null;
export function cleanRef(ref: unknown): CommentRef | null;
export function cleanStep(step: unknown): PlanStepRef | null;
export function stepState(step: unknown, steps: Array<{ text: string; status?: string }>): string | null;
export function frameForAgent(o: { author?: string; text: string; ref?: unknown; step?: unknown; lineText?: string | null; line?: number | null }): string;
