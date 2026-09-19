# editor/ — the one bundled thing in zevet

This directory builds **`hub/public/editor.js`**: CodeMirror 6 and Yjs, bundled
by esbuild into a single IIFE that defines `window.zevetEditor`.

It is the first bundler in a repository that is otherwise, deliberately,
dependency-free. That is worth saying out loud rather than discovering in a
diff.

## Rebuilding

```sh
cd editor
npm install          # build-time only; nothing here ships
npm run build        # writes ../hub/public/editor.js and .js.map
```

The build prints the output byte size. As of the first build that is
**834,040 bytes (814.5 KiB) minified**, plus a 3.2 MB source map.

Then **commit the output.** A rebuilt-but-uncommitted bundle is a bundle that
does not exist in production — see below.

## Why the bundle is committed

The hub has no build step. It deploys by `git pull && docker restart`, and
`hub/server.mjs` serves `hub/public` as plain static files. There is no CI that
produces artefacts for it, no `npm install` on the server, no post-checkout
hook. Whatever is in `hub/public` in git is exactly what teammates load.

So the choices were:

1. **Commit the bundle.** 814 KiB of generated code in git history, regrettable
   but honest, and the deploy story does not change at all.
2. **Add a build step to the deploy.** Node and an `npm ci` on the hub box,
   a build that can fail *during* a deploy, and a hub that can no longer be
   restored by `git pull`. That is a materially worse operational story for one
   feature.
3. **Load CodeMirror from a CDN.** Rejected for two reasons: the hub is used to
   watch private work and should not phone a third party on every page load;
   and Yjs breaks badly if two copies are loaded (identity checks against the
   shared type registry fail across copies, and it presents as corruption, not
   as a duplicate import).

(1) won. The `.map` is committed alongside it for the same reason: the hub
serves `hub/public` verbatim, so a source map that is not in git does not exist,
and without it a minified stack trace from a teammate's console is unreadable.

`editor/node_modules/` is git-ignored. Nothing in it is served.

## What the module exposes

The board UI (`hub/public/index.html`, owned by another task) is a plain
script-tag page, not a module page. Hence the IIFE and the `zevetEditor` global.

```js
const ed = zevetEditor.createEditor({
  parent,                 // DOM element to mount into
  doc,                    // a Y.Doc — binds to doc.getText("content")
  text,                   // initial text; used ONLY when no doc is given
  awareness,              // y-protocols Awareness, for remote cursors
  language,               // "javascript" | "python" | ... | null
  readOnly,               // boolean
  onChange,               // (text) => void, fired on every change, NOT debounced
});
// -> { view, destroy(), getText(), setText(text) }
```

Also on the global:

- `languageForPath(relPath)` — `"src/db.ts"` → `"javascript"`, unknown → `null`
- `languages` — the language names this bundle actually supports
- `Y`, `Awareness`, `syncProtocol`, `awarenessProtocol`, `encoding`, `decoding`
  — the bundle's own copies of yjs / y-protocols / lib0. **Use these**, not a
  second copy from anywhere else; see the CDN note above.

Two contracts that are easy to get wrong:

- **`onChange` is not debounced here.** Only the caller knows whether it feeds
  an autosave or a dirty marker. Debounce on your side.
- **`destroy()` tears down the view only.** The `Y.Doc`, the `Awareness` and any
  network provider are yours; they outlive a view by design, and destroying them
  because a tab closed would end the session.

## Tests

`editor/test/smoke.test.mjs`, run by `node --test`. It is included in the gate:
`npm test` and `scripts/gate.sh` both pass `editor/test/**/*.test.mjs` as a
second glob, because `test/**` does not reach this directory.

The editor tests need **no `npm install`** — they read the committed bundle and
import `editor/src/language.js`, which imports nothing. A fresh clone runs them.

What they prove: the bundle exists, fully **evaluates** (in a `node:vm` context
with a stub DOM — not merely parses), defines `zevetEditor`, exposes the agreed
surface, and its bundled Yjs and sync protocol actually round-trip.

What they do **not** prove, stated plainly: `createEditor` is never called,
because an `EditorView` needs a real layout engine. Nothing here has rendered a
pixel, shown a remote cursor, inherited a font from the board's stylesheet, or
synced two peers. That needs a browser and has not been done.
