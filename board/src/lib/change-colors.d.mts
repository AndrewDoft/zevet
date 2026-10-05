type Entry = { actor?: string } | null | undefined;
export const CHANGE_FALLBACKS: { added: { fg: string; bg: string }; removed: { fg: string; bg: string } };
export function authorChangeTokens(author: string | undefined, roster?: readonly Entry[], kind?: "added" | "removed"): Record<string, string>;
export function authorIdentityTokens(author: string | undefined, roster?: readonly Entry[]): Record<string, string>;
