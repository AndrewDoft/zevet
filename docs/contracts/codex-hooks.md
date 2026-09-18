# Codex hooks — contract note

**Verified 2026-09-18 against `codex-cli 0.155.0-alpha.2.6`**, the build installed at
`C:\Users\andre\AppData\Local\OpenAI\Codex\bin\eab8377aebac6c07\codex.exe`.

There are no public docs for this surface that were reachable in that session, and the
install ships no documentation. Per CLAUDE.md §4.2 this note is therefore written from
the **binary itself** plus **executed experiments**, and every claim below is something
that was run and observed. Where a thing was not observed, it says so.

---

## 1. Hooks exist and are on by default

```
$ codex features list | grep -i hook
hooks                                    stable             true
plugin_hooks                             removed            false
```

`hooks` is a **stable** feature and enabled without configuration. No `features.hooks = true`
is required. `plugin_hooks` is a separate, removed feature and is not what zevet uses.

## 2. Hooks are read from the GLOBAL config only

**`$CODEX_HOME/config.toml`** (default `~/.codex/config.toml`).

A `[hooks]` block in **`<repo>/.codex/config.toml` never fires** — not on any event, not when
the project is trusted, not with `--dangerously-bypass-hook-trust`. The identical block moved
to `$CODEX_HOME/config.toml` fires on every turn. This was tested by registering the same
handler in both places in one run and seeing only the global one execute.

> Note: `--strict-config` does **not** help you discover this. It ignored a deliberately
> invalid key (`this_key_is_not_real_zzz`) inside a repo-local config *and* inside a hook
> handler table, so it is not a schema validator for nested hook tables. Do not use a clean
> `--strict-config` run as evidence that a hook config is correct.

This is why zevet's Codex support never worked: it wrote `<repo>/.codex/config.toml`.

## 3. Hook trust is mandatory, and its absence is SILENT

With a valid global block and no trust granted, `codex exec` runs the turn normally and
**no hook fires, with no warning, no prompt, and no error**. An unwired install and an
untrusted one look identical from the outside.

Trust is persisted in the config as `hooks.state."<key>".trusted_hash` (strings
`HookStateToml`, `trusted_hash` in the binary). The interactive TUI grants it through a review
screen (`tui\src\startup_hooks_review.rs`, "Failed to trust hooks:"). For automation there is:

```
--dangerously-bypass-hook-trust    Run enabled hooks without requiring persisted hook
                                   trust for this invocation. DANGEROUS. Intended only
                                   for automation that already vets hook sources
```

**NOT VERIFIED:** that the interactive `codex` TUI prompts for this and persists it. That needs
a terminal, which this session did not have. zevet therefore tells the user to run `codex` once
in the repo and accept the prompt, and that instruction is untested. See `INSUFFICIENCIES.md`.

Project trust (`[projects.'<path>'] trust_level = "trusted"`) is a **separate** gate, also
required: *"Project-local config, hooks, and exec policies are disabled in the following
folders until the project is trusted, but skills still load."*

## 4. Event names

From `HookEventsToml` in the binary:

```
PreToolUse  PermissionRequest  PostToolUse  PreCompact  PostCompact
SessionStart  SessionEnd  UserPromptSubmit  SubagentStart  SubagentStop
Stop  Interrupt
```

zevet registers `UserPromptSubmit`, `PreToolUse` and `Stop`. `SessionStart`, `SessionEnd`,
`PostCompact`, `PermissionRequest`, `SubagentStart` and `Interrupt` have no Claude Code
equivalent in zevet's event vocabulary and are not used.

## 5. Config shape

```toml
[hooks]
UserPromptSubmit = [{ hooks = [{ type = "command", command = '...', timeout = 10 }] }]
PreToolUse       = [{ matcher = "*", hooks = [{ type = "command", command = '...', timeout = 10 }] }]
Stop             = [{ hooks = [{ type = "command", command = '...', timeout = 10 }] }]
```

- The group is `ConfiguredHookMatcherGroup`, whose two fields are `matcher` and `hooks`.
- The handler is an internally-tagged enum `HookHandlerConfig` with variants `Command` and
  `McpTool`. The `Command` variant's fields are `command`, `windows`, `timeout`, `async`,
  `statusMessage`, `additionalContextLimit`.
- **`command` must be a STRING.** An array is rejected at load:
  `Error loading config.toml: invalid type: sequence, expected a string`.
- `windows` is accepted as a sibling key (a Windows-specific override). zevet does not need it
  given §6, and its exact semantics were not tested.

## 6. The command string: the program name may not be quoted

The command is **not** run through a shell. Codex takes the program from the first
whitespace-delimited token and **does not honour quotes around it**. Arguments quote fine.

Measured, one run, four handlers on the same event:

| command | result |
| --- | --- |
| `node C:/x/hook.mjs tag` | **Completed** |
| `node "C:/dir with space/hook.mjs" tag` | **Completed** — args quote fine |
| `"C:/Program Files/nodejs/node.exe" C:/x.mjs tag` | **Failed** |
| `'C:/Program Files/nodejs/node.exe' C:/x.mjs tag` | **Failed** |
| `"C:\Program Files\nodejs\node.exe" C:/x.mjs tag` | **Failed** |
| `cmd /c "C:\Program Files\nodejs\node.exe" C:/x.mjs tag` | **Completed** |
| `C:/PROGRA~1/nodejs/node.exe C:/x.mjs tag` | **Completed** |

Windows puts node under `C:\Program Files\nodejs` by default, so **zevet wraps the Windows
command in `cmd /c`**. On macOS and Linux node lives somewhere unspaced (`/usr/local/bin`,
`/opt/homebrew/bin`) and is written directly; the installer refuses rather than emit a broken
command if that path ever does contain a space.

## 7. Payload

Delivered on **stdin** as JSON. A real `Stop` payload, captured:

```json
{
  "session_id": "01a0b56c-6de0-7ee0-a30d-9c616302d362",
  "turn_id": "01a0b56c-6e16-7551-adc2-a6700effe77c",
  "transcript_path": "...\\sessions\\2026\\09\\18\\rollout-...jsonl",
  "cwd": "...\\codexprobe\\repo",
  "hook_event_name": "Stop",
  "model": "gpt-6-astra",
  "permission_mode": "bypassPermissions",
  "stop_hook_active": false,
  "last_assistant_message": "ok"
}
```

**`cwd` IS present.** zevet's code previously carried a comment asserting the opposite
("CODEX DOES NOT — its hook stdin vocabulary has no such field"), and that false belief is why
the installer baked a `--zevet-repo` into the command. It is removed: the repo now comes from
the payload, which is what makes a single global hook able to serve many repos correctly.

The hook process's own `cwd` is also the repo.

## 8. Consequence for zevet: the opt-in list

Because the hooks block is global, the hook runs for **every** project on the machine. Publishing
all of them to a hub the whole team can read is not what installing zevet into one repo should
mean. So `client/install-codex.mjs` maintains `~/.zevet/codex-repos.json`, and `client/hook.mjs`
drops any Codex event whose repo is not on that list. See `DECISIONS.md` D-001.

Verified both directions on the live hub: a turn in `C:\dev\GitHub\zevet` (listed) produced
`prompt` and `turn_end`; a turn in `C:\dev\GitHub\masora2` (not listed) produced nothing, while
its hooks still ran.

## 9. Gotcha that cost time

`codex exec` reads stdin and appends it to the prompt. Run from a harness that leaves stdin
open, it blocks forever with no output — it is waiting for EOF, not hung on the network.
Always redirect: `codex exec ... < /dev/null`.
