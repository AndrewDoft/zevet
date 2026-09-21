/** Inline formatting for what an agent says: **bold** and `code`. Anything
 *  else is literal — a tool line, an error, a path, a stack trace. */

export const INLINE_MD = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;

/**
 * Markdown that says what the agent said.
 *
 * ⚠️ A BARE NUMBER AND A FULL STOP IS A LIST MARKER. Asked "what is 17 times
 * 3?", claude answered exactly `51.` — and every markdown renderer, correctly
 * by the spec, turns a line of `51.` with nothing after it into an EMPTY
 * ordered list starting at 51. Measured in the running app 2026-09-21: the
 * DOM held `<ol start="51"><li></li></ol>` and the answer was invisible.
 * Andrew: "the response looked super weird."
 *
 * So a marker with NOTHING after it gets its stop escaped. A real list item
 * has content after the marker and never matches, which is why this is safe
 * to run over the whole message rather than over a delta: as soon as `51.`
 * becomes `51. something`, it stops matching and the escape is not applied.
 * Run it on the accumulated text, never on the fragment.
 *
 * The same trap exists for `-` and `*`, but a lone dash is not an answer
 * anyone gets; a lone number is.
 */
export function mdSafe(text) {
  if (typeof text !== "string" || !text) return text;
  /* ⚠️ UNESCAPE FIRST, so this is idempotent under streaming. A block that
     arrives as `51.` is escaped; when the rest of the sentence arrives and the
     accumulated text becomes `51. Three times seventeen.` the escape is no
     longer needed, and leaving it there puts a stray backslash in everything
     that reads the raw string — copy, the raw-output panel. Stripping it and
     re-deciding each time keeps the stored text equal to what the agent said
     whenever the trap does not apply. */
  const bare = text.replace(/(\d)\\\.(?=[ \t]|$)/gm, "$1.");
  return bare.replace(/^([ \t]*)(\d{1,9})\.([ \t]*)$/gm, "$1$2\\.$3");
}

export function inlineParts(text) {
  const s = text == null ? "" : String(text);
  const parts = s.split(INLINE_MD);
  const out = [];
  for (const part of parts) {
    if (!part) continue;
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      out.push({ kind: "b", text: part.slice(2, -2) });
    } else if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      out.push({ kind: "code", text: part.slice(1, -1) });
    } else {
      out.push({ kind: "text", text: part });
    }
  }
  return out;
}