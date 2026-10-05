export const NOT_OPEN: string;
export function isNotOpen(r: { ok?: boolean; error?: string } | null | undefined): boolean;
export function shownError(err: string | undefined, fallback: string): string;
