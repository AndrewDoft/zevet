export const HUES: number;
export const ADD_TINT: number;
export const DEL_TINT: number;
export type AuthorTokens = { add: string; del: string; addBg: string; delBg: string };
export type AuthorStyle = Partial<Record<"--diff-add" | "--diff-del" | "--diff-add-bg" | "--diff-del-bg", string>>;
export function authorIndex(actor: string | null | undefined, roster: Array<{ actor: string }>): number;
export function authorTokens(actor: string | null | undefined, roster: Array<{ actor: string }>): AuthorTokens | null;
export function authorStyle(actor: string | null | undefined, roster: Array<{ actor: string }>): AuthorStyle;
export function lastAuthor(who: Record<string, number> | null | undefined): string | null;
