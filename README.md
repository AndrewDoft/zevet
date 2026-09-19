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

### Where it runs

The hub is live at **https://34-74-69-129.sslip.io**, on the Google Compute
Engine instance `masora-app`, behind the Caddy that fronts usemasora.com. Real
Let's Encrypt certificate, no DNS record needed: `sslip.io` resolves any
dotted-quad hostname to that address, which is how a box with no spare domain
gets HTTPS.

It moved there on 2026-09-19. It used to run on a DigitalOcean droplet at
`157-245-87-197.sslip.io`, which is where usemasora.com used to be served from
too; the site moved to Google Cloud and the hub was the last thing left behind.
The token did not change, so an existing install needs only the new address —
`~/.zevet/config.json`, or re-run setup. The old address no longer serves the
hub.

    /srv/zevet                     the checkout
    /srv/zevet/.env                ZEVET_TOKEN, 0600
    docker container `zevet-hub`   node:22-alpine, --restart unless-stopped,
                                   on Caddy's network, no published ports
    Caddyfile                      one site block, reverse_proxy zevet-hub:8787
                                   with flush_interval -1 (SSE must not buffer)

To ship a new client build: push, then on the droplet
`cd /srv/zevet && git pull && sudo docker restart zevet-hub`. Teammates
converge on their next check.

### Running your own hub



```bash
export ZEVET_TOKEN="$(openssl rand -hex 24)"   # any long random string
node hub/server.mjs
```

The board is at `<hub>/?token=<ZEVET_TOKEN>`.

### Onboarding a teammate

Send them **one command and one secret**. On macOS:

```bash
curl -fsSL https://34-74-69-129.sslip.io/setup.sh -o setup.sh && bash setup.sh
```

On Windows:

```powershell
irm https://34-74-69-129.sslip.io/setup.ps1 -OutFile setup.ps1; powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

It asks for the hub URL (that one), the shared token (send it separately, not in
the same message as the link) and the name they want on the board. Then it finds
their agents by itself — there is nothing to tell it about Claude Code or Codex.

They run it, answer three prompts, and they're on the board.

> **Read this before you send it.** The hub is also the update server, which
> means it can replace code that runs on your teammates' machines before every
> tool call. Over plain `http://` that authority belongs to anyone who can
> alter traffic on the way — café wifi, a hotel router, a compromised switch —
> not just to you. **Put the hub behind HTTPS before you send this to anyone
> outside your own LAN.** The setup scripts warn about this; they do not
> prevent it, because sometimes a trusted LAN is genuinely fine.
>
> The per-file sha256 in the manifest is a **corruption check, not a security
> control.** The manifest and the files it describes come from the same place
> over the same connection, so whoever can forge one can forge the other. It
> catches a truncated download; it does not catch a hostile hub. Making it
> load-bearing would need a signature the client checks against a key it did
> not fetch from the hub. That is not built.

```bash
curl -fsSL <hub>/setup.sh -o setup.sh && bash setup.sh      # macOS
```

```powershell
irm <hub>/setup.ps1 -OutFile setup.ps1; powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

The setup script checks every file it downloads against the hub's manifest and
installs nothing unless all of them match — see the caveat above for what that
check is and isn't worth. It also refuses any filename that is not a plain name,
because `path.join` treats `../evil.mjs` as an instruction rather than a file.

### The downloadable app

`desktop/` is an Electron app: a setup window that collects the hub, token and
name and tests the connection before saving, a native folder picker that wires
a repo, and OS notifications when a teammate touches a file you are also in
(raised from the main process, so they arrive when the window is in the
background — the only time a notification is worth anything).

```bash
cd desktop && npm install
npm run dist:win     # -> desktop/out/zevet-<version>-windows-x64-setup.exe
```

**A .dmg cannot be built on Windows.** electron-builder needs macOS to make
one, so `.github/workflows/build.yml` builds both on their own runners; start it
from the Actions tab and download the artifacts.

**Neither artifact is signed**, and the build log says so: *"no signing info
identified, signing is skipped."* macOS will tell your teammate the app
*"can't be opened because Apple cannot check it for malicious software"* until
they right-click → Open, and Windows SmartScreen hides Run behind "More info".
Signing properly costs an Apple Developer account (99 USD/year) and a Windows
certificate. Worth deciding deliberately rather than finding out on the phone.

The app still needs Node on the machine: the hooks are run by `node`, never by
the app binary. (An earlier build pointed them at `zevet.exe`, which booted
Chromium on every tool call and wrote to stdout — see the commit.)

### Shipping a change

Edit a file in `client/`, bump `version` in `package.json`, reload the hub.
That's the whole publish step — the manifest is hashed per request, so there is
no build and nothing to tag. Teammates converge on their next check.

---

## Windows and macOS are both first-class

Every path here is written to work identically on both, and the ones below were
run on Windows to prove it. That sentence used to read "every path here has been
run on Windows", which was not true and cost a whole class of bug: Windows
PowerShell 5.1 writes a UTF-8 BOM, `JSON.parse` rejects it, and every Windows
teammate silently fell back to `127.0.0.1`, never appeared on the board and
never received an update — while setup printed "Done." Five things were got
wrong first and fixed, and they are the reason to be careful:

- **Config is written without a BOM, and setup reads it back the way the client
  does.** The verification step originally used `require()`, which strips a BOM
  and therefore could never detect the one failure it existed to detect.
- **The installer recognises its own hooks by a flag it owns**, not by a path
  substring. Matching `zevet/client/hook.mjs` worked only because `.zevet/`
  contains `zevet/`; from a ZIP unpacked as `zevet-main/`, three installs
  stacked three copies of every hook and `--remove` removed none of them.

- **File paths are stored relative to the repo root**, never absolute. Andrew's
  `C:\dev\masora\src\db.ts` and Kai's `/Users/kai/code/masora/src/db.ts` are the
  same file. Comparing absolute paths would mean the collision warning silently
  never fires in a mixed-OS team — which is the only kind of team this is for.
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

**What it does not promise: zero cost.** Claude Code waits for a hook to exit,
so the hook is on the critical path of every tool call whether it likes it or
not. A refused connection fails in about 46ms and is unnoticeable. A hub that
*accepts* the connection and then stalls — a VPN dropping, a sleeping host —
costs the full `ZEVET_TIMEOUT_MS`: measured at ~1580ms per tool call, so a
40-call turn pays about a minute. An earlier draft of this file said the hook
"never blocks a turn". That was wrong. What the hook genuinely cannot do is
*end* a turn or change a permission decision, and that is the property the two
rules above actually defend.

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
client/updater.mjs     keeps this machine in step with the hub. runs detached.
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
| `ZEVET_TIMEOUT_MS` | client | `1500` | Give-up time per event. This is the worst case a stalled hub can add to one tool call. |
| `ZEVET_UPDATE_INTERVAL_MS` | client | `1800000` | How often to check for a new build. |
| `ZEVET_COLLISION_WINDOW_MS` | hub | `600000` | How recent two edits must be to collide. |
| `ZEVET_DEBUG` | client | unset | Print each raw hook payload to stderr. |
