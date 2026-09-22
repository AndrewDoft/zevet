/**
 * Every "zevet.*" localStorage key is a preference someone set — view, theme,
 * launch model, permission mode, seen runs, model limits, and the rest. But
 * localStorage is scoped to the hub's ORIGIN: switch hubs, or have the hub's
 * URL change, and every one of them silently resets. This mirrors reads and
 * writes into the desktop app's own storage (a flat JSON file beside
 * config.json — see main.js's PREFS), which is keyed to the machine rather
 * than the origin, so a preference follows the person instead.
 *
 * `storage` is whatever implements getItem/setItem/removeItem (window.
 * localStorage in the app, a fake in tests). `mirror` is the desktop bridge's
 * prefs()/setPref() pair, or undefined in a plain browser — where every
 * function here is a no-op wrapper and behaviour is exactly today's
 * localStorage-only one.
 */

/** Copy every mirrored preference into `storage`. Called once, before
 *  anything reads its initial state out of localStorage (see main.tsx), so a
 *  value set under a different hub — or before an app update — is already
 *  there by the time the board's store is created. */
export function applyMirror(entries, storage) {
  if (!entries || typeof entries !== "object") return;
  for (const key of Object.keys(entries)) {
    const value = entries[key];
    if (typeof value !== "string") continue;
    try {
      storage.setItem(key, value);
    } catch {
      // private mode, quota, etc — localStorage stands on its own
    }
  }
}

/** Fetch the mirror and apply it. Split from `applyMirror` only so the fetch
 *  failure (no desktop bridge, or a main process that errored) is swallowed
 *  in one place rather than at every call site. */
export async function hydratePrefsMirror(storage, mirror) {
  if (!mirror || typeof mirror.prefs !== "function") return;
  let entries;
  try {
    entries = await mirror.prefs();
  } catch {
    return;
  }
  applyMirror(entries, storage);
}

/** A localStorage-shaped store, backed by `storage`, that also mirrors every
 *  write through `mirrorAccessor()` when it returns something. Reads never
 *  touch the mirror — by the time anything reads, `hydratePrefsMirror` has
 *  already copied it into `storage`. `mirrorAccessor` is called fresh on
 *  every write rather than captured once, so it sees the bridge coming up
 *  after this is constructed. */
export function mirroredStorage(storage, mirrorAccessor) {
  function mirror() {
    const m = mirrorAccessor && mirrorAccessor();
    return m && typeof m.setPref === "function" ? m : null;
  }
  return {
    getItem(key) {
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        storage.setItem(key, value);
      } catch {
        // preference applies for this session only
      }
      const m = mirror();
      if (m) void m.setPref(key, value);
    },
    removeItem(key) {
      try {
        storage.removeItem(key);
      } catch {
        // preference applies for this session only
      }
      const m = mirror();
      if (m) void m.setPref(key, null);
    },
  };
}
