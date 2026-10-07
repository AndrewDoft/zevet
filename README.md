# zevet

A multiplayer IDE for teams whose agents are doing the typing.

Watch your team's AI coding agents work, live, in one place — and edit the files
they are working in, together, while they do it.

Three people, three machines, three Claude agents. `zevet` shows you who is
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
already reach the hub, so the update channel is exactly as available as the
product. Both update channels are Ed25519-signed with one pinned key, and the
hub holds no private key (D-026, D-027).

### Where it runs

The hub is live at **https://hub.usemasora.com**, on the Google Compute
Engine instance `masora-app`, behind the Caddy that fronts usemasora.com — the
same Caddy block also answers on **https://34-74-69-129.sslip.io**, which is
never taken away. The sslip address is the one with no DNS dependency at all
(`sslip.io` resolves any dotted-quad hostname to that address, which is how a
box with no spare domain gets HTTPS), so it stays live permanently as the
fallback for a network that cannot resolve `usemasora.com` — a blocked
resolver, or a filter that treats a bare `sslip.io` domain on principle as
untrusted and refuses it instead.

`desktop/hub-target.js`'s `HOSTED_HUB` is the domain now; `LEGACY_HUB` names
the sslip address for exactly one purpose — an existing install whose stored
`cfg.hub` is still the old default gets rewritten to the new one on launch,
automatically, but only once a quick reachability check of the new host
actually succeeds (see `migrateHubDomain` in `desktop/main.js`). A hub
configured on purpose — self-hosting, `ZEVET_HUB`, an address typed into
setup — is never touched by that rewrite.

The hub moved to this GCE instance on 2026-09-19, from a DigitalOcean droplet
at `157-245-87-197.sslip.io` (where usemasora.com used to be served from too;
the old address no longer serves the hub). The token did not change either
time — an existing install only ever needs a new address, not a new
credential.

    /srv/zevet                     the checkout
    /srv/zevet/.env                ZEVET_TOKEN, 0600
    docker container `zevet-hub`   node:22-alpine, --restart unless-stopped,
                                   on Caddy's network, no published ports
    Caddyfile                      one site block, reverse_proxy zevet-hub:8787
                                   with flush_interval -1 (SSE must not buffer)

To ship a new client build: push, then on `masora-app` (reached via IAP)
`cd /srv/zevet && git pull`, and recreate the container from its compose
project with `docker compose up -d --force-recreate zevet-hub`. `docker restart`
does not re-read `env_file`, so it is not enough after an env change. Teammates
converge on their next check.

### Running your own hub



```bash
export ZEVET_TOKEN="$(openssl rand -hex 24)"   # any long random string
node hub/server.mjs
```

The board is at `<hub>/?token=<ZEVET_TOKEN>`.

### Sign-in providers

A hub signs people in with GitHub, Google or Microsoft — any mix; each is on when its variables are set. All three
buttons ("Continue with …") appear on the desktop setup window, in Settings, and as "Link …" for a second account.
Masora's own sign-in is separate and optional; nothing here requires it.

| Variable | Meaning |
|---|---|
| `ZEVET_MICROSOFT_CLIENT_ID`, `ZEVET_MICROSOFT_CLIENT_SECRET`, `ZEVET_MICROSOFT_REDIRECT` | Microsoft (Entra ID **and** personal accounts, tenant `common`). Register a *web* app, supported accounts "any organizational directory and personal Microsoft accounts", add the redirect `https://<hub>/auth/microsoft/callback`. All three or the hub refuses to start. |
| `ZEVET_MICROSOFT_OWNER` | Optional email that alone may claim an unclaimed hub through Microsoft. Without it an unclaimed hub reserved by `ZEVET_GITHUB_OWNER`/`ZEVET_GOOGLE_OWNER` stays reserved against Microsoft too. |

Microsoft's `email` claim is **not proof** (a tenant admin can set it to anything). Zevet treats it as a verified
address — for auto-linking to the same person on another provider, and for claiming an email invite — only when the
id token carries `xms_edov` (add it as an optional claim on the app registration). Without it the person can still
sign in where they are already on the team's list, but is never linked or admitted by an address. There is no Microsoft
domain door (Google's `hd` has no clean analogue); invite people by email instead.

### Onboarding a teammate

**On a hub with sign-in (the default; D-007, D-021),** a teammate installs the
desktop app and signs in. Invite them by email or login: if they
are on the team's list, signing in with GitHub, Google or Microsoft is enough,
and the hub gives their app the team secret. An invite also mints a one-time
8-character key (14-day expiry), mailed to them when the hub has a mailer or
shown to you when it does not; they enter team and key in the setup window.
Nothing long is pasted. Each team created on a hub has its own master secret
and allowlist (D-014).

**On a shared-token hub (self-hosted, no sign-in),** or for a machine that only
runs the hooks, send them **one command and one secret**. On macOS:

```bash
curl -fsSL https://hub.usemasora.com/setup.sh -o setup.sh && bash setup.sh
```

On Windows:

```powershell
irm https://hub.usemasora.com/setup.ps1 -OutFile setup.ps1; powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

(`https://34-74-69-129.sslip.io` works identically for both — same hub,
same token — for a network that cannot resolve `usemasora.com`.)

It asks for the hub URL (that one), the shared token (send it separately, not in
the same message as the link) and the name they want on the board. Then it finds
their agents by itself — there is nothing to tell it about Claude Code, Codex or OpenCode.

They run it, answer three prompts, and they're on the board.

> **Read this before you send it.** The hub is also the update server, which
> means it can replace code that runs on your teammates' machines before every
> tool call. Over plain `http://` that authority belongs to anyone who can
> alter traffic on the way — café wifi, a hotel router, a compromised switch —
> not just to you. **Put the hub behind HTTPS before you send this to anyone
> outside your own LAN.** The setup scripts warn about this; they do not
> prevent it, because sometimes a trusted LAN is genuinely fine.
>
> The per-file sha256 in the manifest is a corruption check. What makes it
> a security control is the signature over the manifest: it is Ed25519, checked
> against a public key pinned inside the client, not fetched from the hub, and
> the hub holds no private key (D-026). A manifest that is unsigned or does not
> cover exactly the files served is rejected, so updates pause instead of
> shipping unsigned code. A client that predates signing takes its first signed
> update on trust of the old channel; only later updates are protected.

```bash
curl -fsSL <hub>/setup.sh -o setup.sh && bash setup.sh      # macOS
```

```powershell
irm <hub>/setup.ps1 -OutFile setup.ps1; powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

The setup script checks every file it downloads against the hub's manifest and
installs nothing unless all of them match, and the manifest is signature-checked
as above. It also refuses any filename that is not a plain name,
because `path.join` treats `../evil.mjs` as an instruction rather than a file.

### The master secret, and the cutover

There are two values, not one. Whether the hub can read your source depends on
which team you are on.

- The **master secret** is what the team shares. It lives in each teammate's
  `~/.zevet/config.json` as `secret`.
- The **derived token** is what a client puts in its `x-zevet-token` header. It
  is `SHA-256("zevet-auth\0" || secret)`.

**Teams that sign in (GitHub, Google, Microsoft, an invite key; D-007, D-021):
the hub holds the master secret.** It hands it to whoever signs in, and keeps
it on disk (`hub/accounts.mjs`). So the hub's operator, anyone who reads its
disk or memory, and anyone who ends up with a backup of `/srv/zevet/var/` can
decrypt document traffic. The hub *process* still only relays ciphertext; it
never opens a document or a steer. That is a statement about what it does, not
about what it could.

**Shared-token teams (a self-hosted hub with no sign-in): the hub is given the
derived token and never the secret.** The document key is
`HKDF-SHA-256(secret, info "zevet-doc")`, so a hub that only ever sees the
derived token cannot compute it, and relays ciphertext it cannot read.
`client/secret.mjs` is the specification, including what this does **not**
protect against — a hub that has been taken over serves the board's own
JavaScript and does not need your key. The rest of this section is about this
mode.

Generate a secret, and derive the token from it:

```bash
# the master secret — this is what you send each teammate, and only them
openssl rand -hex 24

# the derived token — this is what the hub gets, and it is safe to keep on the server
node -e 'import("./client/secret.mjs").then(m => console.log(m.deriveAuthToken(process.argv[1])))' <the-master-secret>
```

Both setup scripts also print the derived token, fenced off under
`--- hub operator only ---`, so it can be read off any machine that has already
been set up.

**The cutover, in order.** Do it when everyone is around, because step 1 locks
out every machine that has not yet done step 3:

1. Set the hub's `ZEVET_TOKEN` to the **derived token**.
2. Recreate the hub on `masora-app` (`git pull`, then
   `docker compose up -d --force-recreate zevet-hub`; `docker restart` does not
   re-read `env_file`).
3. Re-run `setup.sh` / `setup.ps1` on **every** machine, pasting the **master
   secret** where it asks for it. Each one derives the same token and is let
   back in.

**A legacy install gets a 401 the moment the hub's env changes.** There is
deliberately no dual-accept window: the hub holds exactly one `ZEVET_TOKEN` and
compares against it, and teaching it to accept both would mean the raw token
stayed a valid credential for as long as anyone forgot to finish the migration —
which, given the derived scheme exists to stop a shared-token hub ever holding
key material, is the one state worth making impossible rather than
comfortable. The
fallback in `client/secret.mjs` buys an ordering, not a coexistence: an install
that has updated its client but not re-run setup keeps working until step 1, and
then stops. `node client/doctor.mjs` names that state in so many words —
`[--] credential  LEGACY: a raw token, no master secret` — and says that
re-running setup is the fix.

Until a machine has a `secret`, the shared editor is simply unavailable to it.
It has no way to derive the document key, so there is nothing for it to decrypt.

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

## Shared editing

The board is an editor. Open a workspace, click a file, and you get CodeMirror
bound to a shared document: your teammates' cursors are in it, and so are your
agent's edits as they land on disk.

**This reverses what this file used to say.** It recommended [Zed](https://zed.dev)
for the shared buffer and said zevet "deliberately does not do real-time shared
editing — that is a solved problem and not worth rebuilding". Composing the two
does work, and it asks a team to run two things and hold the relationship
between them in their heads. The thing zevet uniquely knows — which file whose
agent is editing, right now — is most useful *in* the buffer, not in a panel
beside it. See `DECISIONS.md` D-005 for what else was considered, including
peer-to-peer over WebRTC, which was rejected on cost rather than on merit.

Zed remains a fine editor and its own warning is still worth repeating for
anyone using its multiplayer: *"Sharing a project gives collaborators access to
your local file system within that project. Only collaborate with people you
trust."* The same caution applies here.

### What the hub relays, and what it can read

File contents cross the hub as ciphertext, and the hub process never opens them.

Teammates share one master secret `S`; the key that encrypts document traffic is
`HKDF(S)`. Each update is AES-256-GCM with the room name — `<repo>:<path>` — as
additional data, so a relay cannot take an update for one file and replay it
into another file's room.

**Whether the hub could decrypt depends on the team (D-005, D-007).**

- *Sign-in teams* (the default): the hub holds `S`. An operator, anyone who
  reads the box's disk or memory, and anyone with a backup can decrypt document
  traffic. The encryption protects the wire and the relay's behaviour, not the
  documents from a watched hub. This was traded for joining without pasting
  anything.
- *Shared-token teams* (self-hosted, no sign-in): the hub is given only
  `SHA-256("zevet-auth" || S)` and cannot derive `HKDF(S)`. The encryption
  defends against a hub that is honest but curious, against whoever can read its
  memory or its disk, and against anyone who ends up with its logs.

**What neither defends against, said plainly.** The board loads its page
*from* the hub. A hub that has been taken over does not need the key; it serves
JavaScript into the window that already has one. Serving the editor from the
desktop app's own files is the real fix and **has not been done**. Nor is
peer-to-peer, where the code would never reach the hub (D-005).

The hub also still sees who is editing which file in which repo, and roughly how
much. That is the board's whole job.

### What it does not do yet

- **Two machines have never edited one file.** Every path here has been
  exercised against a simulated peer in one browser. Nobody has run it on two
  computers.
- **No presence for an agent's line.** A teammate's cursor is exact, because it
  comes from the document's own awareness. An agent's is not shown at all: the
  hook reports which file a tool touched and carries no line number, and a
  figure drawn at line 1 because line 1 is all we know would be a fabrication.
- **A file over 512 KiB opens read-only** and is never shared. Sharing half a
  file and writing it back would delete the rest of it on every machine.
- **Two people opening the same empty room at once** is handled but not
  perfectly — see `SEED_CLIENT_ID` in `hub/public/index.html` for what happens
  and what is still wrong about it.

**Why not VS Code Live Share:** it still works and it is free and cross-platform,
but Microsoft's docs now say *"Visual Studio Live Share is in maintenance mode,
with no additional features planned."*

---

## What it deliberately does not do

No worktree orchestration across machines. That machinery exists so agents on
different machines can edit one repo simultaneously without colliding. Three
people who can talk to each other get most of it from a branch convention and
a board that shows the collision coming. It is also the machinery that is
hardest to get right, and the reason the tool this replaces was unusable.

**This list used to include "no cross-machine approval routing", and that is no
longer true (D-058).** You can steer a teammate's agent: the Steer button on
their agent row aims your composer at it, and what you send is sealed on your
machine with the document key, relayed by the hub (whose process does not open it), and
queued on their agent as a turn starting `[from <you>]`. Whether that is
allowed (and whether a teammate may start an agent on your machine, below) is one team-wide setting only the team owner can change, enforced by
the hub: **Ask first** (the default — their app shows an approval card and
nothing reaches the agent until they approve), **Always on**, or **Always
off**. You see every steer's outcome: sent, delivered, accepted, declined (with
why), refused by policy, offline, or unknown agent. A steer is text only — it
cannot change a mode, grant a tool permission or answer a permit — and only
agents running in their Zevet app can be steered, not ones in a plain
terminal. It is still remote prompt injection into a machine holding
credentials, which is why the default asks. On a sign-in team the hub holds the team secret on disk (see `hub/accounts.mjs`),
so "does not open it" means the hub process never does, not that it could not.

**You can also start an agent on a teammate's machine (D-060).** "Run as" in
the new-agent flow, or "+ agent on <name>'s machine" on their row, aims your
composer at them: pick one of their repos (the board lists the ones it has
seen them work in; you can type a folder name), pick Claude, Codex or
OpenCode, and your message becomes the new agent's first prompt. It runs in
THEIR Zevet app, in their copy of that repo, with their account, and shows on
the board under their name, marked "by <you>". The same team setting governs
it: under **Ask first** their app shows a card with the agent, the exact
folder and the whole prompt, and nothing starts until they click Start. It is
higher risk than a steer, so: the repo must be a folder name their app already
has open (anything path-like is refused, and a name they do not have answers
"no such repo on their machine"); the agent always starts in the owner's own
default safe mode (plan or ask first — never auto, never skip permissions),
whatever the sender wanted; a request carrying a mode, flags, a folder path or
an environment is refused by the hub; at most three agents started by
teammates run on one machine at a time; and senders are rate limited. You see
sent, delivered, accepted, started (with the new session; and if it then cannot work, for example because the app is not signed in to Claude, "started, but it failed" with the reason), declined, no such
repo, refused by policy, or offline.

**Prompt text is shared, including into agents.** Every teammate already sees
everyone's prompts on the board; now agents see a short summary too. A
desktop-launched Claude gets a bounded "team activity" block (who is working
on what, the first line of teammates' last few prompts, open comments) in its
system prompt, framed as data, not instructions, and `~/.zevet/activity.md`
holds the current version. `node client/install.mjs <repo> --activity` adds an
`@~/.zevet/activity.md` import to that repo's `CLAUDE.md` for agents started in
a terminal (opt-in; `--remove` takes it out). Nothing goes through the hook's
stdout. The cost, said plainly: a teammate's prompt is now input to your agent.

**This list used to include "no syncing anyone's uncommitted work onto anyone
else's checkout", and that is no longer true.** A file open in the shared editor
is written to every participant's disk as it changes — that is what makes it a
shared editor rather than a shared view. The scope is narrow and worth being
precise about: it is the files people have deliberately OPENED, and nothing
else. zevet does not sync a branch, does not touch git, and does not move a file
nobody has open. But if you and a teammate both have `src/db.ts` open, your
working copy of that file will change under you, which is the point and is also
a thing to know before you open one.

---

## Layout

```
hub/server.mjs         the hub: ingest, live feed, board, update channel.
hub/public/index.html  the board. one file, no build step.
client/hook.mjs        runs on every prompt and tool call. silent, fails open.
client/opencode-plugin.mjs  the same, as an opencode plugin (copied per repo, self-contained).
client/install.mjs     writes/removes the hooks in a repo's .claude/settings.json
client/install-opencode.mjs wires/removes the plugin in a repo's .opencode/plugins/
client/updater.mjs     keeps this machine in step with the hub. runs detached.
client/activity.mjs    the team activity block agents read (~/.zevet/activity.md).
desktop/agent-steer.js steering a teammate's agent: seal, send, approve, inject.
dist/setup.ps1         what a Windows teammate runs once.
dist/setup.sh          what a macOS teammate runs once.
```

## Configuration

Teammates get this written for them by the setup script, into
`~/.zevet/config.json`. Environment variables override it.

| Variable | Side | Default | Meaning |
|---|---|---|---|
| `ZEVET_SECRET` | client | unset | The team's master secret, overriding `secret` in config.json. Never sent anywhere; the client derives from it. |
| `ZEVET_TOKEN` | both | *required* on the hub | On the hub: the **derived** token it compares against. On a client: a raw token, honoured only by pre-cutover installs that have no `secret`. |
| `PORT` | hub | `8787` | Port the hub listens on. |
| `ZEVET_HUB` | client | `http://127.0.0.1:8787` | Where hooks send events. |
| `ZEVET_ACTOR` | client | OS username | Your name in the lanes. |
| `ZEVET_HOME` | client | `~/.zevet` | Where the client and its config live. |
| `ZEVET_TIMEOUT_MS` | client | `1500` | Give-up time per event. This is the worst case a stalled hub can add to one tool call. |
| `ZEVET_UPDATE_INTERVAL_MS` | client | `1800000` | How often to check for a new build. |
| `ZEVET_COLLISION_WINDOW_MS` | hub | `600000` | How recent two edits must be to collide. |
| `ZEVET_DEBUG` | client | unset | Print each raw hook payload to stderr. |
