# Known failures

One entry per failure: the exact signature, the cause, the fix (commit or
"open"), and what zevet shows the user. Terse by design — the contract notes
in `docs/contracts/` carry the detail.

## Rate limits and provider errors were shown as a full sentence naming the
## model, or not classified at all

**Signature.** `"<model> hit its free daily limit."` / `"<model> hit its
usage limit."` (the old copy) shown for a 429; a 404/5xx/timeout shown as the
generic `"The model returned an error."` with no code.

**Cause.** `plainError` (`board/src/lib/transcript.mjs`) formatted a
rate-limit as a full sentence naming the model, which is both un-terse
(CLAUDE.md's UI-copy note) and coupled the model-limit bookkeeping
(`isLimitMessage`) to that exact prose. A provider error that was not a rate
limit had no distinct message at all.

**Fix.** This branch. `board/src/lib/model-limits.mjs`'s `classifyEnding`
is now the one place that reads a raw error string and says
`rate_limited | provider_error | null` (tested against the exact opencode
1.18.31 strings observed this session: `test/model-limits.test.mjs`).
`plainError` uses it to produce `"Rate limited"` (+ `" · resets 14:05"` when
the payload carries `X-RateLimit-Reset`), `"Provider error 404"`, or
`"Timed out"`.

**What zevet shows.** The thread's own error line (assistant-ui's built-in
`MessagePrimitive.Error`, already wired — verified against
`@assistant-ui/core`'s `messageErrorText`, nothing custom needed there) now
reads one of the three lines above instead of a sentence. Only the
rate-limited case grays the model in the picker.

## Opencode's own CLI-level failures (before the JSON stream opens) were
## invisible — not classified, model not grayed

**Signature.** None yet reproduced arriving on stderr from zevet's own
`opencode run --format json` invocation — every real capture this session
(429, a bogus model, a bogus provider) arrived as a `{"type":"error"}` line
on **stdout**, which `fromOpencode` already read. `board.ts`'s new stderr
classifier is defence in depth for a CLI-level crash that never reaches the
JSON stream at all (documented, not observed) — see
`docs/contracts/opencode-hooks.md`.

**Cause.** N/A — not reproduced as a real gap; see above.

**Fix.** `board/src/lib/board.ts`'s `stderr` handler now runs
`classifyEnding` on opencode's stderr too and closes the run + records the
limit if it matches, scoped to `agent === "opencode"` only (codex's stderr is
routine, unrelated noise — see the comment above it in `board.ts`).

**What zevet shows.** Same three lines as above, if this path is ever hit.

## A model past its free daily cap stayed clickable in the picker, only
## grayed by a custom class the library's own disabled styling ignored

**Signature.** A limited model showed at 40% opacity but was still
selectable — clicking it started a run that failed the same way again.

**Cause.** `board/src/components/model-choice.tsx` set `className:
"opacity-40"` instead of the `ModelOption.disabled` field
`ModelSelectorItem` (`assistant-ui/elements/model-selector.tsx`) already
reads and wires into `cmdk`'s own `data-[disabled=true]` styling
(`pointer-events-none`, `opacity-50`).

**Fix.** This branch. `disabled: Boolean(resetAt)` on the option; the reset
time is still the tooltip.

**What zevet shows.** A limited model is grayed and genuinely unselectable,
in both Code and Chat (one shared component).

## A tool opencode auto-rejects in a headless run (`external_directory`
## permission) left no result at all — a silent stop

**Signature.** `{"type":"tool_use","part":{"state":{"status":"error",
"error":"The user rejected permission to use this specific tool call."}}}`
with **no** `state.output` field. MEASURED 2026-09-23: a `write` outside the
repo root in a headless `opencode run`, which auto-rejects because there is
nobody to prompt (stderr also gets one ANSI-coded line: `permission
requested: external_directory (...); auto-rejecting` — not surfaced
anywhere; the tool-call card is the fix, not that line).

**Cause.** `fromOpencode` (`transcript.mjs`) only ever read `state.output`
to decide a tool call had a result. A rejected call has `state.error`
instead, so it was added with no result and no `isError` — not running, not
failed, nothing. The run then exits 0 (opencode itself did not fail), so
`closeTranscript` read it as a clean completion.

**Fix.** This branch. `fromOpencode` now reads `state.error` as the result
when `state.output` is absent, `isError: true`.

**What zevet shows.** The tool-call card shows the rejection reason and is
marked failed (`tools.tsx`'s `failed()` already reads `isError`).

## Raw ANSI escape codes leaked into a Bash tool's own result

**Signature.** A tool-call result containing `\x1b[33m...\x1b[m` and similar
— from `git -c color.ui=always`, `npm`, `eslint --color`, or any command that
forces colour even off a real TTY.

**Cause.** `ToolFallbackResult` (`tool-fallback.aui.tsx`) renders a string
result verbatim in a `<pre>`. Nothing in the live console pipeline stripped
ANSI — only session-**replay** text did (`envelope.mjs`'s `stripAnsi`, for a
terminal session read off disk after the fact).

**Fix.** This branch. `setToolResult` (`transcript.mjs`) now runs
`stripAnsi` (imported from `envelope.mjs`, not duplicated) over a string
result before it reaches the transcript — one choke point, all three agents.

**What zevet shows.** Clean tool output, no escape bytes.

## Opencode was invisible on the board from any repo `zevet install` had not
## been explicitly run in — including every worktree zevet itself launches
## an opencode agent in

**Signature.** An `opencode run` in a fresh git worktree produced no events
on the hub; `.opencode/plugins/` did not exist there.

**Cause.** `install-opencode.mjs` only ever wrote the plugin per-repo
(`<repo>/.opencode/plugins/zevet.js`), and `desktop/agent-console.js` spawns
opencode directly in whatever worktree the board gives it — never the repo
`zevet install` ran in.

**Fix.** This branch (D-013 in DECISIONS.md). `install.mjs` now installs a
**global** copy (`~/.config/opencode/plugins/zevet.js`, opencode's own
documented global plugin directory) instead, gated by a new
`~/.zevet/opencode-repos.json` opt-in list (mirrors Codex's
`codex-repos.json`, D-001) so a global plugin does not report every repo on
the machine. VERIFIED live: a real `opencode run` in a worktree with no
per-repo plugin at all reported correctly once its repo was opted in, and
reported nothing when it was not — see `docs/contracts/opencode-hooks.md` §8.

**Known residual gap — open.** A repo that already carries the OLD per-repo
`.opencode/plugins/zevet.js` from before this change, and that nobody has
re-run `zevet install` in since, is not automatically migrated — it keeps
working on its own (unaffected) until it is, at which point the installer
removes it in favour of the global copy. Not fixed because there is no way
to reach every repo on a machine from an installer that only runs where it is
pointed.
