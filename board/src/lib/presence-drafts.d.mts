export const DRAFT_MAX: number;
export const DRAFT_DEBOUNCE_MS: number;
export const DRAFT_STALE_MS: number;
export interface DraftField { text: string; target: string | null; ts: number }
export function draftField(o: { text: string; target?: string | null; hidden: boolean; now?: number }): DraftField | null;
export function liveDrafts(states: Map<number, any>, selfId: number, now?: number): Record<string, DraftField>;
export function draftFor(drafts: Record<string, { text: string; target: string | null; ts: number }>, actor: string): { text: string; target: string | null; ts: number } | undefined;
