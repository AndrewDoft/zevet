# Muse Code — contract note (detection only, hooks NOT wired)

**Verified 2026-09-27** against Meta's own developer docs, fetched this session:

- https://dev.meta.ai/docs/muse-code/ (overview)
- https://dev.meta.ai/docs/muse-code/extending
- https://dev.meta.ai/docs/muse-code/configuration
- https://dev.meta.ai/docs/muse-code/session-messaging
- https://dev.meta.ai/docs/muse-code (install)

## What it is

"Muse Code is Meta's coding agent for the terminal and CI, built for Muse
Spark." A native `muse` binary, installed via a one-line script — no npm
package, no Homebrew formula:

```
macOS / Linux:  curl -fsSL https://dev.meta.ai/install.sh | sh
Windows:        irm https://dev.meta.ai/install.ps1 | iex
```

"Muse Code runs on macOS, Linux, and Windows from one codebase." Cross-platform,
same as Claude Code and Codex, so `client/detect.mjs`'s generic `onPath("muse")`
check applies with no extra assumptions.

## Hooks — documented, but the wire format is not

Event names (15, from `/docs/muse-code/extending`): `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`,
`PostToolUseFailure`, `PreLLMCall`, `PostLLMCall`, `PreCompact`, `PostCompact`,
`SubagentStart`, `SubagentStop`, `Notification`, `Stop`, `SessionEnd` — a
superset of Claude Code's own vocabulary, closer to Claude Code's shape than to
Codex's.

Hooks come from three sources:

1. **Project-level:** committed to the repo at `<project-root>/.muse/hooks.json`.
   "Project hooks run only after you trust the project folder" — a trust gate,
   same idea as Codex's (docs/contracts/codex-hooks.md §3), exact mechanics not
   fetched.
2. **User-level:** "your machine-wide hooks, defined in your settings"
   (`~/.config/muse/settings.json`).
3. **Managed:** a file `managed_hooks_path` points to.

MCP servers are declared in the same settings file's `mcp_servers` block:

```json
{ "mcp_servers": { "my-tools": { "transport": "stdio", "command": "my-mcp-server", "args": [] } } }
```

`transport` is `stdio` or `streamable_http`, with optional `enabled`/`mode`.

**What is NOT documented anywhere reachable in this session: the exact JSON
payload a hook command receives on stdin** (field names like Claude Code's
`hook_event_name`/`session_id`/`transcript_path`, or Codex's near-identical
shape — see docs/contracts/codex-hooks.md §7) and **the exact path/format of a
retained session transcript**. The docs confirm transcripts exist in some form
— "a session started with `muse --no-session-log` has no retained name and
cannot participate in peer messaging," implying a session log is retained by
default — but not where, or as what.

Per the standing instruction not to guess a wire format: **zevet does not
write a `.muse/hooks.json`, does not register any hook, and does not scan for
a Muse Code session/transcript file.** Doing so without a confirmed payload
shape would be exactly the failure mode `codex-hooks.md` had to correct twice
(the `<repo>/.codex/config.toml` location that silently never fired, and the
un-quoted-program-name bug) — except here there is no `muse` install available
in this session to test against and catch the mistake. See INSUF-009.

## What IS added

`client/detect.mjs` gained a `muse-code` entry: binary presence (`muse` on
PATH), and `signedIn` inferred from the `MODEL_API_KEY` environment variable —
the same "presence only" discipline every other entry uses. `hooks: false`,
so it reports installed-but-unwireable, exactly like an agent zevet has no
hook contract for today (the same state Gemini and any future unknown agent
would show). This is the "same UI treatment as Claude and Codex" for
*detection*; live-board wiring is explicitly not part of this change.
