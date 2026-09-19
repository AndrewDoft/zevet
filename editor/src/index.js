/**
 * The `zevetEditor` global: CodeMirror 6 + Yjs, bundled to one file.
 *
 * This is a SURFACE, not an application. It mounts an editor and hands back a
 * handle. It does not know what a file is, does not fetch anything, does not
 * open a socket, and does not draw a tab bar. All of that belongs to the board
 * UI in hub/public/index.html, which is owned by a different task and is not
 * touched from here.
 *
 * Why an IIFE global rather than an ES module: hub/public/index.html is a plain
 * script-tag page served as static files by a hub with no build step. Making it
 * `<script type="module">` would change how every existing inline script in
 * that page is scoped and when it runs — a large, invisible change to a file
 * this task is forbidden to touch. `window.zevetEditor.*` costs nothing and
 * changes nothing.
 */
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { lintKeymap } from "@codemirror/lint";

import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";

import * as Y from "yjs";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

import { languageForPath, LANGUAGE_NAMES } from "./language.js";

/**
 * name -> a thunk returning the CodeMirror extension.
 *
 * Thunks, not pre-built extensions, because `javascript({ jsx: true })` and
 * friends build parser state eagerly and there is no reason to build seven
 * parsers to use one. Keys MUST cover every name language.js can return; the
 * smoke test asserts that.
 *
 * All five JS-family extensions collapse onto "javascript" in language.js, so
 * we cannot tell .tsx from .js by the time we get here. jsx and typescript are
 * therefore both ON: the TS/JSX grammar is a superset that parses plain JS
 * correctly, whereas plain-JS mode chokes on a type annotation. Over-permissive
 * is the right failure direction for a highlighter.
 */
const LANGUAGE_EXTENSIONS = Object.freeze({
  javascript: () => javascript({ jsx: true, typescript: true }),
  python: () => python(),
  json: () => json(),
  html: () => html(),
  css: () => css(),
  markdown: () => markdown(),
  rust: () => rust(),
});

/**
 * Theme: as close to nothing as CodeMirror allows.
 *
 * CodeMirror ships a base theme that hardcodes `font-family: monospace` on the
 * scroller and a white background on the editor. Both would fight the board's
 * stylesheet, which self-hosts its fonts and has its own light/dark handling.
 * So every one of those is pushed back to `inherit`/`transparent` and the
 * board's CSS wins by default. This is NOT a theme — picking colours is another
 * task's job. It is the removal of the theme CodeMirror imposes.
 *
 * `!important` is used on the scroller font because CodeMirror's base theme is
 * injected into the document at a specificity that otherwise beats us for
 * `.cm-scroller`. That was found by reading @codemirror/view's baseTheme, not
 * by experiment — NOT VERIFIED in a browser by this task.
 */
const transparentTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: "inherit",
  },
  ".cm-scroller": {
    fontFamily: "inherit !important",
    lineHeight: "inherit",
  },
  ".cm-content": { fontFamily: "inherit" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "inherit",
    border: "none",
    opacity: "0.55",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
});

/**
 * The extensions every editor gets, collaborative or not.
 *
 * `syntaxHighlighting(defaultHighlightStyle)` is included on purpose and is the
 * one place this file does pick colours. Without it the lang packs parse the
 * document and then render it in a single flat colour, which makes shipping
 * seven language packs pointless. defaultHighlightStyle is tuned for a light
 * background; if the board is dark, the styling task should pass its own
 * HighlightStyle instead — this line is the thing to replace, and it is here
 * rather than buried so it can be found.
 *
 * `drawSelection` is not decoration: y-codemirror.next renders remote cursors
 * as layer widgets alongside the local selection layer, and without
 * drawSelection the local selection is a native one that sits in a different
 * paint order. Removing it makes collaborative selections look wrong.
 */
function baseExtensions() {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    search({ top: true }),
    highlightSelectionMatches(),
    transparentTheme,
  ];
}

/**
 * Mounts an editor.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.parent        where to mount
 * @param {Y.Doc} [opts.doc]               if present, the buffer IS doc.getText("content")
 * @param {string} [opts.text]             initial text — used ONLY when `doc` is absent
 * @param {Object} [opts.awareness]        a y-protocols Awareness, for remote cursors
 * @param {string|null} [opts.language]    "javascript" | "python" | ... | null
 * @param {boolean} [opts.readOnly]
 * @param {(text: string) => void} [opts.onChange]
 * @returns {{ view: EditorView, destroy: () => void, getText: () => string, setText: (t: string) => void }}
 */
export function createEditor({
  parent,
  doc = null,
  text = "",
  awareness = null,
  language = null,
  readOnly = false,
  onChange = null,
} = {}) {
  if (!parent) throw new Error("createEditor: `parent` is required");

  const extensions = baseExtensions();

  // Language. A Compartment is used even though nothing here reconfigures it,
  // so that the board CAN later swap the language on an open buffer (switching
  // files into one reused view) without rebuilding state — which, with a Yjs
  // binding attached, would mean tearing down and re-syncing the document.
  const languageCompartment = new Compartment();
  const build = language ? LANGUAGE_EXTENSIONS[language] : null;
  extensions.push(languageCompartment.of(build ? build() : []));

  // An unknown language name is a caller bug, but it is not worth throwing over
  // — a plain buffer is a fine outcome and a thrown error loses the user's
  // file. It is logged so the bug is still findable.
  if (language && !build) {
    console.warn(`zevetEditor: unknown language ${JSON.stringify(language)}; rendering as plain text`);
  }

  /**
   * Collaborative vs solo.
   *
   * These two branches are NOT symmetric and the asymmetry matters:
   *
   * - With a Y.Doc, undo/redo must go through Yjs's UndoManager (which yCollab
   *   installs) and not CodeMirror's `history()`. Running both means ctrl-Z
   *   rewinds the local view without telling the peers, and the two documents
   *   diverge. So `history()` is added ONLY in the solo branch, and
   *   yUndoManagerKeymap is added ONLY in the collaborative one.
   *
   * - The initial text is ignored when a doc is given. The Y.Doc is the source
   *   of truth; seeding the view from `text` as well would append the file to
   *   itself the moment the doc syncs. `text` is strictly the offline path.
   */
  const ytext = doc ? doc.getText("content") : null;
  if (ytext) {
    // `awareness` is passed straight through. yCollab only installs the remote
    // selection plugin and its theme when awareness is truthy, so passing null
    // here silently disables remote cursors — which is why the board must pass
    // one, and why this is a parameter rather than something invented here.
    extensions.push(keymap.of(yUndoManagerKeymap), yCollab(ytext, awareness));
  } else {
    extensions.push(history(), keymap.of(historyKeymap));
  }

  // Keymap order is precedence order: closeBrackets and search must see a key
  // before defaultKeymap does, or Backspace-inside-brackets and Ctrl-F both
  // lose to the generic binding. defaultKeymap goes last.
  extensions.push(
    keymap.of([...closeBracketsKeymap, ...searchKeymap, ...completionKeymap, ...lintKeymap, ...defaultKeymap]),
  );

  // readOnly, not editable:false. `editable` removes the contentEditable and
  // with it the caret, so the user cannot select text to copy or use the search
  // panel's cursor. `readOnly` keeps a live, navigable, selectable buffer that
  // simply refuses changes — which is what "read only" means to a person
  // looking at a teammate's file.
  if (readOnly) extensions.push(EditorState.readOnly.of(true));

  if (typeof onChange === "function") {
    extensions.push(
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        // Fired raw, every change, including remote ones arriving over Yjs.
        // Debouncing is the CALLER's job by contract: only the board knows
        // whether this feeds an autosave (debounce hard) or a dirty marker
        // (do not debounce at all).
        onChange(update.state.doc.toString());
      }),
    );
  }

  const view = new EditorView({
    // With a Y.Doc the binding sets the initial content itself, so we must pass
    // an empty doc here; passing ytext.toString() would duplicate it.
    state: EditorState.create({ doc: ytext ? "" : String(text ?? ""), extensions }),
    parent,
  });

  return {
    view,

    /**
     * Tears down the VIEW only.
     *
     * The Y.Doc, the Awareness and the network provider are the caller's — they
     * outlive any one view (that is the point of them) and destroying them here
     * would kill a session because a tab was closed. The caller destroys them.
     */
    destroy() {
      view.destroy();
    },

    getText() {
      return view.state.doc.toString();
    },

    /**
     * Replaces the entire document in ONE transaction.
     *
     * One transaction is not tidiness: with a Yjs binding attached, each
     * transaction becomes a Yjs update broadcast to every peer. A delete
     * followed by an insert is two updates, and a peer that sees only the first
     * renders an empty file — briefly, but visibly, and worse if the second is
     * lost. One transaction is one atomic remote edit.
     */
    setText(next) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: String(next ?? "") },
      });
    },
  };
}

export { languageForPath, LANGUAGE_NAMES };

/**
 * The names this bundle understands, for a language picker in the board UI.
 * Derived from the extension table so it cannot drift from what actually works.
 */
export const languages = Object.freeze(Object.keys(LANGUAGE_EXTENSIONS));

/**
 * Re-exports for the task that owns the networking.
 *
 * yjs, y-protocols and lib0 are already inside this bundle. If the board also
 * loaded them from a CDN it would run TWO copies of Yjs, and Yjs identity
 * checks (`instanceof Y.Item`, the shared type registry) fail across copies in
 * ways that look like corruption rather than like a duplicate import. So the
 * bundle exposes its own copies and the board must use these and only these.
 *
 * Whole namespaces, not cherry-picked helpers, because the message framing the
 * other task has to write (writeSyncStep1 / readSyncMessage, encodeAwarenessUpdate,
 * encoding.createEncoder / decoding.createDecoder) is a moving target and this
 * file should not need editing every time it needs one more function.
 */
export { Y, syncProtocol, awarenessProtocol, encoding, decoding };
export const Awareness = awarenessProtocol.Awareness;
