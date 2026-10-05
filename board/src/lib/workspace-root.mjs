// What desktop/main.js answers when a root is not a folder the user opened
// (desktop/workspace-root.js NOT_OPEN). A person never needs to read it.
export const NOT_OPEN = "not an opened workspace";

/** True for a bridge reply that is only "this root is not an opened workspace". */
export function isNotOpen(r) {
  return Boolean(r) && r.ok === false && r.error === NOT_OPEN;
}

/** The text for a bridge error that is going on screen. A refused folder gets
 *  an instruction rather than the main process's internal wording. */
export function shownError(err, fallback) {
  if (err === NOT_OPEN) return "that folder is not open in Zevet. Open it first.";
  return err || fallback;
}
