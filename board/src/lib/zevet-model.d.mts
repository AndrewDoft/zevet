export const ZEVET_MODEL: { id: string; name: string; keywords: string[]; verified: boolean };
export function withZevet<T>(models: T[], agents: Array<{ ok: boolean }>): Array<T | typeof ZEVET_MODEL>;
export function defaultPick(all: Array<{ id: string; disabled?: boolean; verified?: boolean }>, last: string, aliasOf: (id: string) => string): string;
