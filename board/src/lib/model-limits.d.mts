/** Minimal localStorage-shaped store: window.localStorage in the app, a fake
 *  in tests. */
export interface LimitStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Whether a closed run's plain error text (transcript.mjs's `plainError`
 *  output) is a free-daily/usage-limit one. */
export function isLimitMessage(text: string | null | undefined): boolean;

/** OpenRouter's `X-RateLimit-Reset` off a raw agent error payload, ms epoch,
 *  else null. */
export function resetFromPayload(payload: unknown): number | null;

/** Record that `modelId` is limited until `resetAt` (ms epoch), or the next
 *  UTC midnight when `resetAt` is falsy. */
export function recordModelLimit(
  storage: LimitStorage,
  modelId: string,
  resetAt: number | null,
  now?: number,
): void;

/** Forget a model's limit. */
export function clearModelLimit(storage: LimitStorage, modelId: string): void;

/** The reset time (ms epoch) for a still-limited model, else null. */
export function modelLimitedUntil(storage: LimitStorage, modelId: string, now?: number): number | null;

/** Model ids reordered so any still-limited ones sink below the rest. */
export function sortByLimit(ids: readonly string[], storage: LimitStorage, now?: number): string[];
