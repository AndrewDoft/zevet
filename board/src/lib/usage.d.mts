export const CONTEXT_FLOOR: number;
export function windowFor(reported: number | null | undefined, model?: string | null): number;

export interface UsageReading {
  context: number;
  cacheHit: number | null;
  model: string | null;
  input: number;
  cachedInput: number;
  output: number;
}

export function usageOf(payload: unknown): UsageReading | null;
