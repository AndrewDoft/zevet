export function whileOpen<A extends unknown[], R>(currentRoot: () => string | null, dir: string, fn: (...a: A) => R): (...a: A) => R | undefined;
