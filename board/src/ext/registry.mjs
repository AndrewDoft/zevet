// The board extension seam: every `ext/*.tsx` is rendered by App.tsx, so a batch adds UI without editing it.
// An ext file is `export default function Thing() {…}` plus optional `export const slot = "rail" | "overlay"`
// (default "overlay": rendered once at the end of the shell) and `export const order = 0`.
export const SLOTS = ["rail", "overlay"];

/** `modules` is import.meta.glob's `{ path: module }`. Bad ones are dropped, not thrown: the board must still boot. */
export function collectExt(modules) {
  const out = [];
  for (const [id, m] of Object.entries(modules || {})) {
    const slot = (m && m.slot) || "overlay";
    if (!m || typeof m.default !== "function" || !SLOTS.includes(slot)) continue;
    out.push({ id, slot, order: Number(m.order) || 0, Component: m.default });
  }
  return out.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}
