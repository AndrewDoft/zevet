/** Minimal localStorage-shaped store: window.localStorage in the app, a fake
 *  in tests. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `StorageLike` plus the standard Web Storage enumeration — real
 *  `window.localStorage` already has both, a fake in tests has to say so. */
export interface EnumerableStorageLike extends StorageLike {
  readonly length: number;
  key(index: number): string | null;
}

/** The desktop bridge's prefs mirror pair, or undefined in a plain browser. */
export interface PrefsMirrorLike {
  prefs?: () => Promise<Record<string, string>>;
  setPref?: (key: string, value: string | null) => Promise<unknown>;
  /** Seed the mirror in one batch — see `hydratePrefsMirror`'s upgrade path. */
  setPrefs?: (entries: Record<string, string>) => Promise<unknown>;
}

/** Copy every mirrored preference into `storage`. */
export function applyMirror(
  entries: Record<string, unknown> | null | undefined,
  storage: Pick<StorageLike, "setItem">,
): void;

/** Every "zevet.*" key already in `storage`, as a flat map. */
export function collectExisting(storage: EnumerableStorageLike): Record<string, string>;

/** Fetch the mirror (when there is one) and apply it; if it comes back empty,
 *  seed it once from whatever "zevet.*" prefs already live in `storage` — an
 *  existing user upgrading from a build without this mirror. */
export function hydratePrefsMirror(
  storage: EnumerableStorageLike,
  mirror: PrefsMirrorLike | null | undefined,
): Promise<void>;

/** A `StorageLike` backed by `storage`, mirroring every write through
 *  `mirrorAccessor()` when it returns something. */
export function mirroredStorage(
  storage: StorageLike,
  mirrorAccessor: (() => PrefsMirrorLike | null | undefined) | undefined,
): StorageLike;
