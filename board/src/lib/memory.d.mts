export interface PinnedNote { id: string; repo: string; path: string; text: string; hash: string; author: string; createdAt: number; updatedAt: number; retired: boolean; stale: "fresh" | "stale" | "missing" | "unknown" }
export function needsReview(notes: PinnedNote[]): PinnedNote[];
export function flagText(note: PinnedNote): string;
export function stalePaths(notes: PinnedNote[]): Set<string>;
export function staleChipText(notes: PinnedNote[]): string;
