export const WINDOW: number;
export function tail<T>(messages: readonly T[], more?: number): { shown: readonly T[]; hidden: number };
export function moreFor(state: { key: string; n: number }, key: string): number;
export function widen(state: { key: string; n: number }, key: string): { key: string; n: number };
