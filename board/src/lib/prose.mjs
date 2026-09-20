/** Inline formatting for what an agent says: **bold** and `code`. Anything
 *  else is literal — a tool line, an error, a path, a stack trace. */

export const INLINE_MD = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;

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