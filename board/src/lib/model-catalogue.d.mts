import type { ModelPrice } from "./model-prices.mjs";
export type CatalogueRow = { id: string; name: string; engine: string; payers: string[]; available: boolean; price: ModelPrice | null; runMedian: number | null };
export type CatalogueSource = {
  agents: ReadonlyArray<{ name: string; ok: boolean; signedIn: boolean; models?: ReadonlyArray<{ id: string; name: string }> }>;
  credentials?: ReadonlyArray<{ id: string; scope: string; provider: string; kind: string; last4: string; addedBy?: string }>;
  ladder?: ReadonlyArray<{ credentialId: string }>;
  consoles?: ReadonlyArray<{ usage?: { model: string | null; cost: number | null } }>;
};
export function formatPrice(n: number | null | undefined): string;
export function formatPair(price: ModelPrice | null): string;
export function formatCost(usd: number | null | undefined): string;
export function median(xs: ReadonlyArray<number | null | undefined>): number | null;
export function buildCatalogue(src: CatalogueSource): CatalogueRow[];
