export const CONTEXT_FLOOR: number;

export interface UsageReading {
  context: number;
  cacheHit: number | null;
  model: string | null;
  input: number;
  cachedInput: number;
  output: number;
}

export function usageOf(payload: unknown): UsageReading | null;
