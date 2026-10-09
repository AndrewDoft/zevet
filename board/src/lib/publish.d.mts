export function consolePublisher<T>(read: () => readonly T[], write: (next: T[]) => void, ms?: number): (() => void) & { flush(): void };
