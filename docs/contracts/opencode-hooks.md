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
for npm packages. So zevet's coverage is a plugin file, not a command string —
`client/opencode-plugin.mjs`, copied per repo to
`<repo>/.opencode/plugins/zevet.mjs` by `client/install-opencode.mjs`.

The per-repo file IS the opt-in, the way Claude Code's per-repo settings entry
is. A global plugin would report every project on the machine, which is the
Codex failure D-001 exists to prevent — except here the scoped option is the
default, so it is simply used.

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

## 6. Desktop driving is deferred, on purpose

`desktop/agent-console.js` drives `claude` and `codex` only, and opencode is
not added there in this change. Two reasons, both structural:

1. `opencode run [message..]` takes the prompt as argv. zevet's security
   posture (agent-console.js header) is that a user-typed prompt NEVER becomes
   an argv element — on the `.cmd` fallback path argv is re-parsed by cmd.exe,
   where `&` starts a new command. Whether `opencode run` reads stdin with no
   message argument is UNVERIFIED, and the project bans inventing the third
   entry from memory (agent-console.js:41-45).
2. Driving is separable from watching: the board needs no spawn path, and the
   spawn path needs measured stdin behaviour plus a streaming format
   (`--format json` exists on `--help`; what its JSONL actually contains across
   tool calls has not been read off a live process).

When someone measures both, the shape is `AGENTS += "opencode"`,
`knownLocations` plus `%APPDATA%\npm`, `MODES.opencode`, and an
`invocationFor` branch — and a contract § here first.

## 7. What promotion to `hooks: true` requires

One real turn, on a real hub, from an opencode session in a wired repo:
a `prompt`, at least one `tool`, and a `turn_end`, all `agent: opencode`,
visible in `/api/state`. Until then the honest label is `unverified`, and
`doctor.mjs` says so in as many words.
