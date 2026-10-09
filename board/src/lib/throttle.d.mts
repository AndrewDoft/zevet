export function throttle(fn: () => void, ms: number): (() => void) & { flush(): void };
