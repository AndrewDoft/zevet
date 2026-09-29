/**
 * Moves an open board onto a new hub deploy.
 *
 * The desktop app loads the board from the hub and never navigates again, so
 * without this a window keeps the board.js it opened with until someone quits.
 * The hub stamps its build into the page (<meta name="zevet-build">) and
 * answers GET /version with the current one; when they differ this reloads —
 * but only when that cannot lose work: idle for two minutes (a hidden window
 * is idle), no dialog open, no unsaved editor buffer, and no field, terminal
 * or agent prompt holding typed text.
 *
 * WHY .mjs: the gate runs `node --test` straight against the source tree.
 */
export const CHECK_MS = 60_000;
export const IDLE_MS = 120_000;

/** Inputs that carry a value without a person having typed a prompt into them. */
const NOT_TEXT = ["hidden", "checkbox", "radio", "submit", "button", "reset", "file", "range", "color", "image"];

/** True when a reload would cut something off. `editorDirty`: an unsaved buffer. */
export function holdsWork(doc, editorDirty) {
  if (editorDirty) return true;
  if (doc.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]')) return true;
  for (const el of doc.querySelectorAll("input, textarea")) {
    if (!NOT_TEXT.includes(el.type) && String(el.value).trim() !== "") return true;
  }
  // The file editor is contenteditable too, but its unsaved state is `editorDirty`;
  // counting its text would block every reload while a file is open.
  for (const el of doc.querySelectorAll('[contenteditable=""], [contenteditable="true"]')) {
    if (!(el.classList && el.classList.contains("cm-content")) && String(el.textContent).trim() !== "") return true;
  }
  return false;
}

/**
 * `tick()` is one poll-and-maybe-reload; `touch()` records input. Everything
 * the outside world provides is injected so the rules are testable.
 */
export function createStaleReload({ mine, fetchBuild, doc, now, editorDirty, reload }) {
  let lastInput = now();
  let stale = false;
  return {
    touch() { lastInput = now(); },
    async tick() {
      if (!mine) return;
      if (!stale) {
        const build = await fetchBuild().catch(() => "");
        stale = Boolean(build) && build !== mine;
      }
      const idle = doc.hidden || now() - lastInput >= IDLE_MS;
      if (stale && idle && !holdsWork(doc, editorDirty())) reload();
    },
  };
}
