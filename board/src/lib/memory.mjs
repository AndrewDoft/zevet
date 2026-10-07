// Pinned memory on the board (D-077). The desktop seals, opens and
// flags (desktop/pinned-memory.js); these are the pure readings of what it sends.

/** Notes that need a person: the code moved or is gone. */
export const needsReview = (notes) => (notes || []).filter((n) => !n.retired && (n.stale === "stale" || n.stale === "missing"));

/** The note's flag in labels-and-values style. */
export function flagText(note) {
  return note.stale === "stale" ? "stale" : note.stale === "missing" ? "file gone" : "";
}

/** Paths carrying at least one note that needs review, for the file tree. */
export function stalePaths(notes) {
  return new Set(needsReview(notes).map((n) => n.path));
}

/** The board-level chip text, or "" when nothing is stale. */
export function staleChipText(notes) {
  const n = needsReview(notes).length;
  return n ? `${n} stale` : "";
}
