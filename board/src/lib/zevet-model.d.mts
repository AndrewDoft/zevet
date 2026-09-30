export const ZEVET_MODEL: { id: string; name: string; keywords: string[]; verified: boolean };
export function withZevet<T>(models: T[], agents: Array<{ ok: boolean }>): Array<T | typeof ZEVET_MODEL>;
