/**
 * Path -> language NAME. Nothing else.
 *
 * This module deliberately imports NOTHING. Not @codemirror/language, not a
 * lang pack, not even a sibling. That is the whole point of it existing as a
 * separate file: `languageForPath` is a pure string function, and a pure string
 * function should be testable by `node --test` on a machine with no DOM, which
 * is what the repository's runner is. The moment this file imports a lang pack
 * it drags in @codemirror/view, which touches `document` while it is being
 * evaluated, and the test would have to stand up a DOM stub to assert that
 * ".py" maps to "python". That trade is absurd, so it is not made.
 *
 * Rejected alternative: keeping the mapping inside index.js and lazy-`import()`
 * ing the lang packs inside the function. It would have worked, but it makes
 * the function async for no benefit, and esbuild would split the bundle at
 * every dynamic import — producing chunk files that hub/public would then have
 * to serve, when the entire reason this build exists is to produce exactly one
 * committed file. So: names here, name -> extension in index.js.
 *
 * The name -> extension table lives in index.js and MUST stay in step with the
 * names returned here. `editor/test/smoke.test.mjs` asserts that every name
 * this file can return appears in that table, so the two cannot silently drift.
 */

/**
 * Extension (no dot, lowercased) -> the language name index.js understands.
 *
 * Extensions NOT listed here return null, and null means "plain text, no
 * highlighting". That is on purpose. Guessing is worse than not guessing: a
 * .conf file rendered as JavaScript is a lie told confidently, and the user has
 * no way to turn it off. Anything unrecognised gets an honest plain buffer.
 */
const BY_EXTENSION = Object.freeze({
  // JavaScript pack. It handles TS and JSX too — @codemirror/lang-javascript
  // exports one `javascript()` with jsx/typescript flags, so all five of these
  // land on the same name and index.js decides the flags from the name alone.
  // We do NOT distinguish them here, because the caller of languageForPath
  // wants a label it can also show in a UI, and "javascript" is that label.
  js: "javascript",
  jsx: "javascript",
  ts: "javascript",
  tsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",

  py: "python",
  json: "json",

  html: "html",
  htm: "html",

  css: "css",
  md: "markdown",
  rs: "rust",
});

/**
 * Maps a file path to a language name, or null when we do not know.
 *
 * Takes a path, not an extension, because that is what the caller has. Accepts
 * both separators: the hub is Linux, the clients include this Windows machine,
 * and a path that arrives as "src\\db.ts" must not be treated as one long
 * extensionless filename.
 *
 * NOT VERIFIED: behaviour against exotic filenames from a real project tree
 * (unicode, trailing dots, files named only ".ts"). The unit test covers the
 * extension list the task named plus the obvious degenerate inputs; it is not
 * a fuzz campaign.
 *
 * @param {string} relPath
 * @returns {string|null}
 */
export function languageForPath(relPath) {
  if (typeof relPath !== "string" || relPath === "") return null;

  // Take the basename first. Without this, a directory called "app.js/" — or
  // more plausibly a path like "src/v1.2/README" — would have its extension
  // read out of the wrong path segment.
  const base = relPath.slice(Math.max(relPath.lastIndexOf("/"), relPath.lastIndexOf("\\")) + 1);

  const dot = base.lastIndexOf(".");

  // dot <= 0 covers both "Makefile" (no dot) and ".gitignore" (leading dot,
  // which is a dotfile's whole name, not an extension). Both are plain text.
  if (dot <= 0) return null;

  const ext = base.slice(dot + 1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(BY_EXTENSION, ext) ? BY_EXTENSION[ext] : null;
}

/**
 * Every language name `languageForPath` can return. Exported so the test can
 * assert index.js's extension table covers all of them — see the drift note at
 * the top of this file.
 */
export const LANGUAGE_NAMES = Object.freeze([...new Set(Object.values(BY_EXTENSION))]);
