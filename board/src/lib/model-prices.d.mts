export type ModelPrice = { id: string; input: number; output: number; source: string; as_of: string };
export const MODEL_PRICES: readonly ModelPrice[];
export function priceOf(id: string): ModelPrice | null;
