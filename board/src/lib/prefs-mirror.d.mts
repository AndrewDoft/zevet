/** Minimal localStorage-shaped store: window.localStorage in the app, a fake
 *  in tests. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The desktop bridge's prefs mirror pair, or undefined in a plain browser. */
export interface PrefsMirrorLike {
  prefs?: () => Promise<Record<string, string>>;
  setPref?: (key: string, value: string | null) => Promise<unknown>;
}

/** Copy every mirrored preference into `storage`. */
export function applyMirror(
  entries: Record<string, unknown> | null | undefined,
  storage: Pick<StorageLike, "setItem">,
): void;

/** Fetch the mirror (when there is one) and apply it. */
export function hydratePrefsMirror(
  storage: Pick<StorageLike, "setItem">,
  mirror: PrefsMirrorLike | null | undefined,
): Promise<void>;

/** A `StorageLike` backed by `storage`, mirroring every write through
 *  `mirrorAccessor()` when it returns something. */
export function mirroredStorage(
  storage: StorageLike,
  mirrorAccessor: (() => PrefsMirrorLike | null | undefined) | undefined,
): StorageLike;
