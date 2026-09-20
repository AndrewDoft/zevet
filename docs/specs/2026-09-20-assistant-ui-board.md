# The board, rebuilt on assistant-ui

Status: approved 2026-09-20. Supersedes the partial wiring done in 0.2.8.

The board has had `@assistant-ui/react` as a dependency since the React rebuild
and has never used it. Four hand-copied `*.aui.tsx` files sit in
`board/src/components` with zero importers, because there is no
`AssistantRuntimeProvider` anywhere in the app and `useAui()` throws without
one. `components.json` has `"registries": {}`, so nothing could ever have been
installed from the registry in the first place — the files were pasted in.

This replaces all of that with the real thing: one runtime, the registry wired
up, and every surface of the board expressed as an assistant-ui element.

---

## 1. What is actually broken today

Each of these was reproduced, not inferred.

**The layout collapses.** `masora.css` makes `body` a grid with
`grid-template-rows: 1fr` and one child. Before the React rebuild that child was
`.shell`. Now it is `#root`, which has no height rule, so `.shell` sizes to its
content: the panes stop partway down the window and the rest is blank paper.
Screenshot taken against a local hub at 1440×900 confirms it.

**Zoom does not exist.** `buildMenu()` in `desktop/main.js` registers
`appMenu`, a custom `zevet` menu, `editMenu` and `windowMenu`. There is no
`viewMenu`, and Electron's zoom accelerators come from that role, so
Ctrl+`=`/`-`/`0` are never bound. Ctrl+wheel is off by default and nothing turns
it on. The `ImageZoom` lightbox in `image.tsx` is never imported.

**Two theme systems.** `masora.css` flips on `:root[data-theme="dark"]`;
`index.css` declares Tailwind's dark variant as `&:is(.dark *)` and defines a
second, unrelated oklch palette. No code ever sets `.dark`, so every shadcn and
assistant-ui component stays in light colours when the board goes dark.

**Structure is thrown away before the UI sees it.** All three agent CLIs emit
JSONL — claude via `--output-format stream-json`, codex via `--json`, opencode
via `--format json`. `agent-console.js` delivers those objects intact as
`{type:"agent", payload}`. Then `classifyAgentPayloadLine` in `lib/fmt.ts`
flattens each one to a `[kind, string]` pair, and `ConsoleEntry.lines` is the
only thing the UI ever renders. Tool calls, tool results, reasoning and
structured errors all become grey text. Nothing downstream can render what has
already been stringified.

**codex emits shapes nothing handles.** `classifyAgentPayloadLine` branches on
claude's `assistant`/`result` and opencode's `text`/`tool_use`/`step_finish`.
codex's own event names are not among them, so a codex turn shows the meta lines
and little else.

---

## 2. Token unification

One palette, one switch.

`masora.css` keeps ownership of the colours. `index.css` stops declaring its own
and instead defines the shadcn contract in terms of masora's tokens:

    --background: var(--paper);
    --foreground: var(--ink);
    --border:     var(--line);
    --card:       var(--raise);
    --popover:    var(--raise);
    --muted:      var(--fill);
    --accent:     var(--cerulean-soft);
    ...

The Tailwind dark variant changes from `&:is(.dark *)` to
`&:where([data-theme="dark"] *)`, so the existing theme toggle — which already
sets `data-theme` on `:root` — drives both systems at once. No `.dark` class is
introduced, and `applyTheme()` is unchanged.

**One collision must be resolved.** masora's `--muted` is a *foreground* grey
(`#5f6274`, used for de-emphasised text); shadcn's `--muted` is a *background*
fill, with `--muted-foreground` as its text colour. Left alone this produces
grey-on-grey. masora's is renamed `--ink-muted` throughout `masora.css` and its
call sites; shadcn's `--muted`/`--muted-foreground` then map to
`--fill`/`--ink-muted`.

Fonts stay: Space Grotesk for UI, IBM Plex Mono for code and paths, both served
locally from `hub/public/fonts`.

Radii and spacing come from masora, not from the registry defaults, so installed
components sit correctly next to the panes that are not being replaced.

---

## 3. The runtime

### 3.1 Transcript assembly

New module `board/src/lib/transcript.mjs`, with `transcript.d.mts` beside it.

`.mjs` + `.d.mts` is the existing convention for board logic that needs test
coverage — `roster.mjs`, `update.mjs`, `prose.mjs` and `connect.mjs` all follow
it — because the gate runs `node --test` directly against the source tree and
cannot import TypeScript.

It exports one pure function:

    assembleTranscript(payloads, { agent, localRoot }) -> ThreadMessageLike[]

and the incremental form the store uses:

    appendPayload(state, payload, { agent, localRoot }) -> state

It normalises the three CLIs' event vocabularies into assistant-ui message
parts:

| Source | Event | Becomes |
|---|---|---|
| claude | `assistant` → content `text` | `{ type: "text" }` |
| claude | `assistant` → content `tool_use` | `{ type: "tool-call" }`, `argsText` from input |
| claude | `user` → content `tool_result` | the matching tool-call's `result` |
| claude | `assistant` → content `thinking` | `{ type: "reasoning" }` |
| claude | `result` | closes the assistant message, sets status |
| codex | `item.started` / `item.completed` | tool-call open / result |
| codex | `agent_message` / `agent_message_delta` | `{ type: "text" }` |
| codex | `reasoning` / `reasoning_delta` | `{ type: "reasoning" }` |
| codex | `turn.completed` / `turn.failed` | closes the message, sets status |
| opencode | `text` | `{ type: "text" }` |
| opencode | `tool_use` with `part.state` | `{ type: "tool-call" }` + result when state completes |
| opencode | `step_finish` | closes the message |
| any | unparsed stdout line | `{ type: "text" }` on a `system` message |
| any | `stderr` | `{ type: "text" }` on a `system` message, marked as error |

codex's exact event names are read off the CLI and pinned by tests rather than
guessed; where the installed codex disagrees with what is written above, the
measurement wins and this table is corrected in place.

Tool-call parts carry `toolCallId`, `toolName`, `args` and — once the result
arrives — `result`, which is what makes `makeAssistantToolUI` and
`elements-tool-call` able to render them properly.

Prompts the user sent become `user` messages; this is already tracked, as the
`you` line kind.

### 3.2 Store and provider

`board/src/lib/runtime.ts` builds an `ExternalStoreAdapter` over the existing
zustand board store. Nothing about the transport changes — consoles are still
started, streamed and stopped through `bridge.local`.

- `messages` — the assembled transcript for the active console.
- `isRunning` — `ConsoleEntry.running`.
- `onNew(message)` — calls the existing `sendPrompt(key, text)`.
- `onCancel()` — calls the existing `closeConsole(key)`.
- `adapters.threadList` — an `ExternalStoreThreadListAdapter` over
  `selectMyConsoles`, so each running console is one thread and the thread list
  *is* the console list. `onSwitchToNewThread` opens the launcher.
- `adapters.attachments` — `CompositeAttachmentAdapter` over the desktop
  bridge's file read, so dragging a file into the composer sends its path.

`AssistantRuntimeProvider` wraps the whole `.shell`, not just the chat column,
because the rail's agent cards and the strip's meters read thread state too.

A console with no structured payloads still renders: the raw terminal view stays
available per thread and is what `elements-terminal-block` shows.

---

## 4. Surface by surface

`components.json` gains the registry so items can actually be installed:

    "registries": {
      "@assistant-ui": "https://r.assistant-ui.com/styles/{style}/{name}.json"
    }

Style stays `base-nova`, which resolves to the Base UI flavour and matches the
`@base-ui/react` dependency already present. All 156 registry items were probed;
every element named below returns 200 under this style.

The four hand-copied `*.aui.tsx` files are **deleted** and replaced by registry
installs.

| Surface | Today | Becomes |
|---|---|---|
| Conversation | `Consoles agentView` rendering `TerminalBlock` | `thread`, `elements-composer`, `elements-message-pair`, `elements-message-actions`, `elements-scroll-anchor`, `elements-empty-state`, `elements-day-separator` |
| Agent output | flat `.cline` divs | `elements-tool-call`, `elements-tool-group`, `elements-tool-timeline`, `elements-reasoning-panel`, `elements-terminal-block`, `elements-todo-list`, `elements-subagent-list`, `elements-stopped-run` |
| People rail | `people.tsx` | `elements-agent-card`, `elements-agent-status`, `elements-connection-state` |
| "You" consoles | `consoles.tsx` list | `thread-list`, `elements-thread-list` |
| Strip | `strip.tsx` sparkline | `elements-activity-graph`, `elements-cost-meter`, `elements-context-breakdown`, `elements-message-timing` |
| Files | `tree.tsx` | `elements-file-tree`, `elements-command-palette` |
| Detail | `detail.tsx`, `file.tsx` | `elements-code-diff`, `elements-reviewable-diff`, `syntax-highlighter` |
| Launch modes | `<select>` + buttons | `elements-approval-card`, `elements-permission-grant`, `elements-reasoning-effort`, `model-selector` |
| Update row | `updaterow.tsx` | `elements-job-progress`, `elements-quota-banner` |
| Settings | `settings.tsx` | `elements-settings-panel` |
| Errors | `.console-err` | `elements-error-state`, `elements-guardrail-notice` |

Each installed element is adapted, not merely dropped in: its props are fed from
the board store, and its Tailwind classes inherit the unified tokens from §2 so
it reads as paper and ink rather than as stock shadcn neutral.

Where an element does not fit zevet's data — the file tree is multiplayer and
carries per-teammate collision marks, which no element models — the element's
markup and styling are kept and its data layer is replaced. The collision marks
stay; they are the product.

---

## 5. Zoom

All four senses of it, as confirmed.

1. **Accelerators.** `viewMenu` role added to `buildMenu()`, giving
   Ctrl+`=`/`-`/`0`, reload and full screen. The existing custom `zevet` menu
   keeps its `reload`/`toggleDevTools` items.
2. **Ctrl+wheel.** `webContents.on("zoom-changed", ...)` in `openBoard()`,
   stepping `zoomLevel` and clamping to the same range as the menu.
3. **Persistence.** The level is written to the existing config file and
   restored on `did-finish-load`, so a window reopens where it was left.
4. **Layout survives it.** `#root { height: 100%; min-height: 0 }` fixes the
   collapse from §1 — that bug is what makes zooming *look* like it breaks the
   layout, because the shell's height was already wrong. In addition,
   `titleBarOverlay` does not scale with `zoomFactor` on Windows, so its height
   is recomputed on each zoom change; without that the window controls and the
   `.pane-title` drag region drift apart.
5. **Image zoom.** `ImageZoom` from `image.tsx` is wired into the image message
   part, so images in a transcript open in the lightbox that was already written.

---

## 6. How this gets verified

Compiling is not evidence. Every stage is looked at.

**Fixture bridge.** `board/src/lib/fixture.ts`, imported only under
`import.meta.env.DEV` and activated by `?dev=1`, installs a fake `bridge.local`
that replays recorded agent payloads for all three CLIs. It is compiled out of
the production bundle — the guard is a build-time constant, so the code is
dropped by dead-code elimination, and a gate test asserts the shipped
`hub/public/board.js` contains none of its symbols.

This is what makes it possible to render every element, in both themes, against
realistic data, without spending agent quota — and it is how each surface is
checked as it lands rather than all at once at the end.

**The gate.** `transcript.mjs` gets `test/transcript.test.mjs`, covering each
row of the table in §3.1 and the malformed-payload cases. The existing 875 tests
stay green; `test/board-bundle.test.mjs` continues to assert the committed
bundle matches the source hash.

**Screenshots.** Each surface is driven in a real browser against the local hub
and looked at in light and dark before moving on.

**Live.** The desktop app is run against the local hub with a real agent for at
least one turn, so the transcript path is exercised end to end rather than only
against fixtures — the Zoom lesson from Metrodora applies here: an integration
is not verified until something talks to the real thing.

---

## 7. Order of work

1. Tokens unified; `#root` fixed. The board should look unchanged apart from
   filling the window.
2. Registry wired; the four orphan `*.aui.tsx` files deleted.
3. `transcript.mjs` + tests, with no UI consuming it yet.
4. Runtime and provider; conversation column rebuilt on `thread`.
5. Rail and strip.
6. Files and detail.
7. Launch controls, update row, settings, error states.
8. Zoom and the menu.
9. Gate green, bundle rebuilt and committed.
10. Release: version bump, tag, CI artifacts, feed, upload.
11. Deploy the hub from the tag; update the landing page container.

Stages 1–8 each end with the board running and looked at. A stage that cannot be
seen working does not count as done.

---

## 8. Known consequences

**The bundle grows.** It is 500 kB today. Installing this much of the registry
will push it well past that, and that has been accepted explicitly. The hub
serves it from a box with no CDN, so the number is recorded at the end and noted
here rather than discovered later.

**`classifyAgentPayloadLine` survives.** It keeps producing the raw terminal
view, which `elements-terminal-block` renders per thread. It is no longer the
only path, but a transcript nobody can read as plain text would be a regression
for debugging an agent that has gone wrong.

**codex's event vocabulary is the least certain part of §3.1.** It is pinned by
tests against recorded output; if the installed codex emits something else, the
table is wrong and gets corrected rather than worked around.

---

## 9. What actually shipped — 0.2.9

Written after the release, against what is live rather than what was planned.

### Converted to registry elements

| Surface | Elements now used |
|---|---|
| Conversation | `thread`, its composer, message actions, scroll anchor, day separator |
| Agent output | tool calls, tool groups, reasoning panel, terminal block, streaming text |
| Rail "You" | thread list behaviour + `agent-status` per row |
| Hub connection | `connection-state` (renders nothing while online) |
| Launcher | `model-picker`, `surfaces` tokens, empty states |
| Update row | `job-progress`, `error-state` |
| Blank and error states | `empty-state`, `error-state` |

### NOT converted, and why

Each of these has a registry element with a similar name. Each was left alone
because the element does not model the data, and swapping it in would have
deleted behaviour that is the product:

- **The file tree.** `elements-file-tree` carries path, name, depth, kind and
  add/delete counts. zevet's rows also carry per-teammate colour marks and the
  collision state — the thing the whole product exists to show.
- **The detail pane.** `elements-code-diff` and `elements-reviewable-diff` are
  read-only diff views. This pane holds the live collaborative editor.
- **The status strip.** `elements-cost-meter` and `elements-context-breakdown`
  are chat-width cards. The strip is a compact mono line in a 258px rail and
  already says the same things in a tenth of the space.
- **The people roster.** `elements-agent-card` is a card per agent. The rail
  rows are per-person, hue-coded and expandable, at rail width.
- **The settings sheet.** `elements-settings-panel` is a small toggle card.
  Settings is accounts, the code index, the hub and the theme.

They all read as one interface regardless, because §2 gave them one palette:
the registry components resolve their colours from masora's tokens.

### Measured

- Gate 943 tests green, from 875. New: `transcript.test.mjs` (31),
  `zoom.test.mjs` (18), `board-bundle.test.mjs` (8), `board-jsx.test.mjs` (1).
- Bundle 1,049,014 bytes, from ~500 kB. Accepted in advance.
- The dev fixture is absent from the shipped bundle, asserted rather than
  assumed.
- Zoom verified against the running app: Ctrl+= took the level 0 → 1.5 in three
  steps, Ctrl+- back to 1.0, Ctrl+0 to 0, each persisted, layout intact at
  1.44x.
- Auto-update verified against production: the app's own `AppUpdater`, told it
  was 0.2.8, downloaded the real 117 MB installer, checksummed it and returned
  ready.

### Found on the way, and fixed

- `components.json` had `"registries": {}`, so nothing could ever have been
  installed from the registry; the four `*.aui.tsx` files were hand-pasted.
- `vite.config.ts` had no `@/*` alias although `tsconfig.json` did, so tsc
  passed and vite could resolve no registry-style import at all.
- shadcn flattens registry files that declare nested paths, and some published
  files disagree with their own manifest. Both are handled by
  `board/scripts/sync-registry.mjs` so a re-install does not undo the fix.
- Seven `\uXXXX` escapes sat in JSX text and rendered literally on screen.
- `board/build.mjs` referenced a `test/board-bundle.test.mjs` that did not
  exist, so the committed bundle the hub serves verbatim was unguarded.
- The 0.2.8 release bumped only `desktop/package.json`, so
  `scripts/release-check.mjs` had been refusing ever since.
- The live landing container predated the 0.2.8 page change: the site offered
  0.2.7 while the feed offered 0.2.8.
- `activeConsole: null` meant both "the newest console" and "show the
  launcher", which made the launcher unreachable once anything was running.

### Still open

`INSUF-005` — codex's `exec --json` vocabulary is written from documentation,
not observation, because codex is not installed on the machine this was built
on. It fails visibly rather than silently.
