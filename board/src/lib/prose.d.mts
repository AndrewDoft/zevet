export type InlinePart = { kind: "text" | "b" | "code"; text: string };

export const INLINE_MD: RegExp;

export function mdSafe(text: string): string;
export function inlineParts(text: string | null | undefined): InlinePart[];