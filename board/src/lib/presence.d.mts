export const AGENT_TTL_MS: number;
export const HINT_MAX_AGE_MS: number;
export interface Range { from: number; to: number; fromLine: number; toLine: number }
export interface Hint { ts: number; actor: string; agent: string; tool: string; input: Record<string, unknown> }
export function agentLabel(actor: string, agent: string): string;
export function agentClientId(actor: string, agent: string): number;
export function extractEdits(tool: string, input: unknown): Array<{ file: string | null; blocks: string[] }>;
export function patchBlocks(patch: string): Array<{ file: string; blocks: string[] }>;
export function sameFile(agentPath: string, relPath: string): boolean;
export function locateBlock(text: string, block: string): Range | null;
export function locateEdit(text: string, blocks: string[]): Range | null;
export function agentRanges(hints: Hint[], relPath: string, text: string, now?: number): Array<Range & { actor: string; agent: string; tool: string; ts: number }>;
