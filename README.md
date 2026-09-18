# zevet

Watch your team's AI coding agents work, live, in one place.

Three people, three machines, three Claude Code agents. `zevet` shows you who is
prompting what, which files each agent is touching, and — the part that actually
saves you — **when two of you are about to edit the same file.**

It does not fork an editor, does not touch your git history, and cannot end
anyone's turn.

```
andrew   ▌  ▌▌▌     ▌▌▌      ▌▌▌           ● Edit  src/db.ts
kai      ▌            ▌                    ● Bash  npm test
michael    ▌ ▌                               idle 5m
         -8m      -6m     -4m    -2m   now

  src/db.ts   kai 13s ago · andrew 27s ago
```

---

## How it's shipped

One person (Andrew) runs **the hub**. Everyone else runs **the client**, which
is three small files in `~/.zevet/client`.

The hub is also the update server. Change a client file on the hub, and every
teammate's client picks it up on its own within half an hour — no re-download,
no re-install, nothing to email twice. Everyone who can use zevet at all can
already reach the hub and already holds the shared token, so the update channel
is exactly as available as the product.

### Running the hub

```bash
export ZEVET_TOKEN="$(openssl rand -hex 24)"   # any long random string
node hub/server.mjs
```

The board is at `<hub>/?token=<ZEVET_TOKEN>`.

### Onboarding a teammate

Send them **one link and two values**:

- the setup script — `<hub>/setup.sh` (macOS) or `<hub>/setup.ps1` (Windows)
- the hub URL
- the shared token

They run it, answer three prompts, and they're on the board:

```bash
curl -fsSL <hub>/setup.sh -o setup.sh && bash setup.sh      # macOS
```

```powershell
irm <hub>/setup.ps1 -OutFile setup.ps1; powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

The setup script verifies every file it downloads against the hub's manifest
(sha256 per file) and refuses to install anything that doesn't match.

### Shipping a change

Edit a file in `client/`, bump `version` in `package.json`, reload the hub.
That's the whole publish step — the manifest is hashed per request, so there is
no build and nothing to tag. Teammates converge on their next check.

---

## Windows and macOS are both first-class

Every path here has been run on Windows and written to work identically on
macOS. Three things were got wrong first and fixed, and they are the reason to
be careful:

- **File paths are stored relative to the repo root**, never absolute. Andrew's
  `C:\dev\masora\src\db.ts` and Kai's `/Users/kai/code/masora/src/db.ts` are the
  same file. Comparing absolute paths would mean the collision warning silently
  never fires in a mixed-OS team — which is the only kind of team this is for.
- **The installer matches its own hooks separator-insensitively.** Matching
  `zevet/client/hook.mjs` against a Windows command containing backslashes
  fails, the strip quietly removes nothing, and re-installing stacks duplicate
  hooks. It was correct on macOS the whole time.
- **Hook commands are shell-quoted, not JSON-escaped**, so `C:\Program Files`
  and `/Users/kai/My Code` both survive.

---

## The two rules the hook will not break

The hook runs on every prompt and every tool call, on everyone's machine. It is
in a position to ruin someone's session, so it is written not to be able to:

1. **It never writes to stdout.** Not a decision, not a diagnostic, not `{}`.
   Silence is the only output guaranteed to leave Claude Code's own permission
   flow untouched.
2. **It always exits 0**, on every path including its own bugs. Diagnostics go
   to stderr.

This is not hypothetical caution. Amoeba's equivalent hook answered
`permissionDecision: "defer"` when its daemon had nothing to say, on the
documented belief that defer is the same as staying silent. Against Claude Code
2.1.275 it is not: the turn ends with `stop_reason: "tool_deferred"` and the
tool never runs. Every turn died after about five seconds.

The updater is held to the same standard: the hook spawns it detached and never
waits on it, so an update cannot sit in front of anybody's turn.

---

## Shared editing: use Zed

`zevet` shows you what everyone's agents are doing. It deliberately does not do
real-time shared editing — that is a solved problem and not worth rebuilding.

**Use [Zed](https://zed.dev).** Multiplayer is included on the free Personal
tier, Windows has been stable since 1.0, and it is actively developed. Zed's own
warning is worth repeating: *"Sharing a project gives collaborators access to
your local file system within that project. Only collaborate with people you
trust."*

**Why not VS Code Live Share:** it still works and it is free and cross-platform,
but Microsoft's docs now say *"Visual Studio Live Share is in maintenance mode,
with no additional features planned."*

The two layers compose: Zed for the shared buffer, zevet for the agents.

---

## What it deliberately does not do

No worktree orchestration, no cross-machine approval routing, no syncing anyone's
uncommitted work onto anyone else's checkout. That machinery exists so agents on
different machines can edit one repo simultaneously without colliding. Three
people who can talk to each other get most of it from a branch convention and a
board that shows the collision coming.

It is also the machinery that is hardest to get right, and the reason the tool
this replaces was unusable.

---

## Layout

```
hub/server.mjs         the hub: ingest, live feed, board, update channel.
hub/public/index.html  the board. one file, no build step.
client/hook.mjs        runs on every prompt and tool call. silent, fails open.
client/install.mjs     writes/removes the hooks in a repo's .claude/settings.json
client/updater.mjs     keeps this machine in step with the hub. never blocks.
dist/setup.ps1         what a Windows teammate runs once.
dist/setup.sh          what a macOS teammate runs once.
```

## Configuration

Teammates get this written for them by the setup script, into
`~/.zevet/config.json`. Environment variables override it.

| Variable | Side | Default | Meaning |
|---|---|---|---|
| `ZEVET_TOKEN` | both | *required* | Shared secret. No default, on purpose. |
| `PORT` | hub | `8787` | Port the hub listens on. |
| `ZEVET_HUB` | client | `http://127.0.0.1:8787` | Where hooks send events. |
| `ZEVET_ACTOR` | client | OS username | Your name in the lanes. |
| `ZEVET_HOME` | client | `~/.zevet` | Where the client and its config live. |
| `ZEVET_TIMEOUT_MS` | client | `1500` | Give-up time per event. Never blocks a turn. |
| `ZEVET_UPDATE_INTERVAL_MS` | client | `1800000` | How often to check for a new build. |
| `ZEVET_COLLISION_WINDOW_MS` | hub | `600000` | How recent two edits must be to collide. |
| `ZEVET_DEBUG` | client | unset | Print each raw hook payload to stderr. |
