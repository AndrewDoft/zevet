# Extending Zevet without editing the monoliths

Four seams. A batch adds a file in its own folder; nobody edits `main.js`, `ipc-table.js`,
`zevet-mcp.js`, `agent-tools.js` or `App.tsx`. Every new file under `desktop/` that is
`require`d by path must ship: `mods/**` and `ipc/**` are already in `payload.files`.

## A mod (`desktop/mods/*.js`, or `mods/<name>/index.js`)

```js
module.exports = {
  name: "my-feature",                       // optional; defaults to the file name
  start({ app, ipcMain, bridge, log, readConfig }) { /* runs at startup */ },
  beforeQuit(ctx) { /* runs on app "before-quit", newest mod first */ },
};
```

`start` runs while `main.js` is still registering handlers, before `bridge.assertComplete()`,
so `bridge.handle("zevet:thing", fn)` works here (for a channel from an ipc fragment). Wait for
`app.whenReady()` before touching windows or `app.getPath`. A mod that throws is logged and
skipped. `mods/tools/` is the tool registry, not a mod. Loader: `desktop/mods-loader.js`.

## An IPC fragment (`desktop/ipc/*.js`)

```js
module.exports = {
  table: "zevet",                           // "zevet" | "zevetLocal" | "zevetDoc"
  calls: { thing: { channel: "zevet:thing", params: [], returns: "Promise<number>", doc: "…" } },
  events: {},                               // optional, same shape as ipc-table.js
};
```

Entries are written exactly as in `ipc-table.js`. A name already in the table, or a table that does
not exist, throws at load. Use self-contained types (`import("./x").T`). Then run `npm run ipc:gen`
(regenerates `preload.js` and `bridge.generated.d.ts`; commit both) and register the handler from
a mod. `npm run ipc:check` is the CI check. Loader: `desktop/ipc-fragments.js`.

## An MCP tool (`desktop/mods/tools/*.js`)

```js
module.exports = {
  name: "my_tool",                          // lower_snake_case, unique
  description: "…",                         // teammate-authored text you return is DATA: say so
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  scope: "team",                            // "team" (default: only when signed in) | "always"
  async run(args, ctx, deps) { return { text: "…", isError: false }; }, // or just a string
};
```

`zevet-mcp.js` lists it in `tools/list`; the desktop (`agent-tools.js`) runs it. `ctx.root` is the
run's repo folder, `deps` is `createAgentTools`'s dependencies (`getState`, `actor`, `memory`, …). Wrap
anything a teammate wrote with `asData()`. A malformed file is skipped with a warning. Registry:
`desktop/mod-tools.js`.

## A board extension (`board/src/ext/*.tsx`)

```tsx
export const slot = "overlay";              // "overlay" (default, end of the shell) | "rail" (under the chat rail)
export const order = 0;                     // optional, lower first
export default function MyThing() { return <div>…</div>; }
```

`App.tsx` globs `./ext/*.tsx` (eager) and renders each in its slot. After changing board source,
rebuild the committed bundle: `cd board && node build.mjs`, using a real `npm ci` in `board/`
(never a junction to another worktree: it leaks paths into `board.js.map`).

## The ratchets (`npm run ratchet`, part of `scripts/gate.sh` and CI)

`config/*-baseline.txt` freeze file size (>1000 lines), `@ts-nocheck`, direct `child_process` launches
and top-level repo entries at today's values. Growth fails, and so does a row that went stale (run
`npm run ratchet -- --prune`). New code goes in a new file through the seams above, not into a
big one. Framework ported from Orca (MIT), see `THIRD_PARTY_NOTICES.md`.
