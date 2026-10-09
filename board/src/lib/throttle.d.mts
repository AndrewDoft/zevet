export function throttle(
  fn: () => void,
  ms: number,
  timers?: { set: (f: () => void, ms: number) => unknown; clear: (h: unknown) => void },
): (() => void) & { flush(): void };
