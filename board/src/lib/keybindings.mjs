/**
 * The app's keyboard shortcuts, in one table. Every handler asks `matches()`
 * rather than comparing `event.key` itself, so a rebind reaches all of them.
 *
 * Accelerators use Electron's spelling ("CommandOrControl+Shift+K") so one
 * string means the same on Windows and macOS. CommandOrControl matches Ctrl or
 * Cmd, as the handlers it replaces already did. Overrides live in
 * zevet.keys.v1 as { id: accelerator }; a default is never written there.
 */

export const KEYS_KEY = "zevet.keys.v1";

export const BINDINGS = [
  { id: "palette", label: "Palette", def: "CommandOrControl+K" },
  { id: "tree", label: "File tree", def: "CommandOrControl+B" },
];

/** Taken by the app menu (desktop/main.js buildMenu) or the OS; not rebindable to these. */
export const RESERVED = ["CommandOrControl+=", "CommandOrControl+-", "CommandOrControl+0", "CommandOrControl+C", "CommandOrControl+V", "CommandOrControl+X", "CommandOrControl+Z", "CommandOrControl+A"];

const MODS = ["CommandOrControl", "Alt", "Shift"];

function norm(accel) {
  const parts = String(accel || "").split("+").filter(Boolean);
  const key = parts.pop() || "";
  const mods = MODS.filter((m) => parts.includes(m));
  return [...mods, key.length === 1 ? key.toUpperCase() : key].join("+");
}

/** A keydown as an accelerator, or null for a bare modifier press. */
export function eventToAccel(ev) {
  const k = ev.key;
  if (!k || ["Control", "Meta", "Shift", "Alt", "AltGraph"].includes(k)) return null;
  const mods = [];
  if (ev.ctrlKey || ev.metaKey) mods.push("CommandOrControl");
  if (ev.altKey) mods.push("Alt");
  if (ev.shiftKey) mods.push("Shift");
  return norm([...mods, k === " " ? "Space" : k].join("+"));
}

export function readOverrides(storage) {
  try {
    const o = JSON.parse(storage.getItem(KEYS_KEY) || "null");
    if (!o || typeof o !== "object") return {};
    const out = {};
    for (const b of BINDINGS) if (typeof o[b.id] === "string" && o[b.id]) out[b.id] = norm(o[b.id]);
    return out;
  } catch {
    return {};
  }
}

/** id -> accelerator, defaults filled in. */
export function resolveBindings(storage) {
  const o = readOverrides(storage);
  const out = {};
  for (const b of BINDINGS) out[b.id] = o[b.id] || norm(b.def);
  return out;
}

/** Does this keydown trigger binding `id`? */
export function matches(ev, id, storage) {
  const want = resolveBindings(storage)[id];
  return !!want && eventToAccel(ev) === want;
}

/** The label of the binding or reserved key that already owns `accel`, else null. */
export function findConflict(bindings, id, accel) {
  const a = norm(accel);
  for (const b of BINDINGS) if (b.id !== id && bindings[b.id] === a) return b.label;
  if (RESERVED.map(norm).includes(a)) return "App menu";
  return null;
}

/** Rebind. A binding needs CommandOrControl or Alt, so typing in a field is not hijacked. */
export function setBinding(storage, id, accel) {
  if (!BINDINGS.some((b) => b.id === id)) return { ok: false, error: "Unknown" };
  const a = norm(accel);
  if (!/^(CommandOrControl|Alt)/.test(a) || !a.includes("+")) return { ok: false, error: "Needs Ctrl or Alt" };
  const conflict = findConflict(resolveBindings(storage), id, a);
  if (conflict) return { ok: false, error: "In use: " + conflict, conflict };
  const o = readOverrides(storage);
  if (a === norm(BINDINGS.find((b) => b.id === id).def)) delete o[id];
  else o[id] = a;
  storage.setItem(KEYS_KEY, JSON.stringify(o));
  return { ok: true };
}

export function resetBinding(storage, id) {
  const o = readOverrides(storage);
  delete o[id];
  storage.setItem(KEYS_KEY, JSON.stringify(o));
}

export function resetAll(storage) {
  storage.setItem(KEYS_KEY, "{}");
}

/** For display: "CommandOrControl+K" -> "Ctrl+K" (Windows) or "Cmd+K" (macOS). */
export function showAccel(accel, mac) {
  return accel.replace("CommandOrControl", mac ? "Cmd" : "Ctrl");
}
