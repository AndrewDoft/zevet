# OpenCode hooks — contract note

**UNVERIFIED 2026-09-19. No live turn has been observed on a hub through this
path.** Everything below is read off opencode's own documentation
(`https://opencode.ai/docs/plugins/`, fetched 2026-09-19) and the behaviour of
`client/opencode-plugin.mjs` against a local hub in `test/opencode.test.mjs`
(which proves the plugin POSTs well-formed events, not that opencode loads or
fires it). Where a thing was not observed, it says so. Promoting
`detect.mjs`'s `"unverified"` to `true` requires §7, not more reading.

---

## 1. There is no shell-hook config to write to

opencode has no equivalent of Claude Code's `.claude/settings.json`
`hooks: { Event: [...] }`. The only hook surface is **plugins**: JS/TS modules
that export plugin functions, auto-loaded from `.opencode/plugins/` (project)
or `~/.config/opencode/plugins/` (global), or named in config `"plugin": [...]`
for npm packages.

The installed copy is `.js`, not `.mjs`, and that is load-bearing rather than
cosmetic: MEASURED 2026-09-19 against opencode 1.18.31, a `.mjs` file in the
project plugin directory is silently never loaded — not evaluated, not called,
no error anywhere — while the identical content as `.js` loads and fires. The
docs say "JavaScript or TypeScript files" and the loader means the extensions
it knows. A marker that appends to a file on load is the five-minute test if
this is ever doubted again.

**Changed 2026-09-23 (D-013): the installed copy is now GLOBAL, not per-repo.**
`client/install-opencode.mjs`'s `installOpencodeGlobal()` writes
`~/.config/opencode/plugins/zevet.js` — VERIFIED against
`opencode.ai/docs/plugins` and against this same machine, which already had
an empty `~/.config/opencode/plugins/` directory opencode itself had created.
`client/install.mjs` calls it instead of (and also removes) the old per-repo
copy. Reason: the per-repo file is never present in a worktree
`desktop/agent-console.js` starts an opencode agent in on zevet's own
behalf — that worktree was never the repo `zevet install` ran in — so
zevet's OWN launched agents were invisible on the board. A global plugin
computes which repo it is watching off the directory it is STARTED in
(`repoInfo` in `opencode-plugin.mjs`), not off where the plugin file lives, so
one global copy covers every repo and worktree.

A global surface reports every repo on the machine unless something tells it
not to — the exact problem D-001 solved for Codex's global hooks. So this
carries the same fix: `~/.zevet/opencode-repos.json`, written by
`install.mjs` (`addOpencodeRepo`/`removeOpencodeRepo`), read inline by the
plugin itself (`repoIsOptedIn`, a copy of hook.mjs's Codex check — the plugin
is self-contained, see §4, so it cannot import the checkout's copy). A repo
not on the list is silent, same failure direction as Codex: a missing or
corrupt list means nothing reports, never everything.

## 2. Events used, and what they become

| opencode | zevet kind | notes |
|---|---|---|
| `tool.execute.before(input, output)` | `tool` | `input.tool` is the name, `output.args` the arguments — the `PreToolUse` equivalent |
| `tool.execute.after` | — | deliberately ignored: same call `before` already announced; sending both draws every tool twice (hook.mjs ignores `PostToolUse` for the same reason) |
| `event: session.idle` | `turn_end` | the turn went quiet — the `Stop` equivalent |
| `event: session.created` | `prompt` | a marker, not a quote: unlike `UserPromptSubmit`, opencode does not hand the plugin the prompt text here |

`session.created/updated/status/diff/compacted/error`, `message.*`,
`file.edited`, `permission.*` and the rest of the documented surface are
ignored. Three kinds is what the hub's `/ingest` understands (`prompt`,
`tool`, `turn_end` — anything else is normalised to `tool`), so subscribing to
more would be scope without a reader.

## 3. What the plugin refuses to do

Same two rules as `hook.mjs`, adapted to the host: every handler catches its
own errors and never throws into opencode (a throw in `tool.execute.before`
would BLOCK the tool — the one failure a watcher must be structurally unable
to cause), and diagnostics go nowhere unless `ZEVET_DEBUG` is set (a plugin's
console is opencode's log surface, so even stderr is silent by default).

The secret scrubber is the same net as `hook.mjs`, plus an `sk-or-` pattern
for OpenRouter keys. It is a net, not a guarantee — see hook.mjs §"Never put
a credential on the wire".

## 4. Self-containment is load-bearing

The installed copy runs inside opencode with no access to the zevet checkout,
so the template imports node builtins only. The credential derivation
(SHA-256(`"zevet-auth\0"` || secret), legacy raw-token fallback, session
precedence) is a copy of `client/secret.mjs`; `test/opencode.test.mjs`
cannot assert byte-equality with a module it cannot import from the repo copy,
so the backstop is the live-ingest test (a derived/legacy credential that
stops agreeing with the hub fails loudly there first). If `secret.mjs`
changes, this file changes with it — there is no import that could do it
automatically, and that is stated here so the next edit does not assume one.

## 5. OpenRouter is a provider, not an agent

There is no OpenRouter binary to detect. `openrouter/...` models run inside
opencode sessions, so watching opencode covers every OpenRouter model with no
provider-specific code — the board shows `agent: opencode` whatever the model.
`openrouterReady()` (in `install-opencode.mjs`) reports key presence only,
from `OPENROUTER_API_KEY` or opencode's `auth.json`
(`{ "openrouter": { "type": "api", ... } }`, written by `/connect`).

Free-tier mechanics, measured 2026-09-19 against the live API, not remembered:

- model IDs ending `:free` cost $0 per token; anything without the suffix bills.
- ~50 free-model requests/day with no credits; ~1,000/day after a one-time
  $10 credit purchase (inference itself stays $0). 20 req/min either way.
- the free list churns weekly (`qwen3-coder:free`, `deepseek-r1:free` and the
  free Llama tier all disappeared mid-2026). Never hard-wire one `:free` ID
  into anything that matters; `openrouter/free` auto-routes over the pool.

## 6. Desktop driving — MEASURED 2026-09-19, implemented in agent-console.js

Both questions from the deferral now have measured answers (opencode 1.18.31,
free model `openrouter/cohere/north-mini-code:free`):

1. **stdin:** with no message argument, `opencode run` reads stdin to EOF as
   the prompt. Prompts stay off argv — the security posture holds.
2. **One-shot:** with stdin held open the process prints nothing; ending stdin
   submits the turn and the process exits 0. Same shape as codex fact (4): one
   prompt per process, follow-ups refused with "start a new console".
3. **Streaming:** `--format json` emits one object per line —
   `step_start`, `text` (`part.text`), `tool_use`
   (`part.tool` + `part.state.{title,input}`), `step_finish`
   (`part.{reason,tokens,cost}`), `error`. The board renders these; usage and
   per-step cost fold into the same spend figures as the other agents, with
   step costs summed per console (running-total semantics would keep only the
   last step — see status-sources.js).
4. **Posture:** `run` offers only `--auto` (`plan`/`ask` are default behaviour,
   `dangerous` is `--auto` with a note that explicit denies still hold).

Invocation: `opencode run --format json [-m <model>] [--auto]`, prompt on
stdin, `%APPDATA%\npm` + `~/.opencode/bin` in the search path. Board model
shortcuts are today's `:free` slugs; the free list churns, free text wins.

## 7. Promotion to `hooks: true` — OBSERVED 2026-09-19

A real turn, on a real hub, from an opencode 1.18.31 session in a wired repo
(free model `openrouter/cohere/north-mini-code:free`, hub on localhost): one
`prompt`, one `tool` (`bash`), one `turn_end`, all `agent: opencode`, visible
in `/api/state`. `detect.mjs` reports `hooks: true` on that basis.

Two things the observation taught, the first now in the code:

1. The installed copy must be `.js` — see §1. The first version shipped
   `.mjs` and watched nothing, silently.
2. NOT YET OBSERVED: whether a turn run from another directory with `--dir`
   loads the target repo's plugin directory. The one `--dir` attempt predated
   the `.js` fix, so it proved nothing either way. Until someone watches it,
   run wired turns with the repo as the working directory.

## 8. The global plugin, OBSERVED 2026-09-23 (D-013)

`installOpencodeGlobal({})` (default `home`, the real machine) really does
write `C:\Users\<user>\.config\opencode\plugins\zevet.js`. Then, with that
repo added to a throwaway `~/.zevet/opencode-repos.json` pointed at a local
disposable hub (never the production one), a real `opencode run -m
opencode/mimo-v2.6-flash-free "..."` in a git worktree that had **no**
`.opencode/plugins/` directory of its own — the exact "fresh worktree" case
this change exists for — produced `prompt` and `turn_end` on `/api/state`,
`agent: opencode`, `repo` correctly read as that worktree's own folder name.

The negative case (repo NOT on the opt-in list stays silent) is verified
against the real, unmodified plugin module loaded from its real installed
path (`test/opencode.test.mjs`'s "a repo not opted in stays silent" and the
two empty/corrupt-list tests), not against a second live `opencode run` —
two attempts at that hung indefinitely for reasons that had nothing to do
with the gate (no output on stdout or stderr, opencode.exe still resident
minutes later; killed both times). Given the gate is one `if` at the top of
each hook and the positive case is proven against the real binary, the risk
this leaves unverified is narrow, but it is not zero — flagged here rather
than claimed.
