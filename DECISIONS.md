# Decisions

Spec ambiguities resolved, with what else was considered and how reversible the choice is
(CLAUDE.md §6.4).

---

## D-001 — Codex hooks are global, so repos opt in through a list

**2026-09-18**

**Decision.** `client/install-codex.mjs` writes one managed `[hooks]` block into
`$CODEX_HOME/config.toml` and records each wired repo in `~/.zevet/codex-repos.json`.
`client/hook.mjs` drops any Codex event whose repo is not on that list.

**Why it came up.** Codex reads hooks only from the global config — a block in
`<repo>/.codex/config.toml` never fires (measured; see `docs/contracts/codex-hooks.md` §2).
zevet's per-repo install model has no equivalent here: one install necessarily arms every
project on the machine.

**Alternatives.**

1. *Report everything.* Simplest, and wrong: installing zevet into one repo would publish the
   user's activity in every unrelated repo — client work, private projects — to a hub the whole
   team can read. A tool that quietly widens its own scope is not one to hand to friends.
2. *Match on a path prefix* (report anything under a watched parent). Fewer moving parts, but
   it silently picks up siblings, which is the same failure in a smaller box.
3. *Bake the repo into the command* — what the code used to do. Only coherent when the config
   is per-repo. With one global block it would stamp every project with whichever repo was
   wired first.

**Reversibility.** High. The list is one JSON file and one `if` in the hook. Deleting both
yields option 1.

**Cost.** A repo wired up by editing the global config by hand, without going through
`install.mjs`, will fire hooks that publish nothing. The doctor should grow a check for that
mismatch; it does not have one yet.

---

## D-002 — `cmd /c` on Windows rather than requiring node on PATH

**2026-09-18**

**Decision.** The Windows hook command is `cmd /c "<node>" "<hook>" --zevet-hook --zevet-agent codex`.

**Why.** Codex resolves the hook program from the first whitespace-delimited token and does not
honour quotes around it, so `"C:\Program Files\nodejs\node.exe"` fails — which is where Windows
puts node by default (measured, `docs/contracts/codex-hooks.md` §6).

**Alternatives.**

1. *Bare `node`, from PATH.* Works when PATH has node, and it did here. Rejected as the default
   because zevet deliberately resolves an absolute interpreter elsewhere (`interpreter()` in
   `install.mjs` exists precisely to avoid pointing a hook at the wrong binary — it already had
   to refuse an Electron executable once), and a hook that depends on the ambient PATH of
   whatever spawned Codex is the kind of thing that works on one machine and not the next.
2. *8.3 short path* (`C:/PROGRA~1/nodejs/node.exe`). Measured working, but short-name generation
   can be disabled per-volume on NTFS, so it is not something to rely on.

**Reversibility.** High — one line in `installCodex`.

**Not verified.** The POSIX branch. Michael and Kai are on Apple silicon and no macOS machine
was available this session; the command written there is the direct `<node> "<hook>" ...` form,
and the installer refuses to write it if the node path contains a space rather than emitting
something that would fail the way the Windows form did.

---

## D-003 — Public repository, proprietary licence

**2026-09-18**

**Decision.** `AndrewDoft/zevet` is public, under a `LICENSE` that grants no rights to anyone.

**Why it came up.** GitHub Actions was billing-blocked at the account level, and that is the
only way to build a macOS `.dmg` — `electron-builder` requires a Mac, and there is none here.
Actions minutes are free for public repositories. Andrew chose this over clearing the billing.

**Before publishing.** All 22 commits were scanned: no `.env`, no keys, no credentials, and the
live hub token absent. The only token-shaped strings are the secret-scrubbing test fixtures,
including AWS's own documentation placeholder.

**What publishing costs.** The README names the hub endpoint, so it is now an advertised target
rather than an obscure one. It is token-gated with rate limiting on the failure path, and the
token is not in the repo — but the source of both hub and client is now readable by anyone
looking for a weakness in that check.

**On the licence.** The most restrictive form is "all rights reserved, no permission granted",
which is what the file says. One honest limit is written into it: GitHub's Terms of Service
permit any user to view and fork a public repo, and a licence cannot override the terms under
which the host serves it. The file states that rather than claiming a restriction it cannot
enforce, and confines the permission to GitHub itself.

**Reversibility.** Moderate. The repo can be made private again in one command, but anything
already cloned or forked stays cloned. Going private again also re-blocks the builds.

---

## D-004 — zevet records Codex hook trust for its own hooks

**2026-09-18**

**Decision.** `install.mjs` asks Codex for its hooks (`app-server` → `hooks/list`) and writes
`hooks.state.'<key>'.trusted_hash` for the entries carrying zevet's marker.

**Why it came up.** Codex will not run an untrusted hook and does not say so — the turn simply
completes with the hooks skipped. Without this, every teammate's install looks broken, and the
only alternative was telling them to pass `--dangerously-bypass-hook-trust` on every run, which
disables the check globally and forever rather than for one known hook.

**Alternatives.**

1. *Tell the user to run `codex` once and accept the TUI review.* The designed path, and still
   printed if this fails. Rejected as the default because it could not be verified from here at
   all, and an instruction nobody has watched work is not something to build onboarding on.
2. *Ship `--dangerously-bypass-hook-trust` in the docs.* Strictly worse: it trusts everything,
   every time, including hooks zevet did not write.

**Why this is defensible.** The control protects against a config file you did not write running
commands. Here zevet writes the hook and records trust for that same hook, in one action, for a
user who just ran the installer — anyone who can run `install.mjs` can already run code as that
user. Entries without the marker are left untrusted and keep their review.

**The hash is never computed.** It is read from Codex and recorded verbatim. Inventing a hash
would be exactly the fabrication §4 exists to prevent, and an entry Codex gives no hash for is
skipped rather than guessed at.

**Reversibility.** High. `uninstall.mjs` strips the trust block, and the whole feature is one
managed block plus one call.

---

## D-005 — zevet becomes a multiplayer IDE, and the hub is not trusted with the code

**2026-09-18**

**Decision.** zevet gains a collaborative editor. The board's file pane becomes CodeMirror 6
bound to a Yjs document; edits are relayed between machines by the hub over a WebSocket; the
relayed bytes are encrypted with a key the hub is never given.

This **reverses** what `README.md` has said since the beginning — "it deliberately does not do
real-time shared editing — that is a solved problem and not worth rebuilding", followed by a
recommendation to use Zed. That paragraph was not wrong when it was written. It is being
overruled by Andrew (2026-09-18): *"if Zevet is not a multiplayer IDE, then it needs to become
one"*, and the product page at usemasora.com/zevet now says "Multiplayer IDE" above the
download links.

**Why it came up.** The old position composed two tools: Zed for the shared buffer, zevet for
the agents. That works, and it asks a team to run two things and hold the relationship between
them in their heads. The thing zevet uniquely knows — which file whose agent is editing, right
now — is most useful in the buffer where the editing is happening, not in a panel beside it.

**Alternatives.**

1. *Keep recommending Zed.* Free, mature, cross-platform, and still a perfectly good answer for
   the shared buffer alone. Rejected because it cannot show an agent's edit arriving in the file
   you are reading, which is the only thing zevet has that Zed does not.
2. *Relay plaintext.* Much simpler: no key derivation, no migration, no `doc-crypto.mjs`. It
   would have made the line on the product page — *the board sees which file was touched, never
   what is in it* — false on the day the editor shipped, and the one deployed hub is a box in
   Google Cloud that would then hold everybody's source. Rejected on 2026-09-18 with the page
   already published.
3. *Peer-to-peer over WebRTC, hub as signalling only.* The strongest privacy story: the code
   never reaches the hub at all. Rejected for now on cost, not on merit — it needs STUN and, on
   real networks, a TURN relay, which is another service to run and pay for, and it makes
   offline and late-joiner sync materially harder. Worth revisiting.
4. *A dependency for the WebSocket (`ws`).* Rejected to keep `hub/server.mjs` at zero
   dependencies; the hub deploys by `git pull && docker restart` with no install step, and its
   own header calls that policy out. RFC 6455 server-side is ~250 lines and is now written and
   tested against split buffers, interleaved control frames and all three length encodings.

**The shape of the secret, and what it costs.** Teammates share one master secret `S`. The hub
is given `SHA-256("zevet-auth" || S)`; the document key is `HKDF(S)`. The hub can check the
token it holds and can do nothing else with it. The cost is a coordinated cutover — set the
hub's `ZEVET_TOKEN` to the derived value, restart, re-run setup on every machine — and there is
deliberately **no window in which the hub accepts both**, because a hub that also accepted `S`
would by definition be holding it.

**What this does NOT protect against, stated because an oversold security property is worse than
an absent one.** The board window loads its HTML *from the hub*. A hub that has been taken over
does not need the key; it ships JavaScript into the window that already has one. The encryption
defends against a hub that is honest but curious, against whoever can read its memory or disk,
and against anyone who ends up with its logs. The real fix is to serve the editor from the
desktop app's own files rather than from the hub, and **it has not been made**.

**Reversibility.** Medium, and asymmetric. The editor is additive — the board degrades to the
read-only viewer it was if `zevetDoc` or the bundle is absent, and that path is still exercised
by every plain browser tab. The auth migration is the part that does not reverse cleanly: once
the hub's env holds a derived token, every legacy install is locked out until it re-runs setup.

**Cost.** A committed 834 KB bundle in a repo that was proudly dependency-free, and the first
build step it has ever had. `hub/public/editor.js` is rebuilt by `npm run build` in `editor/`
and must be rebuilt and re-committed whenever that source changes — there is no CI check that it
is in step, which is a real gap and the most likely way this rots.

---

## D-006 — the desktop app updates itself, from the download host, and not with electron-updater

**2026-09-18**

**Decision.** zevet checks a JSON feed on the public download host, downloads a newer installer
in the background, verifies its length and sha256, and offers a one-click restart. On Windows it
runs the NSIS installer with `/S` and exits. On macOS it opens the disk image and the person
drags the app across, as they did the first time. `desktop/app-update.js` is the whole thing;
`scripts/make-feed.mjs` generates the feed from the artifacts.

Asked for by Andrew (2026-09-18): *"every machine should auto-update when you release a new
version. to find bugs and test this, build the last leg of zevet inside of zevet."*

**Why not electron-updater**, which is the obvious answer and was the first one tried on paper.
On macOS it cannot work here: Squirrel.Mac verifies the code signature of the replacement bundle
before swapping it in, and zevet is unsigned — a standing decision, because signing means an
Apple Developer account at 99 USD/year (see `.github/workflows/build.yml`). So electron-updater
would have auto-updated the Windows machine and silently done nothing on both Macs, while
everyone believed they were current. That is worse than no updater. The rejected alternatives,
for the record:

1. *electron-updater with a macOS carve-out.* A dependency with a large transitive tree, used
   for one of three platforms, plus hand-written code for the other two anyway.
2. *Buy the Apple account and sign.* Not rejected on merit — it is the right end state, and it
   would also remove the Gatekeeper warning that makes first-run look broken. Rejected for now
   as a purchase, not a code decision.
3. *Serve updates from the team's hub*, as `client/updater.mjs` does for the hook client.
   Rejected because it would put a 90 MB installer on every team's own box, and because a
   machine with zevet installed but no hub configured would then never update.

**⚠️ What the published sha256 does and does not buy.** It comes from the same origin as the
file. It catches a truncated download, a corrupted object and a proxy that mangled bytes. It
does **not** make a compromised download host safe: whoever can replace the `.exe` can replace
the number beside it. Written down because the check *looks* like a security control and it is
easy to start believing it is one. What actually stands between a user and a hostile installer
is HTTPS to a host Andrew controls, plus the fact that installing is a deliberate click. Code
signing is the thing that would fix it, and has not been bought.

**Deliberately not automatic: the install.** The download is automatic — by the time anyone is
told, the bytes are on the disk and the click has no wait. *Running* an unsigned installer
without being asked is a different act, and one this app should not perform on somebody's
machine while they are in the middle of something.

**Verified in the running app**, not only in tests: a fake feed advertising 9.9.9 was served on
localhost, the real Electron app found it on its own timer, streamed 3 MB, verified the
checksum byte-for-byte, left no `.part` behind, and the rail offered "Restart to install".
A second instance pointed at the same feed correctly declined to download the file again.

**Reversibility.** High. The feature is inert without a published feed — a 404 is treated as
"nothing to report", which is also the state of the download host today. Deleting
`zevet-latest.json` turns it off for every machine at once.

---

## D-007 — GitHub sign-in replaces the shared secret, and the hub is now trusted with the key

**Date.** 2026-09-19.

**Decision.** A person joins a hub by signing in with GitHub. The hub verifies them against
its own list, mints a session, and **hands them the master secret**, from which the document
key is derived. The 48-character secret people used to paste is still accepted — hooks are
headless and the installs in the field present it — but it is no longer how a human arrives.

**This reverses the central property of D-005.** D-005 says, in its own words, that the hub is
not trusted with the code: the hub held `SHA-256("zevet-auth"||S)` and never `S`, so it could
relay ciphertext it could not open. That is over. The hub holds `S`. An operator, anyone who
reads the box's disk or memory, and anyone who ends up with a backup of `/srv/zevet/var/` can
now decrypt document traffic.

**Why.** Andrew, 2026-09-19: *"idk what this master secret thing means, but people should be
able to use the app without having to enter some long code."* And, when shown the alternative
below and having picked it: *"just do whatever is simplest and easiest. no use friction at all.
something that can be solved by the user just signing into github."*

⚠️ **The note contradicted the button, and the note won.** He selected the device-approval
design and then wrote the sentence above it. The two cannot both be satisfied — approval means
waiting for a teammate — and the written requirement was the more specific of the two. This is
recorded because it is the kind of decision that gets re-litigated later by someone reading
only the click.

**What was not built, and is still the right answer if this trade ever reads worse.** The
joiner generates an X25519 keypair; an already-trusted teammate seals `S` to it; the hub relays
two blobs it cannot open. Nothing is typed by anybody. The cost is one approval click and a
joiner who waits if nobody is online — which, for a hub with one owner and two teammates, may
be minutes or may be overnight. It is perhaps a day's work on top of what exists: the session,
the allowlist and the relay are all already here.

**How much was actually given up.** Less than the reversal sounds, and more than nothing. The
board's JavaScript is served *by* the hub into a window that already holds the key, so a hub
that had been **taken over** could always take plaintext — D-005 says so itself. What is lost
is the defence against a hub that is merely **watched**: honest-but-curious operators, disk
images, log copies, backups. That was a real property and it is gone.

**Every place that claimed it has been changed, not softened.**
`client/secret.mjs`'s header, `usemasora.com/zevet`'s third feature (which had already been
rewritten once for the same reason — a claim outliving the code it described), and this file.
The landing page's claim is retired rather than reworded, because no wording of "the hub cannot
read one" is true any more.

**Trust on first use.** An unclaimed hub admits the first GitHub sign-in and makes that person
the owner. The window is the minutes between deploying a hub and signing into it, and
`ZEVET_GITHUB_OWNER` closes it for anybody who would rather not have one. Rejected: a hardcoded
login, which puts one person's name in a release; and a required env var, which locks everyone
out of a box behind IAP if it is wrong.

**Revocation is partial, and saying so is part of the decision.** Removing somebody kills their
session immediately, and `resolveAuth` prefers a session precisely so that this bites. It does
not un-know the master secret they already have on disk, and that secret derives the shared
token. Real revocation is rotating `S`, which re-keys every document and makes everyone sign in
again. Nothing in the UI implies otherwise.

**Device flow, not the web flow.** The web flow needs a client secret to exchange the code, and
a desktop app cannot hold one. Device flow needs no secret at all, which is why GitHub's own
CLI uses it. The hub proxies it rather than the app calling GitHub directly, so that the client
id lives in one place, the allowlist is enforced somewhere the user cannot edit, and an app
that lied about who it was would be lying to a hub that asked GitHub itself.

**Scope requested: `read:user`, and nothing else.** A login and a numeric id. Not `repo` — which
would be read-write access to every private repository the person can see, requested from
people who only wanted to sign in. The original ask that started this (*"a way to edit the
github repos it can access... that might mean we need to build in github oauth"*) was about
browsing repositories, and that still is not built; the day it is, it is one string and a
re-authorisation prompt, asked at the moment it is needed rather than years early.

**Reversibility.** High, per install and per hub. Leave `ZEVET_GITHUB_CLIENT_ID` unset and the
hub has no sign-in and behaves exactly as it did before — `hub/var/` is not even created.
Pasting a master secret in setup still works and overwrites a session. What is NOT reversible
is the hub having held `S`: once it has been on that disk, it has been on that disk.

---

## D-008 — OpenCode is watched through a per-repo plugin, and stays unverified until it fires live

**2026-09-19**

**Decision.** `client/install-opencode.mjs` copies one self-contained plugin
(`client/opencode-plugin.mjs`, node builtins only) into
`<repo>/.opencode/plugins/zevet.js`, which opencode auto-loads. The per-repo
file is the opt-in. `detect.mjs` reports `hooks: "unverified"` until a real
turn is observed on a hub (see `docs/contracts/opencode-hooks.md` §7).

**Why it came up.** The board only showed Claude Code and Codex. OpenRouter
models run inside opencode sessions, so one opencode plugin covers every
OpenRouter model with no provider-specific reporting code.

**Alternatives.**

1. *A global plugin in `~/.config/opencode/plugins/`.* One install would cover
   every repo — and publish every unrelated project to a shared hub. The D-001
   failure in a new box. Rejected.
2. *Shell hooks in opencode.json.* Does not exist as a surface; opencode's
   only hook mechanism is plugins. There is nothing to write a command into.
3. *Driving opencode from the desktop console too.* Deferred, not rejected:
   `opencode run` takes the prompt as argv and zevet never puts prompts on
   argv, and its stdin behaviour is unmeasured. Watching and driving are
   separable; this change ships watching.

**Reversibility.** High. Delete the plugin file per repo (`install.mjs
--remove` does it; `uninstall.mjs` does it everywhere) and opencode is
unwatched. Nothing is written outside the wired repo — no global config, no
trust records.

---

## D-009 — zevet ships its own MCP server, so an agent can see the screen, and every action is gated on a person

**Status.** Built, off by default, per repo.

**What it is.** `desktop/zevet-mcp.js` is a stdio MCP server that zevet hands
to claude with `--mcp-config` (a real flag, measured on 2.1.278). It exposes
`screenshot`, `click`, `type_text` and `press_key`, implemented by
`desktop/computer.js` through PowerShell on Windows and `osascript` on macOS.
Linux is refused rather than guessed at: no screenshot tool is reliably
present across distributions and display servers, and picking one that is
usually absent is a capability that silently does nothing.

zevet also passes `--permission-prompt-tool`, so claude asks THAT server before
any tool it would otherwise prompt about — not only the four above.

**Why it came up.** Andrew asked for computer use by name. It had been refused
twice, on the honest grounds that none of the three CLIs does computer use and
the element needs a screenshot and click coordinates on it. That reasoning was
about the agents. It stopped being true the moment zevet could BE the provider:
the CLI does not need the capability if the thing spawning it supplies one.

**The guard, which is the actual design.** In order, because any one of them
failing open would be enough to lose somebody's desktop:

1. **Off by default, per repo, by explicit choice.** `agentSettingsFor`
   defaults `computerUse` to false, and every unreadable file, missing key and
   hand-mangled value resolves there too.
2. **The server acts on nothing without a permit.** Every tool call POSTs to a
   loopback server first and obeys the answer. With no `ZEVET_MCP_URL` /
   `ZEVET_MCP_TOKEN` in its environment it refuses everything — a stray copy of
   that file is not a remote control for anybody's machine.
3. **The loopback server is loopback.** Bound to 127.0.0.1, a per-run bearer
   token, `Origin`/`Host` checked, and **it denies on timeout**. A question
   nobody answers is a no.
4. **A person answers.** The request becomes a card in the board and the agent
   blocks on it, which is what `--permission-prompt-tool` buys.

**Alternatives.**

1. *A native input module (robotjs / nut.js).* Faster and cross-platform, and
   it puts a compiled binary in the installer for both platforms. The whole
   capability is a few hundred bytes of PowerShell; a native dependency is a
   build, signing and update problem for the rest of the app's life. Rejected.
2. *Driving only zevet's own window with `webContents.sendInputEvent`.* Safe,
   and useless: the point is the machine, not the app.
3. *No permission gate, relying on the posture.* The posture is chosen once, at
   launch, for the whole run. "Allowed to edit files" and "allowed to click
   anything on my screen" are not the same grant and must not be one choice.

**What is deliberately NOT built.** No standing grants — nothing records "always
allow", so every action is asked. That is a real cost in a long run, and it is
the right cost: the alternative is a checkbox that hands over the machine.

**Reversibility.** High. The switch is one boolean per repo; turning it off
means no MCP config is written and the agent is spawned exactly as before.
Deleting `zevet-mcp.js` disables it everywhere, and nothing else in the app
requires it.

---

## D-010 — the Masora device token is protected with `safeStorage`, a new dependency-free path, not a new keychain library

**Decision.** T5 (docs/contracts/cross_app_context.md C1/C4): zevet has no
keychain helper of its own — grepped this session, no `keytar`, no
`safeStorage` anywhere before `desktop/masora.js`. `~/.zevet/config.json`'s
own master secret is plaintext-on-disk-with-0600-permissions (`writeConfig`,
main.js), which is a real, already-accepted posture for a shared team secret,
but the Masora token is a personal, workspace-scoped bearer credential and
warrants more. Electron's `safeStorage` (DPAPI on Windows, Keychain on macOS)
needed no new dependency and satisfies zevet's Windows/macOS parity rule for
free. `encrypt`/`decrypt` are injected into `masora.js`'s functions rather
than required at the module's top, so the module — and its whole test file,
`test/masora.test.mjs` — loads and runs under plain `node --test` with no
Electron app running; only `main.js` passes the real `safeStorage`.

**Alternatives.** A new dependency (`keytar`, deprecated upstream; `node-keytar`
forks) — rejected, `safeStorage` already does the job. Store it the way
`config.json` stores the hub secret (plaintext, 0600) — rejected: that secret
is shared team-wide by design (D-007's whole argument is "the hub is now
trusted with it"); a Masora device token is not shared and losing it grants
read access to one person's workspace.

**Reversibility.** Medium. A token already encrypted under one OS's
`safeStorage` cannot be decrypted after a migration to a different keychain
scheme without re-pairing; `loadToken` treats that as "not paired" rather
than throwing (see `masora.test.mjs`: "loadToken fails closed").

## D-011 — the C2 brief at agent start only fires when a prompt is already known

**Decision.** C4 names `local:startAgent` as the call site for the "Context
from Masora" brief. But `local:startAgent`'s own IPC payload has never carried
the user's first prompt — `board.ts`'s `startAgent` action sends `{model,
mode, forkFrom?}` only, and a queued first message (`launch.prompt`, a fork's
follow-up question) is sent AFTER the spawn succeeds, over the separate
`local:sendToAgent` channel, once the console exists. So for an ordinary
interactive session — nobody has typed anything yet when the process starts —
there is no prompt to send Masora and nothing to match a brief against. Rather
than call C2 with an empty string (which would either mismatch the contract's
intent or return `tier: none` every time for no reason), `board.ts` now also
forwards `launch.prompt` when the caller already has one (a fork's queued
question), and `local:startAgent` fetches a brief only then. An ordinary new
session gets no brief at start; it is not asked to have one.

**Alternatives.** Fetch the brief on the FIRST `local:sendToAgent` call
instead, keyed off the console id (rejected: C4 literally names
`local:startAgent`, and moving it would mean threading the brief into a
follow-up append-system-prompt after the CLI has already started, which
`agent-console.js`'s invocation shape does not support once a process is
running). Send an empty prompt always (rejected: cheapens the contract's
`prompt` field into a value that is never meaningfully populated for the
common case).

**Reversibility.** High. Moving the fetch to `local:sendToAgent`'s first call
is a contained change to two files (`board.ts`, `main.js`) if C4 is ever
revised to expect it there instead.

## D-012 — session push is synchronous-per-cycle and outbox-durable, not queued through zevet's own hub

**Decision.** `client/hook.mjs`'s existing outbox (`~/.zevet/outbox.jsonl`,
store-and-forward to the hub's `/ingest`) was the obvious thing to point at
Masora instead — the seams investigation (`zevet_seams.md` §D.3) flagged it as
the smaller lift. Not reused: its auth is the shared-secret `x-zevet-token`,
which has no workspace mapping, and repointing it would mean the hub's own
ingest traffic and Masora's now share one outbox format and one failure mode.
`desktop/masora-push.js` is a second, small, independent outbox
(`~/.zevet/masora-outbox.jsonl`) instead — append before any network call,
remove a line only once Masora has 202'd the batch it rode in on, cursor
(`~/.zevet/masora-cursor.json`) keyed on each session's `updated` timestamp so
an unchanged session is never re-read, let alone re-sent. A five-minute
`setInterval` (`startMasoraPush`, main.js) drives it, mirroring
`startScheduler`'s own pattern exactly.

**Alternatives.** Reuse `client/hook.mjs`'s outbox (rejected, above). Push on
every file save / every agent turn instead of on a timer (rejected: a session
is one document per C1, and re-sending on every turn would mean re-deriving
`git remote` and re-reading the whole transcript file on every message —
the timer already only sends what actually changed).

**Reversibility.** High. The outbox and cursor are their own files;
deleting them starts push from a clean slate.

## D-013 — opencode's plugin install moved from per-repo to global + an opt-in list

**2026-09-23**

**Decision.** `client/install.mjs`'s opencode step now calls
`installOpencodeGlobal()` (writes `~/.config/opencode/plugins/zevet.js`,
opencode's own documented global plugin directory — VERIFIED against
`opencode.ai/docs/plugins` and confirmed on a real machine, which already had
an empty one) instead of only `installOpencode(repo, ...)`. It also removes
any older per-repo copy for the repo being installed (it would otherwise
double-report every session there). A repo is watched only once it is
recorded in a new `~/.zevet/opencode-repos.json`, written by `install.mjs`
and read inline by the self-contained plugin — the exact shape of
`codex-repos.json` (D-001), for the exact same reason: a global surface
(opencode's plugin dir, Codex's hook config) reports every repo on the
machine unless something tells it not to, and installing zevet into one repo
must never publish an unrelated private one to a hub the whole team can read.

**Why it came up.** `docs/contracts/opencode-hooks.md` §1 had already noted
the global directory exists and explicitly chose not to use it, citing D-001
— at the time, the per-repo file itself was treated as sufficient opt-in.
That stopped being true the moment zevet started launching its OWN opencode
agents (`desktop/agent-console.js`): those run in whatever worktree the board
gives them, which is never the repo `zevet install` was run in, so the
per-repo file was never there and the session was invisible on the board.
Observed directly this session in a fresh worktree.

**Alternatives.**

1. *Auto-install the per-repo plugin from `agent-console.js` before every
   opencode launch* (what the task brief offered as the fallback). Rejected:
   opencode already supports a global directory, so this would be maintaining
   the weaker mechanism when the strong one exists — and it would still leave
   any opencode session a person starts by hand (not through zevet) in a
   worktree uncovered.
2. *Global plugin, no allowlist* (the simplest reading of "any opencode
   session on this machine"). Rejected outright: this is D-001's exact
   failure, just for a different agent — it would report a person's unrelated
   private repos the moment zevet was installed anywhere.

**Reversibility.** High. `opencode-repos.json` and the global plugin file are
each one file; deleting both and going back to `installOpencode(repo, ...)`
alone restores the old per-repo-only behaviour. A repo that still carries an
old per-repo copy (nobody has re-run `zevet install` in it since this change)
is a known, bounded gap — see docs/KNOWN-FAILURES.md.

**Cost.** Every machine that had already run `zevet install` for opencode
needs to run it again once for the global copy + opt-in entry to exist;
until then, that repo's opencode sessions are invisible exactly as they were
before this change (not worse — the per-repo file, if still present, keeps
working on its own until the next install swaps it out).

---

## D-014 — a created team gets its own accounts and its own activity board, not yet its own document rooms

**2026-09-23**

**Decision.** `hub/server.mjs` gained a team registry: `POST /team/create`
mints a random 10-hex slug, a fresh `Accounts` instance (own master secret,
own ownership, own allowlist — reusing the exact trust-on-first-use path an
unclaimed default hub already has) and a fresh activity board (own event
ring buffer, own `.jsonl` log, own SSE listener set). `/auth/github/*` and
`/auth/google/*` accept an optional `team` in the request, defaulting to
`"default"` — every install in the field today, which never sends one — and
`resolveTeam()` resolves ANY authenticated call (`/ingest`, `/api/state`,
`/events`, `/auth/whoami`, `/auth/allow`, `/auth/revoke`, `/auth/logout`) to
the team the CALLER'S OWN token belongs to, so a second team's activity feed
is isolated from the first's without the client naming a team on every call.

Deliberately NOT scoped: the WebSocket document rooms (`rooms`, `joinRoom`,
`handleControlMessage`). A room name is client-chosen and already opaque to
the hub (`MAX_ROOM_NAME`, no parsing) — two teams choosing the same room name
would relay to each other. See INSUF-008.

**Why it came up.** Andrew: "it doesn't allow him to create a new hub only to
join one" (Trevor, onboarding zevet 0.2.56 fresh). The setup window had no
path to a hub for a first-run person with nobody to invite them, which is
also most of why the sign-in buttons looked broken (a).

**Alternatives.**

1. *Full tenant isolation, rooms included, this session.* Rejected for time
   and risk: `rooms`/`wsClients`/the WS framing code are a large, carefully
   invariant-commented subsystem (test/hub-ws.test.mjs alone is 48 tests), and
   scoping it under the same P0 session as the sign-in and updater fixes risked
   shipping a half-verified change to the part of the hub that is hardest to
   get wrong quietly — a room that leaks is a data leak, not a broken button.
2. *No team feature this session, only fix (a)/(c)/(d).* Rejected: Andrew's
   own words treat "create a team" as a genuine bug, not a nice-to-have, and
   the hub-side trust-on-first-use mechanism already made the auth half of
   this cheap and low-risk to build properly — punting the whole thing would
   have been the lazier, not the more honest, choice.
3. *Fake it — same board, cosmetic team switch.* Rejected outright: a "team"
   that shares another team's activity feed is not a team, and shipping that
   under the label "isolated" is exactly what CLAUDE.md's tone (and this
   repo's own INSUF-NNN convention) exists to prevent even without a formal
   §0 in this file's own governance.

**Reversibility.** High for the account/board half: `/team/create` and the
`team` parameter are additive — deleting them returns every route to reading
the bare `accounts`/`TOKEN`/default board exactly as before. Extending
isolation to rooms is a separate, additive change on top (prefix or namespace
the room key by team at `joinRoom`), not a rework of what shipped here.

**Cost.** A hub operator who wants real multi-team hosting today gets
isolated credentials and an isolated activity feed, but a room-name collision
between two teams (accidental or deliberate) still relays traffic between
them. Practically low-severity while a hub hosts a handful of teams whose
document-room names are drawn from real repo/branch state, not an attacker
picking a name on purpose — but it is not a security boundary, and is not
described as one anywhere in the desktop UI.

**CLOSED 2026-09-23 — see INSUF-008.** Rooms are now scoped by team too:
`joinRoom(conn, roomKey(conn.team, room))`, `conn.team` fixed once at the WS
upgrade from `resolveTeam(tokenFrom(req, url))`. The "not yet" in this
decision's title is now just "not": every route D-014 isolated, plus the one
it named as still open, is isolated. Room-name collisions across teams no
longer relay.

---

## D-015 — unclaimed teams expire on a timer, not through an admin UI

**2026-09-23**

**Decision.** The hosted hub had one team created by a test `POST
/team/create`: unclaimed, no owner, nobody coming back to claim it, sitting
in `teamAccounts` forever because nothing ever removes a team once minted.
Rather than build an owner-only or super-admin surface (new auth concept —
this hub has no notion of "admin" above a team's own owner, and an unclaimed
team has no owner to authorize the deletion in the first place) to list and
delete these by hand, `hub/accounts.mjs`'s `Accounts` gained a `createdAt`
stamp (same one-time-fill-and-save idiom as its master secret) and
`hub/server.mjs` gained `sweepUnclaimedTeams()`: any non-default team with no
owner, older than `ZEVET_TEAM_EXPIRY_MS` (24h default), is deleted —
in-memory registry entry, board, and both on-disk files
(`accounts-<slug>.json`, `events-<slug>.jsonl`). Runs lazily before every
`/team/create` (mirrors the existing `sweepGooglePairs` pattern) and hourly on
a timer, so both a create-heavy and a quiet hub stay clean.

**Alternatives.**

1. *A manual `GET`/`DELETE` admin route, gated on... something.* Rejected:
   there is no existing "hub admin" identity to gate it on that isn't itself
   new surface, and the task this decision answers explicitly named automatic
   expiry as the smallest honest option if it fit `hub/accounts.mjs`'s shape.
   It does.
2. *Expire on next boot only (scan `TEAMS_DIR` at startup).* Rejected: teams
   are not currently reloaded from disk at boot at all (`teamAccounts` starts
   with only the default team, and a created team is unreachable again after
   a restart regardless of this change) — building that reload path just to
   hang expiry off it would be strictly more code than the sweep this shipped
   with, for a hub that in practice restarts rarely.

**Reversibility.** High. `ZEVET_TEAM_EXPIRY_MS` set enormous (or the sweep
calls removed) returns every created team to living forever, exactly as
before. The `createdAt` field is additive and ignored by every other code
path.

**Cost.** A team created and never claimed within 24 hours is gone, including
any `/ingest` activity that was posted to it via its shared token without
anyone ever signing in — accepted, since that is precisely the orphan state
this closes, and any real onboarding flow claims a team (signs in) within
minutes of creating it, not a day later.

---

## D-016 — macOS voice detection checks three bundle names, read from Contents/MacOS, not one guessed executable

**2026-09-23**

**Decision.** `desktop/zevet-voice.js`'s `find()` only ever searched
`%LOCALAPPDATA%`/`%ProgramFiles%`, so the mic read "not installed" on every
Mac regardless of whether zevet Voice was there. Added a `darwin` branch that
searches `/Applications` and `~/Applications` for the bundle under its
current name and the two it shipped under before — read from zevet-voice's
own git history of `release/build_macos.sh` rather than guessed: `Masora
Voice.app` (first published build, `masora-voice-0.1.6-macos-arm64.dmg`,
2026-09-19) → `zevet Voice.app` → the current `zevet voice.app`. The bundle's
executable name is read out of `Contents/MacOS/` at runtime (`macExe()`)
rather than hard-coded per bundle name, because that name changed too
(`masora-voice` → `zevet voice`, the `macos_launcher.c` rename) and a bundle
only ever holds the one binary there.

**Alternatives.** Matching only the current bundle name was rejected for the
same reason the existing Windows `PRODUCTS` migration comment gives: the two
apps update independently, and reporting "not installed" to someone running
a Mac build from before the rename offers a download they do not need.

**Reversibility.** High — `MAC_APPS`/`macCandidates`/`macExe` are additive
and exported for testing; removing the `darwin` branch returns to the
pre-existing Windows-only behavior exactly.

**Cost/scope note.** This closes the readiness check only (`status().installed`,
which is what drives the Settings/composer "not installed" UI). `start()`
works unchanged on macOS once `find()` returns a real path (it already just
spawns whatever `find()` finds). `dictate()`'s "admin record" trigger is
Windows-only machinery (a named Win32 event; see the file's own header
comment) and was deliberately left alone — there is no verified macOS
equivalent to wire it to (masora_dictation's compiled launcher on macOS
always runs the app's `__main__`, never a `-m masora_dictation.admin`
sub-invocation), and building one would be exactly the kind of API invented
from memory CLAUDE.md-style projects ban. A macOS press of the mic against a
cold app therefore behaves like any other "not running yet" case: it raises
the app and asks for a second press, which is honest, not broken.

---

## D-017 — a CANCELLED test fails the gate by reading node's own summary, not by re-deriving pass/fail

**2026-09-23**

**Decision.** `node --test` already exits non-zero when a test is cancelled
in the Node version this repo currently runs (verified: a top-level `before()`
throw inside a `describe()` block reproduces "cancelled", not "fail", and the
process still exits 1) — but nothing printed that fact in a way a person
skimming a log would catch, and exit-code semantics for "cancelled" are not
something this repo controls or should trust to hold across a Node upgrade.
`scripts/run-tests.mjs` reads the `ℹ cancelled N` line node's own summary
already prints and fails loudly and explicitly on `N > 0`, independent of
node's exit code. `npm test`, `scripts/gate.sh` and the CI `Test` step all now
go through it.

**Alternatives.** Relying on node's current exit-code behavior alone was
rejected: it is unverified across the Node versions this repo's `engines`
field allows (`>=20`) and across whatever CI happens to run, and CLAUDE.md's
own §9.11 is exactly the pattern of inferring a pipeline's state from what
should happen rather than reading what did. Parsing the full test-runner
output for `✖`/failure text was rejected as more fragile than reading the one
summary line node already computes for this purpose.

**Reversibility.** High — the wrapper is a thin layer around the same
`node --test` invocation; deleting it and pointing `npm test` back at the raw
command returns to the previous (less strict) behavior exactly.

---

## D-018 — team and personal model credentials, spawned by (provider, kind), plus an optional per-member Auto ladder

**2026-09-23**

**Decision.** An agent needs a model credential to run at all, and "everyone
pastes their own into their own shell" was never written down anywhere — it
was just how it happened to work. Two scopes now exist, chosen by where a
credential is safe to live:

- **Team credentials** live on the hub, in the SAME `Accounts` file S already
  lives in (`hub/accounts.mjs`'s `credentials: []`, plaintext in the 0600
  file — wrapping one more field under `secret` in that same file protects it
  against nothing that does not already have `secret`). `kind` MUST be
  `api_key`: a `subscription_token` (an OAuth sign-in credential, e.g.
  `sk-ant-oat…`) is refused at `/team/credentials`' POST, both by its
  declared `kind` and by sniffing the key's own prefix in case it was
  mislabelled — a Claude subscription is priced and administered per person,
  so sharing that credential would let a whole team spend against one
  person's plan under their own identity, silently. Any signed-in member may
  add one (`addedBy` records who); the owner or whoever added it may remove
  it; ANY authenticated member — including the shared token, deliberately,
  same reasoning `/ingest` already uses — may read the raw secret from its
  own dedicated `/team/credentials/:id/secret` route, because that is not
  actually a privilege boundary: the whole point of a team credential is that
  every member's agents run on it, on that member's own machine, so every
  member already has it in an environment variable regardless of whether the
  hub also hands it back.

- **Personal credentials** never leave the member's machine —
  `desktop/credentials.js`, `~/.zevet/credentials.json`, encrypted with
  `safeStorage` exactly like the Masora device token (D-010's own
  precedent, including the injected-`encrypt`/`decrypt` testing shape). Any
  `kind` is allowed here, INCLUDING `subscription_token` — a subscription is
  single-person by nature, which is exactly why it belongs on one person's
  own machine and nowhere a teammate could read it, rather than being
  disallowed outright.

Both scopes funnel into one small table, `CREDENTIAL_ENV` — `(provider,
kind) -> env var` (`anthropic:api_key -> ANTHROPIC_API_KEY`,
`anthropic:subscription_token -> CLAUDE_CODE_OAUTH_TOKEN`,
`openai:api_key -> OPENAI_API_KEY`) — DUPLICATED verbatim in
`hub/server.mjs` and `desktop/main.js` for the same reason `deriveAuthToken`
already is: the hub must not import out of `client/`, the one directory it
and the Electron app could otherwise both load from, and there is no other
shared module in this repo. An unknown combination is rejected at add time
rather than stored as something nothing will ever read. At spawn
(`desktop/agent-console.js`'s two spawn sites, both now forwarding a plain
`options.env`), every env var ANY table entry could set is deleted from the
child's environment first, THEN the chosen one is set — a stray
`ANTHROPIC_API_KEY` left over in the person's own shell must never silently
outrank the credential they just picked in Settings.

A member picks a spawn default (`~/.zevet/config.json`'s
`defaultCredential: {scope, id}`) or **Auto**: an ordered ladder
(`credentialLadder: [{credentialId, untilPct}]`, e.g. Andrew's own
`[engine1→50, engine2→80, engine1→99, engine2→100]`) walked at every spawn by
`desktop/credential-ladder.js`'s pure `choose(ladder, usageById)` — the first
rung whose credential's utilization is strictly below its own `untilPct`
wins; a rung with unknown usage (a failed probe) is skipped, not treated as
either empty or full; if nothing qualifies, the LAST rung is used regardless
of its own reading, because rotation has to land on something.
Utilization itself is `desktop/credential-usage.js`: `max(5h, 7d)` from a
1-token `POST /v1/messages` probe's own `anthropic-ratelimit-unified-{5h,7d}-utilization`
headers for a `subscription_token`; an `api_key` has no plan window at all,
so it reads `0` on a successful probe and `undefined` (skip this rung, not
"wide open") on a failed one. Each reading is cached ~60s per credential id
— the ladder is walked on every launch, and re-probing every rung on every
spawn would be one live request per rung per launch for no benefit.

**Alternatives.** One shared team key only (this decision's own first draft,
2026-09-23 same day) — rejected once it was clear a real team already runs
mixed credentials: someone's personal Claude Pro/Max plan alongside a
company Anthropic API key, sometimes several of each, and a single hub field
cannot represent that. A new keychain dependency for the personal store —
rejected same as D-010: `safeStorage` already does the job. Fetching
utilization on every ladder rung with no cache — rejected as one avoidable
network round trip to api.anthropic.com per rung per agent launch. A new
launch-time credential-override dialog — deliberately NOT built: the
existing launch surface has no options dialog to extend, and the per-member
default (plus Auto) covers the requirement without inventing UI nothing
asked for.

**Reversibility.** Medium. Team credentials are additive rows in a file
that already existed (`accounts.json`'s `credentials: []`), trivially
droppable. Personal credentials, like the Masora token, are
`safeStorage`-encrypted per OS keychain: unreadable after a keychain-scheme
migration with no re-pairing story beyond "add it again" —
`credentialKey()` fails closed (`null`, never a throw) exactly like
`masora.loadToken()` already does for the same reason.

## D-019 — Chat + Work: one mode, every provider, work by attaching a folder

Code | Chat + Work. The stored id stays `chat`, so old prefs load as Chat + Work.
A thread with a `folder` runs its provider's agent there with tools (claude:
`--tools ""` dropped; codex/opencode: the chosen posture); without one it stays
plain chat (claude tools off; codex `read-only`; opencode `plan`). Providers are
keyed by the agent-console.js agent (`claude`, `codex`, `opencode`) and reuse
`invocationFor`, so there is one launch stack. The board reads each CLI's own
JSONL with the agent it sent the turn to (transcript.mjs).

Measured 2026-09-24 and fixed on the way: codex `--approve-for-me` exits 2 beside
`--sandbox` (auto is now `--approve-for-me` alone); `codex exec resume` accepts
neither flag (posture goes through `-c sandbox_mode=`); opencode ignores the spawn
cwd when `$PWD` is set (`--dir`); a stored model came back with the default agent
(the agent now follows the picked model).

Not done: Gemini has no adapter (CLI absent here, event shape not measured), so it
is listed from the CLI's doc behind a Connect chip. Teammates' chats are not on
the hub, which carries prompts and tool calls only: a teammate opens read-only
from those. Tool activity is not stored in a chat file, so a reopened thread
shows text.

**Reversibility.** High: additive, one store field (`folder`) and one file.

## D-020 — Invites complete: email identities, a per-team Workspace toggle, installer pruning

Email invite is the existing "google"-tagged allowlist record (`accounts.mjs`'s
`allow()` already decided this by the "@"), extended two ways: a GitHub sign-in
whose GitHub-verified public email (the one `/user` gives on `read:user`, no
extra scope) matches an invited address is admitted and CLAIMS that row —
rewriting its provider/login to whoever actually signed in — same as a Google
sign-in already did. Without a public email GitHub still matches by login only;
that is the existing behaviour, now written down in github-auth.mjs.

Workspace-domain-per-team: `Accounts` gained `domain` (the active rule) and
`ownerHd` (captured off the owner's own sign-in). `setDomain` accepts only the
owner's own `hd`, or `""` — never an arbitrary string, because the whole point
is delegating to a domain Google has already vouched the owner administers, not
letting an owner grant entry to one they merely typed. `ZEVET_GOOGLE_DOMAIN`
stays exactly what it was — a hub-wide fallback for the default team — and a
team's own `domain` wins over it (`server.mjs`'s `domainFor`). New route
`/auth/domain`, owner-gated like `/auth/allow`; new relay action `team.domain`
in `family.js`, mirroring `team.invite`/`team.revoke`.

Delivery for an email invite: "Copy invite" (clipboard) and a `mailto:` link —
no mailer was added; the hub still has none. Board-only UI, so it works
identically whether opened from the app or a browser tab.

## D-021 — Per-invitee keys replace the shared secret as the default onboarding path, and the hub gets a mailer

Andrew (2026-09-27): the shared-secret "Key" field is "more complexity for
nothing"; every invite should mint its own key and Resend should email it,
with download links, alongside the existing GitHub/Google sign-in.

**The key is a second, parallel credential, not a replacement for
GitHub/Google.** `Accounts#allow()` now mints (or, on re-invite, rotates) an
8-character key (`XXXX-XXXX`, an unambiguous alphabet — no 0/O/1/I/L/2/Z) for
every still-pending invite, GitHub-login or email alike. Only its SHA-256 is
stored, on the SAME allowlist entry the invite already was — no new store, no
new file. `Accounts#redeem(key)` looks it up, checks the 14-day expiry,
deletes the hash (one-time use, even on the expired path), and calls
`signIn()` with a SYNTHETIC id (`key-<hex>`), which is exactly the code path a
real GitHub/Google claim already goes through. The consequence, stated once
rather than buried: a person who redeems a key and LATER also completes a
real GitHub/Google sign-in under the same login does not merge into the same
row — two different `id`s, two rows. Accepted rather than fixed, because it
is the same shape `signIn`'s own comment already flags for the cross-provider
email-claim case, and merging identities after the fact is a bigger feature
than this one asked for.

**New route `POST /team/join {team, key}`** mints a session and returns the
team's master secret exactly like `/auth/github|google/finish` — a key
redemption IS a sign-in, so the joiner's editor needs the same secret. Rate
limited through the existing `rateLimited`/`authFailed` counter, same as
every other credential-guessing surface in this file.

**Email via `hub/mailer.mjs`, plain `fetch`, no SDK** (contract in
`docs/resend.md`, fetched and dated this session). Never throws — a missing
`RESEND_API_KEY`, a 403 (sending domain not yet verified in Resend), or a
network failure all degrade to `{ok:false}`, and `/auth/allow` falls back to
handing the key to the INVITER instead of the invitee, never both. The invite
field stays ONE input: "login email" (two tokens) mails that address; a bare
email invites and mails itself; a bare GitHub login with neither looks up the
account's public profile email (`githubUser`'s own field, now also reachable
unauthenticated via `githubPublicEmail`) and falls back to no email at all —
the key is then only ever shown to the inviter.

**Onboarding (`desktop/setup.html`):** Join mode leads with Team + Key;
GitHub/Google are demoted to small (non-`.primary`) buttons in that mode only
— an allowlisted identity can still skip the key entirely. Create mode is
unchanged: there is no key yet to lead with, and first-sign-in-claims-the-team
still needs GitHub/Google. The old shared-secret `<details>` survives, relabelled
"Other" instead of "Key" and still collapsed by default, for installs that
still hold one — nothing about how it authenticates changed.

**Reversibility.** Medium: the key path is additive (a new hash+expiry pair on
an existing row, a new route), so turning it off is deleting the UI entry
points; but any invite emailed before a rollback holds a key that stops
redeeming, with no message to the invitee explaining why — a rollback should
ship alongside a re-invite of anyone with a key outstanding.

Installer pruning: `%APPDATA%/zevet-desktop/updates` accumulates one file per
version checked, forever. `AppUpdater#check()` now prunes to the file it still
needs — the freshly-verified download, or nothing once the running app is
confirmed current — after every check, keeping the `install-on-quit.json`
marker alive regardless (deleting it out from under `installOnQuit()` would let
a background check re-arm an install already attempted once).

**Investigated, not fixed:** the specific stray `zevet-9.9.9-windows-x64-setup.exe`
reported in the real `%APPDATA%/zevet-desktop/updates`. Every Electron-driving
test in this suite runs through `scripts/drive/drive.mjs`, which has isolated
`--user-data-dir`, `APPDATA` and `LOCALAPPDATA` since the commit that introduced
it (`e920159`) — no test file bypasses it. The pruning above cleans up whatever
is there regardless of how it arrived; the likelier source is a manual
`npm start` against a hub serving a placeholder "9.9.9" feed during dev, not the
automated suite.

**Reversibility.** High. Everything is additive: a new `Accounts` field with a
narrow setter, one new route, one new relay action, one new prune method called
from existing call sites.

## D-022 — A dead board load retries once, then names the host and the likely cause, instead of a bare "Offline"

Real incident (2026-09-27): Tommaso, a brand-new external user with no team
and no invite, reported "the hub couldn't be reached, none of it worked" on
Windows. `main.js`'s `did-fail-load` handler was firing `unreachablePage`,
which showed only "Offline" and a raw Chromium error code — no host, no
reason a non-technical person could act on.

Traced every OTHER path that can leave a fresh install stuck first, to avoid
fixing a symptom instead of the cause: `hub-target.js#resolveHub` always
falls back to the baked-in `HOSTED_HUB` for a truly fresh profile (no env, no
existing config), and its history (`a402531`) shows only one value it has
ever held, so a stale address is ruled out. A missing/invalid credential
already gets its own distinct page (`credentialPage`), and setup's own
create/join errors are already surfaced inline in `setup.html` — neither of
those routes through `unreachablePage`. That leaves exactly one path landing
here: a real network-level failure on the board's OWN load, after a working
credential was already established. Two changes for that path:

1. **One retry, 1.5s later, before saying anything.** A fresh network
   interface (Wi-Fi still associating, a VPN adapter still coming up) can
   lose the very first request without the hub being down at all — the same
   race a browser's own retry papers over. `code === -3` (a normal
   navigation abort) is still ignored, as before.
2. **`unreachablePage` now names the host** (parsed from `cfg.hub`, falling
   back to the raw string if unparseable) **and gives an actionable hint**
   (VPN/firewall/strict DNS) instead of only a Chromium error code — satisfies
   the brief's "never a generic message when the real cause is actionable."

**Not changed:** `credentialPage` and setup's own error surfacing — both
already name their specific cause and were never part of this bug.

**Reversibility.** High: the retry is a local `setTimeout`, no new state
persisted; the message change touches only rendered text.

**Verification:** `test/hub-unreachable.test.mjs` drives a real dead port
(`127.0.0.1:1`, refused everywhere) through `drive.mjs` and asserts the host
and an actionable hint appear — red against the pre-fix page (no host, no
hint), green after. `test/onboard-live.test.mjs` (workflow_dispatch,
`.github/workflows/onboard-live.yml`, windows-latest + macos-latest) drives
the exact fresh-install "Create a team" move against the real hosted hub,
since only that address can catch "stale" or "genuinely unreachable" — every
other test here talks to a disposable hub this suite spawns itself.

---

## D-023 — Muse Spark and Muse Code get the Gemini treatment, not a fabricated adapter

**2026-09-27**

**Decision.** Meta's Model API (Muse Spark) is added to the composer's model picker the same way
Gemini already is: listed, described, but with no execution adapter (`ok: false` always). Unlike
Gemini — which is always shown behind a permanent Connect chip — the Meta group is only added to
the Chat picker's `usable` list when a key is actually detected (`composercontrols.tsx`,
`meta?.signedIn`), because Andrew asked for it to "show only when usable" rather than as a
standing upsell. Muse Code (Meta's coding CLI) is added to `client/detect.mjs` for detection only
(installed / signed-in via `MODEL_API_KEY`, same "presence only" discipline every other entry
uses) with `hooks: false` — no `.muse/hooks.json` is written and no session/transcript file is
read.

**Alternatives considered.**
- *Build a direct HTTP adapter now* (Node's built-in `fetch` against
  `https://api.meta.ai/v1/chat/completions`, OpenAI-compatible shapes). Rejected for this pass:
  the exact streaming/tool-call JSON was not fetched field-by-field this session (only confirmed
  to exist, via docs nav and prose — see `docs/contracts/meta-model-api.md`), and CLAUDE.md-style
  discipline (never guess a wire format) applies just as much to a response schema as to a hook
  payload. INSUF-009 records this as the next step.
- *Wire Muse Code hooks from the documented event names alone.* Rejected: the event names and
  config LOCATIONS are documented, but the stdin PAYLOAD shape is not, and there is no `muse`
  install on this machine to verify it against — exactly the mistake `docs/contracts/
  codex-hooks.md` records having made once already (a repo-local hooks path that silently never
  fired) and is asked not to repeat by guessing.
- *Route Muse Spark through opencode's existing zen models instead of adding anything.* Already
  true and unaffected by this change (`muse-spark-1.2/1.3-contributor-free` already show under
  "Open models" once opencode is installed — no key needed) — but it does not give Andrew a place
  to save his OWN Meta key, which he explicitly asked for, so it is additive to this, not a
  replacement.

**Reversibility.** High. Every addition is either inert until consumed (the `meta:api_key` ->
`MODEL_API_KEY` credential-table entry; `client/detect.mjs`'s `muse-code` row) or purely
presentational (the picker group). Nothing here changes what any existing agent does.

**Verification.** `test/muse-model.test.mjs` (11 assertions, 2 mutation-checked live: the
Chat-only gating condition, and `client/detect.mjs`'s `hooks: false`), `test/detect.test.mjs`
(2 new cases), full suite green except pre-existing environment gaps unrelated to this change
(missing `desktop/build/icon.png` asset, Electron's binary failing to download in this sandbox —
both present before this change and unrelated to it). A headless Chromium screenshot
(`?dev=1` fixture mode, Chat + Work tab, model picker open, filtered to "muse") confirms the Meta
group renders with the correct name, icon, and disabled state; see the session's report for the
image.

---

## D-024 — The manual master-secret field is removed from setup.html, not merged

**2026-09-28**

**Decision.** Andrew, verbatim: "there are two spaces for the key, we only need the top ones."
`desktop/setup.html` had two key-shaped inputs: `#inviteKey` (the per-invite join key, always
visible in Join mode) and `#token` (the raw master secret, behind an "Other" disclosure, wired to
`zevet:test`/`zevet:save`). The second is deleted outright — the `<details id="manual">` block,
its `#check` handler, and every reference to `$("token")` in `signedIn()`/`finish` are gone.
GitHub sign-in, Google sign-in, and the invite key are the only three ways into a team from this
window now.

**Why it came up.** The two fields serve genuinely different mechanisms (a personal, revocable,
per-invitee key vs. an anonymous shared master secret for a hub with no OAuth app configured), so
a literal reading of "merge them" would need one input to parse two incompatible formats
(9-char `XXXX-XXXX` vs. a 48-char hex secret) behind one button — fragile, and not what was asked.
Andrew's instruction was to remove the second field, not reconcile it with the first.

**Alternatives considered.**
- *Keep both fields, reorder/relabel only.* Rejected: does not satisfy "we only need the top
  ones" — the complaint is about the field existing at all, not its position.
- *Merge into one field with format-sniffing (short code vs. long secret).* Rejected: two
  different `maxlength`/`type` constraints on one input is exactly the kind of clever-but-fragile
  code this project's own CLAUDE.md-equivalent discipline (ponytail: fewest files, boring over
  clever) argues against, for a capability that already has a non-UI path.
- *Remove the UI but keep `zevet:test`/`zevet:save`'s IPC surface wired.* Taken — no other file
  calls it from a still-live UI element, but ripping out main.js/preload.js plumbing that costs
  nothing to leave is a bigger diff for no behavior change.

**Reversibility.** Medium. A self-hosted hub with NEITHER GitHub nor Google configured (no
`ZEVET_GITHUB_CLIENT_ID`, no `ZEVET_GOOGLE_CLIENT_ID`) has no way to become the FIRST owner from
this window any more — `createTeam` already refuses `/team/create` with no provider configured
(hub/server.mjs), so this window was never the only gate for that case anyway. A brand-new
machine still connects headlessly via `ZEVET_TOKEN`/`ZEVET_SECRET` (client/secret.mjs,
doctor.mjs) — the setup WINDOW loses the capability, the product does not.

**Verification.** `test/board.test.mjs`'s "there is exactly one key field in the whole window"
and `test/setup-window.test.mjs`'s "there is no second key field" — both mutation-tested: adding
a synthetic second key-shaped input (or restoring `#token`/`#manual`/`#check`) turns them red;
restored to green after reverting the mutation. `test/setup-window.test.mjs`'s
"a completed sign-in enables Open and reveals Folder" replaces the removed
"the team-key path connects..." test, driving `window.signedIn()` directly (the same pattern this
file already used for `window.paintUpdate`) since no path in that file's single hub instance can
produce a REAL successful sign-in without a live GitHub/Google app or an owner session — the
real HTTP-level "does redeeming a key actually work" contract stays covered in
`test/team.test.mjs`'s `/team/join` describe block, unchanged.

## D-025 — One person, many identities: linked on VERIFIED email or a second OAuth sign-in, never on a typed address

**Decision.** A person record (the old allowlist row) may carry extra `identities`, each with the
emails that identity proved. Sign-in links a new identity to an existing person only on *verified*
evidence: GitHub's `GET /user/emails` rows with `verified: true` (needs the `user:email` scope,
now requested alongside `read:user` — docs.github.com/rest/users/emails), or Google's
`email_verified` id-token email. The GitHub public-profile email and an invite-key redemption's
typed address are not evidence. A signed-in person can add a second identity from Settings by
running that identity's own OAuth sign-in with `link: true` (session cookie required; no new
session, no secret handed out), and unlink any but their last. `combine` (owner only) covers what
evidence cannot prove ("andrew" + "@AndrewDoft"). `scripts/merge-people.mjs` merges stored
duplicates that evidence proves; dry-run by default, idempotent.

**Names.** Events name their actor as a string the machine reports. A person's display name,
linked logins and aliases resolve those strings at read time (`actorResolver`), so a rename or a
merge re-points events already in the log without rewriting `events.jsonl`. A rename may not take
a name another person or a hook-only teammate already wears on the board.

**Cost / reversibility.** Existing GitHub users are asked to approve one extra scope on their next
sign-in; a token without it just yields no email evidence (the call is best-effort). Records gain
optional fields only, so an older hub still reads the file. A merge is not undoable by the hub —
`--apply` writes a `.bak-<timestamp>` copy first.

## D-026 — Both update channels are Ed25519-signed with one pinned key; publisher checks are enforced only where the running app has a publisher

**Decided (Andrew, 2026-09-28).** Audit B3/B4: the desktop feed and the hub's client manifest took
their sha256 from the host that served the file, so host compromise was code execution on every
install. Now `zevet-latest.json` carries a signed `payload` (domain `"zevet-update-v1\n"`) and the hub's
`/dist/manifest.json` a signed `payload` (domain `"zevet-client-v1\n"`), both under key
`zevet-2026-09` (raw public key pinned in `desktop/update-signing.js` and `client/signing.mjs`).
Scheme is Zevet Voice's (`updates/signing.py`): domain bytes (including the trailing `\n`) + canonical
JSON. Legacy top-level fields stay so already-installed clients keep updating; new clients read only
the payload. Hubs must be https (loopback http excepted).

- **No fallback for unsigned.** The app rejects an unsigned feed outright. The client updater accepts
  one only with `ZEVET_ALLOW_UNSIGNED_MANIFEST=1`, and a test key only for a loopback hub/feed
  (`ZEVET_HUB_TRUSTED_KEY`, `ZEVET_APP_FEED_TRUSTED_KEY`) so tests never need the real key.
- **The hub holds no private key.** The client manifest is signed at release time
  (`scripts/sign-client-manifest.mjs` -> `hub/client-manifest.signed.json`); the hub attaches the
  signature only when it covers exactly the files on disk, else serves the unsigned manifest, which
  current clients reject (updates pause instead of shipping unsigned code). `release-check` fails while stale.
- **Publisher check** (Authenticode `CN=Andrew Doft` / Developer ID team `27C8FVB83B`) runs before an
  installer is offered. It is enforced when the RUNNING app carries that publisher and log-only otherwise,
  so unsigned dev builds and CI proofs still update. Alternative rejected: enforce always, which breaks
  every local build and the Codemagic unsigned proofs.
- **Bootstrap.** Clients that predate signing take the first signed update on trust of the old channel;
  only later updates are protected. Unavoidable without a flag day.

**Reversibility.** Key rotation: ship a build that pins both ids, then retire the old one. Backing out
signing entirely means restoring `readManifest(json, ...)` in `AppUpdater.check()` and the manifest read in
`client/updater.mjs`.

**Verification.** `test/update-signing.test.mjs` (real-key vector; CJS/ESM parity; domain separation),
`test/app-update.test.mjs` "a signed feed and a signed installer", `test/updater.test.mjs` "a signed
manifest", `test/hub-client-manifest.test.mjs`, `test/outbox.test.mjs` (plain-http hook). Each guard was
mutated (removed) and its test went red before restoring.

## D-027 — Shipped: Electron 44, signed update channels, and macOS in-place self-update (0.2.86)

**Decided (Andrew, 2026-09-28, "continue everything and finish it and deploy").** D-025's Electron
38.1.2 -> 44.4.5 / electron-builder 25.1.8 -> 26.17.0 bump and D-026's signed update channels merged
to `main` and released as zevet 0.2.86: signed Windows installer (`Get-AuthenticodeSignature` ->
`Valid`, `CN=Andrew Doft`), notarized macOS `.dmg` (`spctl` -> `source=Notarized Developer ID`,
ticket stapled), both proven on the real `build.yml` v-tag pipeline (Windows + macOS runners) rather
than an ad-hoc local build. The already-live 0.2.85 feed (an unrelated identity-linking release,
`f3dccbb`, that shipped from `main` while this branch was in flight) was re-signed in place first,
then the hub was redeployed with the signed client manifest, then 0.2.86 was cut — so an installed
app never saw a feed it would reject, and no app ever saw an unsigned hub manifest.

- **Real bug found by the macOS self-update proof, not by review.** `_macReplaceSteps`'s cleanup
  step (sweeping stray `zevet*.app` copies) chained every step with `&&`; a `for` loop's exit status
  is its last command's, and `[ -e "$f" ]` is false whenever there is nothing stray to sweep — the
  common case. That silently cancelled the `open` (relaunch) chained after it: the bundle swap to
  X+1 completed but "Restart now" never brought the app back. Fixed by ending the step with `; true`
  (`desktop/app-update.js`), reproduced and pinned with a real `/bin/sh -c` execution of the exact
  generated string (`test/app-update.test.mjs`, skipped on win32 — no `/bin/sh` there), and confirmed
  green on real Apple Silicon (Codemagic `macos-autoupdate`) both before (red, with diagnostics
  showing no relaunch) and after (green, `PASS`) the fix.
- **`scripts/make-feed.mjs`'s Authenticode check** inherited the same PSModulePath-poisons-a-nested-
  Windows-PowerShell trap `scripts/codemagic.mjs` already worked around, discovered while cutting
  this release from a pwsh shell: a validly signed `.exe` was refused as "looks corrupted" because
  the nested `powershell.exe` could not autoload `Get-AuthenticodeSignature`. Same fix (strip
  `PSModulePath` from the child's env) applied there too.

**Verification.** `node scripts/run-tests.mjs` (0 fail), `npm run typecheck`, board build reproduces
`hub/public` byte-for-byte. `ci.yml` green on the merge commit and on the 0.2.86 release commit.
Live feed and hub client manifest verified over HTTPS against the pinned key after each deploy step
(`desktop/app-update.js`'s `readSignedFeed`, `desktop/update-signing.js`'s `verifySigned`). Stable
download links (`/download/Zevet.dmg`, `/download/Zevet-Setup.exe`) confirmed by exact
`Content-Length` match, not just a 200. `usemasora.com/zevet` confirmed showing 0.2.86 after its
5-minute ISR window revalidated.

**Not done.** RELEASING.md's landing-page rebuild step (§5, "only when the page itself changes") was
not needed and not run — the page picked up the new version from the feed alone, as designed.

## D-028 — Shipped: @masora/desktop-kit v0.1.2 — updater core, safe-open, IPC guard, family module (0.2.88)

**Decided (Andrew, 2026-09-29, "release Zevet 0.2.88").** The 11 commits since v0.2.87 (`d28b7e5`..`5bf2536`)
moved the desktop app's updater core, signed-feed verify, single-instance lock, safe-open, IPC guard,
rotating log, and the family (dir/key/heartbeat/request) module onto `@masora/desktop-kit` v0.1.2, and
replaced the hand-maintained preload/bridge with one IPC table (`desktop/ipc-table.js`) that generates
both `desktop/preload.js` and `board/src/lib/bridge.generated.d.ts`. No `hub/` or `client/` file changed
functionally — `hub/public/board.js` is byte-identical to 0.2.87 (only its `.map` and `.srchash` moved,
tracking the source-only `bridge.ts` -> `bridge.generated.d.ts` split) — so this release needed no hub
redeploy, only the desktop app.

- **Verified before tagging.** `node scripts/run-tests.mjs`: 2645 pass, 0 fail, 7 skipped (all named).
  `ci` and a `workflow_dispatch` `build` both green on `5bf2536` before the version bump, confirming the
  exact commit being tagged was already proven on both Windows and macOS runners.
- **Built and signed on the real `v0.2.88` tag pipeline**, not an ad-hoc local build: Windows
  `Get-AuthenticodeSignature` -> `Valid`, `CN=Andrew Doft` on both `zevet.exe` and the NSIS installer;
  macOS `.app` signed `Developer ID Application: Michael Shvidler (27C8FVB83B)`, notarized and stapled
  twice (app then dmg), `spctl` -> `source=Notarized Developer ID`.
  `hub/client-manifest.signed.json` re-signed for the version bump alone (file list and hashes
  unchanged from 0.2.87) — `scripts/release-check.mjs`'s `checkSignedManifest` passed before tagging.
- **The stable links needed their usual per-release repoint.** `/srv/masora/Caddyfile`'s
  `Zevet.dmg`/`Zevet-Setup.exe` rewrites were still pinned to `zevet-0.2.87-*`, exactly as RELEASING.md
  §4a describes — edited in place with the `r+` python script (never `sed -i`, same bind-mount-inode
  trap), confirmed inside the running container at `/etc/caddy/Caddyfile` (the doc's example path is the
  HOST path; the container sees it at `/etc/caddy/Caddyfile`, per `docker inspect --format '{{.Mounts}}'`),
  then `caddy reload`.

**Verification.** Live feed (`https://usemasora.com/download/zevet-latest.json`) parses and verifies
under the pinned key via `desktop/app-update.js`'s real `readSignedFeed`; a one-byte tamper to
`payload.platforms["win32-x64"].bytes` is rejected with "signature does not match the document". Both
installer URLs return `200` with `Content-Length` exactly equal to the feed's `bytes`, and the bytes
served over HTTPS hash to the feed's `sha256` exactly (`sha256sum` on a fresh `curl` download, not just
on the upload source). The stable links (`/download/Zevet.dmg`, `/download/Zevet-Setup.exe`) confirmed
repointed by exact `Content-Length` match after the Caddy reload. `usemasora.com/zevet` confirmed
showing `0.2.88` after its 5-minute ISR window revalidated.

**Not done.** No hub redeploy — nothing under `hub/` or `client/` changed in a way that affects what the
live hub serves (see above), so `docs/RELEASING.md`'s "Deploying the hub" section did not apply this
release. DECISIONS.md has no entry for 0.2.87 itself (`e760e22`/`edd75d4` shipped without one); that gap
predates this release and was not backfilled here.

## D-029 — An open board reloads itself onto a new hub deploy, only when idle

The desktop app loads the board from the hub and never navigates again, so a hub deploy never reached an open
window. The hub now has a build id — sha256 of `board.js.srchash` + `editor.js.srchash`, first 12 hex, or
`HUB_BUILD_ID` — served at `GET /version` (`{build}`, no-store), in `/healthz`, and stamped into the served
`index.html` as `<meta name="zevet-build">`. The board (`board/src/lib/stale-build.mjs`, wired in `App.tsx`)
polls `/version` every 60 s and on focus/visibility and reloads when it differs **and** the board has had no
input for 2 min (hidden counts as idle) **and** no dialog is open **and** the editor has no unsaved buffer
**and** no input/textarea/contenteditable holds text (the agent and terminal prompts are textareas). Baseline is
the page's own meta, not the first poll, so a deploy landing between page load and first poll is still seen.

## D-030 — The main process is split into a shell (bootstrap.js, in the asar) and a hot-swapped payload

**Decided (masora2 plan 2026-09-29-seamless-updates §3.6, W5).** `desktop/bootstrap.js` is the asar
entry: single-instance lock, the desktop-kit payload client, then `require(<payload dir>/main.js)`.
Everything in `payload.files` (`desktop/package.json`: `main.js` and every module it requires, the
preload, the setup page, fonts, icon) plus `client/*.mjs` is the payload; the installer carries it as
`resources/app-core`, the seed. The shell is `bootstrap.js`, `payload-config.js`, `update-signing.js`
(the pinned keys), `app-update.js` (the installer updater), Electron and the native modules. The split
follows `git log origin/main -30 -- desktop/`: releases touch `main.js`, `agent-*.js`, `console-log.js`,
`preload.js`, `ipc-table.js`, `package.json`; `app-update.js` and `update-signing.js` last changed for
the kit adoption, and the pinned keys must not be replaceable by the thing they verify.

- **seq** = `seqOf(version)` = `major*1e6 + minor*1e3 + patch` (0.2.89 -> 2089), so every version has a
  higher seq and the seed maps to the pulse exactly. `SHELL_VERSION = 1`.
- **Idle gate** (`payload-swap.js`): no swap while a console has a live process or spoke in 5 min, a chat
  turn is in flight, a window had input in 2 min, or no window is open. Then `activate(); relaunch();
  exit(0)`; quit activates without relaunching (`will-quit`, not `before-quit`, which a beforeunload can cancel).
- **Trial**: confirmed once a window has stopped loading (success OR failure: an unreachable hub is not the
  payload's fault) and the agent API answers, else a strike after 120 s; a load throw or an uncaught
  exception before confirm is a strike; three revert.
- **Installer feed** stays for shell updates. `app.getVersion()` is the installer's version and feeds only
  the installer updater; everything user-visible (Sentry release, hub version) reads the payload build.
- **Preload** sits in the payload, outside the asar, so it resolves `@sentry/electron` from the shell's
  directory, passed as `--zevet-shell-dir=`; the main process resolves shell packages through `NODE_PATH`
  set only while `bootstrap.js` loads `main.js` (spawned agents must not inherit it).
- **Open**: `client/*.mjs` also ships as `resources/client` (extraResources) as the fallback; the payload
  copy is preferred. Drop the extraResource once a release has run on the payload path.

> Renumbered from D-029 at merge: D-029 went to the hub build-id reload (hub-build-reload).

## D-031 — Shipped: bootstrap-shell payload release, and the first payload published (0.2.89)

**Decided (Andrew, 2026-09-29, "release Zevet 0.2.89").** First version built on the D-030 shell/payload
split: `desktop/package.json`'s `main` is `bootstrap.js`, and the release carries the payload as
`resources/app-core`, the seed. This is also the first release to publish a payload, not just an
installer — the `p/zevet/stable/{win-x64,mac-arm64}` pulses now exist on `masora-app` for the first time,
seq 2089, mapping exactly to what this installer carries (per D-030, `seqOf("0.2.89") = 2089`).

- **Verified before tagging.** `npm test`: 2720 tests, 2713 pass, 0 fail, 7 skipped. Both `build.yml` legs
  green on the tag (`93c83e0`, `v0.2.89`): Windows `Get-AuthenticodeSignature` -> `Valid`, `CN=Andrew Doft`;
  macOS `spctl` -> `source=Notarized Developer ID`, ticket stapled, native arm64 in all 18 Mach-O files.
- **`hub/client-manifest.signed.json` re-signed** for the version bump (`scripts/sign-client-manifest.mjs`);
  `scripts/release-check.mjs` passed before tagging.
- **Installer feed and payload published together.** `scripts/make-feed.mjs ./release-0.2.89` for the
  installer feed; `scripts/make-feed.mjs payload --out ./payload-0.2.89 --channel stable` staged
  `desktop/payload-tree.cjs`'s tree (the same tree this build's installer seeds from) and wrote 67 blobs
  + 2 manifests (one per platform) + 2 pulses. Uploaded bytes-before-pointer: `p/b/`, `p/m/`, the two
  payload pulses, then `zevet-latest.json` last.
- **Published straight to `stable`**, not `canary` first — this is the seeding release, so there is no
  earlier build for a canary cohort to compare against; `stable`'s seq starts at 2089 and the seed maps
  exactly, same as the plan's masora 0.3.116 step.
- **Stable links repointed** (`/download/Zevet.dmg`, `/download/Zevet-Setup.exe`) in place via the `r+`
  python script (never `sed -i`), confirmed inside `masora-caddy-1` at `/etc/caddy/Caddyfile`, then
  `caddy reload`.
- **Hub redeployed** from the `v0.2.89` tag (tarball over `/srv/zevet` in place, `docker restart
  masora-zevet-hub-1`) since the manifest was re-signed. `board.js`/`editor.js` sources did not change
  this release, so `BUILD_ID` (`507c4ef3009d`) is unchanged from before the restart — expected per its
  definition (D-029: a hash of the two `.srchash` files, not of the deploy itself).

**Verification.** Both stable links return `200` with bytes that hash to the exact sha256 the feed
(and CI) named (`e339912d…` dmg, `69bd66c7…` exe) — a fresh `curl | sha256sum`, not the upload source.
Both `p/zevet/stable/*/pulse.json` cryptographically verify under the pinned `zevet-2026-09` key via
desktop-kit's real `verifyFeed`/`PULSE_DOMAIN`, naming build `0.2.89` seq `2089`. `p/m/*` and `p/b/*`
serve `Cache-Control: public, max-age=31536000, immutable`; the pulses serve `no-store`. Hub `/healthz`
and `/version` both `200` after redeploy.

**Not done / could not verify from here.** No Windows or macOS machine on hand to click "Check now" and
watch a live app actually swap onto the new payload (RELEASING.md §6/§7's `test-payload-swap.mjs` covers
this in CI instead, and ran green on both `build.yml` legs). Disk on `masora-app` was 15G free before and
after upload (well above the 5G cleanup threshold), so no old installers were removed.

## D-032 — API-spawned agents are pushed to the board; the actor a signed-in machine reports joins its person; the owner can rename anyone

**Decided (Andrew, 2026-09-29/30).** Two reports: "I can't see the agents you're running, only when I'm
in the repo", and "AndrewDoft and andrew are no longer combined".

**Agents.** The board learns of a console from exactly two things: its own launch, and one
`local:consoles` snapshot at page load. An agent spawned through the loopback API (or a schedule)
is neither, so it reached the board only as a *disk session*, and that scan is scoped to the open
repo (`refreshSessions` / `localRoot`). Fix: `announceConsole()` in `desktop/main.js` pushes the new
console over `local:agentAttached` (API spawn + scheduled run — not board launches, which already
hold an id-less pending entry); the board attaches it once (`reattachConsoles` now skips an id it
holds, exact match — `consoleById`'s pending-launch fallback would mis-fold). The People pane already
groups every `myConsoles` entry by repo, so no second view. `/list` reported `cwd: null` only
because `summarize` emits `root`; it now also emits `cwd` (worktree when there is one), `worktree`,
`branch`. New push channel, added to the frozen list in `desktop-bridges.test.mjs`: it carries what
`local:agentEvent` / `local:consoles` already do.

**People.** Production `accounts.json` was inspected read-only: owner `andrewdoft`, display
`andrew` (`named`), alias `AndrewDoft` — combined, and it survives restarts (bind-mounted
`/srv/zevet/var`). The hub's combine/rename and the owner check were correct and are now pinned by a
restart test. What was missing: (1) Settings had Combine but no way for the owner to rename *another*
person (the hub route already allowed it) — added; (2) the desktop's sign-in sets its actor to the
GitHub login while the hook uses the OS user, so one human keeps producing a second actor nobody has
aliased — a signed-in board now tells the hub its own machine's actor once per actor
(`renameSelf(me.name)`; the hub adds it as an alias only if no other person holds it).
Typing a name is still not proof (D-025); this is the person's own authenticated session claiming
their own machine's string, the same evidence `/auth/rename` already accepted.

**Not done / caveat.** A *different* teammate who shares an OS username with an unclaimed actor can
still be folded by whoever claims it first; the `machine` field is not part of the alias.

## D-033 — Shipped: the first payload-only release (0.2.90), canary then stable, with a hub deploy

**Decided (Andrew, 2026-09-29/30, "release Zevet 0.2.90").** Carries D-032 (agent visibility, people
rename) and an offline-update Sentry fix.

- **Payload-only, not a shell release.** `git diff --stat v0.2.89..HEAD -- desktop/` touched
  `main.js`, `preload.js`, `agent-api.js`, `ipc-table.js` and `sentry.js`. All five are in `payload.files`
  (`preload.js` too: `bootstrap.js` `verifyEntry`s it as payload), none is `bootstrap.js`,
  `payload-config.js`, `update-signing.js`, `app-update.js`, Electron or a native module. `SHELL_VERSION`
  stays 1 and `shell_min` 1. `zevet-latest.json` was **not** touched (still 0.2.89): installed apps
  take the payload with no installer bar. Installers for 0.2.90 were still built and published, and the
  stable `Zevet-Setup.exe` / `Zevet.dmg` links repointed, for new downloads (they seed 0.2.90).
- **Sentry ELECTRON-5/3.** `captureUpdateFailure` sends offline errors ("fetch failed", aborted check,
  ENOTFOUND/ECONNREFUSED/...) as one `warning` message (fingerprint `auto-update`,`offline`); bad
  signature / hash mismatch stay exceptions. Test mutated red twice (offline branch disabled; branch
  always taken), restored.
- **Verified before tagging.** `npm test` 2729 tests, 2722 pass, 0 fail, 7 skipped;
  `client-manifest.signed.json` re-signed. Tag `v0.2.90` on `release/0.2.90` (not merged to main); both
  `build.yml` legs green (Authenticode `Valid` `CN=Andrew Doft`; macOS `source=Notarized Developer ID`).
  sha256: exe `d9792f87…e3e9b4` (153052448 B), dmg `383e935e…e31b` (205232739 B); the stable links
  serve exactly those bytes.
- **Payload: canary, verified, then promoted.** 67 blobs + 2 manifests (win `41e4422e…`, mac `3b5aff4f…`).
  Uploaded blobs, manifests, canary pulses; over HTTPS all 67 blobs per platform brotli-decode to their
  manifest hashes, pulses verify under the pinned `zevet-2026-09` key, `no-store`; blobs `immutable`.
  Then `publish-payload.mjs promote` canary -> stable: seq 2090 (> 2089) on both platforms.
- **Delta a 0.2.89 install fetches:** 5 blobs, 91,697 bytes compressed (294,975 raw) per platform.
- **Hub** redeployed from the tag in place; `BUILD_ID` `507c4ef3009d` -> `bb82c3d86e6e` (board.js changed).

**Not verified.** No live app was made to swap (would restart agents running in the installed Zevet);
`test-payload-swap.mjs` covered that in CI.

## D-034 — Shipped: 0.2.91, the status strip shows the real 5h/7d limits (payload-only, hub deploy)

**Decided (Andrew, 2026-09-29/30, "release Zevet 0.2.91").** Carries ed4743e + 7bd4706: the strip shows the
rate-limit windows (percent used, time to reset) instead of Zevet's token tally.

- **Payload-only, not a shell release.** `git diff --stat v0.2.90..HEAD` touched `board/src` and tests
  only; nothing under `desktop/` or `client/`. `SHELL_VERSION` stays 1, `shell_min` 1, `zevet-latest.json`
  untouched (still 0.2.89). Installers for 0.2.91 were built and published, and the stable `Zevet-Setup.exe` /
  `Zevet.dmg` links repointed, for new downloads.
- **The committed board bundle was stale.** ed4743e changed `board/src` without rebuilding
  `hub/public/board.js`, so `test/board-bundle.test.mjs` failed (and main's `ci` run went red). The release
  commit rebuilds it (`npm ci && npm run build` in `board/`); the hub's `BUILD_ID` only moves because of that.
- **Verified before tagging.** `npm test` 2732 tests, 2725 pass, 0 fail, 7 skipped; client manifest re-signed.
  Tag `v0.2.91` on `release/0.2.91`; both `build.yml` legs green (Authenticode `Valid` `CN=Andrew Doft`;
  macOS `source=Notarized Developer ID`). sha256: exe `36381c86…7437` (153052224 B), dmg `8a6010c7…d6df`
  (205230656 B); the stable links serve exactly those bytes.
- **Payload: canary, verified, then promoted.** The board is not in the payload, so the tree hashes to the
  same 67 blobs as 0.2.90: **0 new blobs**, 2 new manifests (win `f35b144b…`, mac `d61272b1…`), pulses
  only. Pulses verify under the pinned `zevet-2026-09` key over HTTPS, `no-store`. Promoted canary -> stable:
  seq 2091 (> 2090) on both platforms.
- **Delta a 0.2.90 install fetches:** 0 blobs, 0 bytes (manifest + pulse only). The strip change reaches
  installs through the hub's board bundle, not the payload.
- **Hub** redeployed from the tag in place; `BUILD_ID` `bb82c3d86e6e` -> `e40eb6443647`; `/healthz` ok.

**Not verified.** No live app was made to swap or reload (would disturb agents running in the installed Zevet).

## D-035 — Shipped: 0.2.92, a cold launch applies a staged payload (shell release)

**Decided (Andrew, 2026-09-30).** 0.2.91 was staged on his PC, Zevet was force-killed and relaunched, and
`bootstrap.js` booted 0.2.89 again: the only apply paths were the idle swapper and `will-quit`, and a kill,
crash, reboot or logoff skips both. `startPayload` now calls `payload.activate()` before `payload.resolve()`
when `payload.staged()` is non-null (log `payload <build> staged; applied at launch`). `activate()` re-checks
bad-list, shell_min and schemaHead and writes `current.json` as a trial, so the existing confirm / 3-strike
revert covers a bad build. A throw is logged and boot continues on the current build.

- **Shell release.** `bootstrap.js` is not in the payload tree, so this needs the installer: installers + signed
  installer feed (`zevet-latest.json` 0.2.89 -> 0.2.92) + payload. Installed shells do not have the fix until
  they take the installer; the payload alone cannot carry it.
- **shell_min stays 1 (`SHELL_VERSION` unchanged).** The 0.2.92 payload runs on the old shell (it needs nothing
  the new shell adds), so raising it would strand every install that has not taken the installer.
- **Test.** `test/bootstrap-staged.test.mjs` loads the real `bootstrap.js` with electron, desktop-kit and
  payload-config stubbed: staged -> activate then resolve, runs as trial; nothing staged -> no activate;
  activate throws -> boots current. **Mutated:** the `await payload.activate()` line removed -> 2 of 3 red;
  restored -> green.
- **Verified before tagging.** `npm test` 2735 tests, 2728 pass, 0 fail, 7 skipped; board bundle was not stale;
  client manifest re-signed. Tag `v0.2.92` on `release/0.2.92`; `build.yml` both legs and `ci` green.
  sha256: exe `40184fdc…` (153052528 B), dmg `4fa41aca…` (205240842 B); the stable links serve those bytes.
- **Payload:** canary then stable, seq 2092 (> 2091) on both platforms, 67 blobs each (uploaded all; existing
  ones are content-addressed). Over HTTPS all 134 blobs brotli-decode to their manifest hashes; pulses `no-store`.
  Manifests win `ae4cd766…`, mac `e8720fce…`.
- **Hub not redeployed:** the board did not change. `hub/client-manifest.signed.json` was re-signed for 0.2.92
  and is committed; the hub keeps serving the 0.2.91 one until its next deploy (still validly signed).

**Not verified.** No live app was launched, restarted or killed (Andrew's installed Zevet was left alone).

## D-036 — Shipped: 0.2.93, Settings → Version shows the running payload build; tool-call groups keep following (payload-only, hub deploy)

**Decided (Andrew, 2026-09-30, "release Zevet 0.2.93").** Carries 3caa07c (Settings → Version shows the running
payload build, not the installer version) and 571e26a (opening a tool-call group keeps later groups open and following).

- **Payload-only, not a shell release.** `git diff --stat v0.2.92..origin/main` touched `desktop/main.js` (a payload
  file), `board/src`, the rebuilt `hub/public/board.js`, tests and DECISIONS.md; no `bootstrap.js`, Electron or native
  module. `SHELL_VERSION` 1, `shell_min` 1, `zevet-latest.json` untouched (still 0.2.92). Installers for 0.2.93 were
  built and published, and the stable `Zevet-Setup.exe` / `Zevet.dmg` links repointed, for new downloads.
- **Verified.** Tag `v0.2.93`; `build.yml` both legs and `ci` green; exe Authenticode `Valid` `CN=Andrew Doft`.
  sha256: exe `8bde55e2…` (153052792 B), dmg `3404867e…` (205220403 B); the stable links serve those bytes.
- **Payload:** canary, verified over HTTPS, then stable; seq 2093 (> 2092) on both platforms. Manifests win `91497595…`,
  mac `16531ba2…`. **Delta a 0.2.92 install fetches: 1 blob (`desktop/main.js`, 57030 B brotli)** + manifest + pulse.
  All 67 blobs brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`, `no-store`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `e40eb6443647` -> `9bda76f5c97c`; `/healthz` and `/version` agree.

**Not verified.** No live app was launched, restarted or killed (Andrew's installed Zevet was left alone).

## D-037 — Shipped: 0.2.94, startup 5h/7d probe, Zevet-launched agents carry the hub hooks, worktree identity (payload-only, hub deploy)

**Decided (Andrew, 2026-09-30, "release Zevet 0.2.94").** Carries the startup 5h/7d probe (`credential-usage.js`,
`agent-engine.js`, `main.js`), Settings version running/installer/Next, the combine suggestion (board), claude agents
launched by Zevet getting the hub hooks via `--settings` (`agent-console.js`), and hook worktree identity
(`client/hook.mjs`, `client/opencode-plugin.mjs`).

- **Payload-only, not a shell release.** `git diff --stat v0.2.93..origin/main` touched payload files (`desktop/main.js`,
  `agent-console.js`, `agent-engine.js`, `credential-usage.js`, `client/hook.mjs`, `client/opencode-plugin.mjs`), `board/src`,
  the rebuilt `hub/public/board.js`, tests and DECISIONS.md; no `bootstrap.js`, `payload-config.js`, `update-signing.js`,
  `app-update.js`, Electron or native module. `SHELL_VERSION` 1, `shell_min` 1, `zevet-latest.json` untouched (still 0.2.92).
  `client/*.mjs` is payload; installed clients also take it through the hub's signed client manifest (re-signed, committed).
  Installers were built and published, stable `Zevet-Setup.exe` / `Zevet.dmg` repointed, for new downloads.
- **First tag failed CI.** The plain-worktree tests compared against the unresolved temp path; git records the real one
  (macOS `/private/var`, Windows 8.3 -> long), so macOS and Windows failed while Windows-local passed. Test-only fix
  (`realpathSync.native`); nothing had been published, so `v0.2.94` was deleted and re-cut on the fixed commit.
- **Verified.** `npm test` 2772 tests, 0 fail, 7 skipped locally; `build.yml` both legs and `ci` green on the final tag.
  sha256: exe `06659aa6…` (153055576 B), dmg `948086b4…` (205189628 B); the stable links serve exactly those bytes.
- **Payload:** canary, verified over HTTPS (pulse signature under `zevet-2026-09`, `no-store`, manifest hash, 67/67 blobs
  brotli-decode to their hashes, both platforms), then stable; seq 2094 (> 2093). Manifests win `40c8c035…`, mac `60e652df…`.
  **Delta a 0.2.93 install fetches: 6 blobs, 93,021 B brotli** + manifest + pulse.
- **Hub** redeployed from the tag in place; `BUILD_ID` `9bda76f5c97c` -> `ce0b7413b53e`; `/healthz` and `/version` agree.

**Not verified.** No live app was launched, restarted or killed (Andrew's installed Zevet was left alone).

## D-038 — Shipped: 0.2.95, Match its own worktree case-insensitively on Windows (shell release)

**Decided (automatic, `npm run ship`, 2026-09-30).** ? commit(s) past v0.2.94.

- **Shell release.** desktop/package-lock.json changed: installers + signed installer feed (`zevet-latest.json` -> 0.2.95) + payload.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.95`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `6f741313…` (153057296 B), dmg `3dc950ee…` (205205875 B); the stable links serve those bytes.
- **Payload:** canary, verified over HTTPS, then stable; seq 2095 on both platforms. Manifests win `e2a6a747…`, mac `5c1fc87c…`. Delta: 6 new blob(s) uploaded. 68 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-070 — Wave 2 overlap check and advisory path claims

**2026-10-07**

**Overlap check** (`desktop/overlap-check.js`, run on the desktop before a prompt is dispatched; local embeddings only, never a remote model). Thresholds, in one constant: cosine **0.82 overlapping**, **0.62 adjacent**. Exact open/planned path match or same branch is overlapping; a shared directory (never the repo root) is adjacent. A claim has no task text and is never scored on text. The composer gate sits at both doors a prompt can take: `onNew` and the queue's `enqueue`/`steer` (an assistant-ui queue preempts `onNew`, so a gate only in `onNew` never sees a prompt to a running agent). Steers to a teammate and slash commands skip it. The notice names each hit (`overlapping · Kai · sess-kai`) with **Send anyway** / **Cancel**; Cancel puts the text back in the composer. Nothing is sent unasked.

**Claims** (`desktop/claims.js`) are advisory: nothing blocks a write. One sealed frame per agent session carries the whole path set, sealed with the document key (`client/doc-crypto.mjs`, AAD `claim <session>`, the same mechanism as steers), posted to `/ingest` as `kind:"claim"`. The hub keeps the latest blob per actor+session in memory only (not the event log, not the board snapshot, so a claim is never an agent turn), forwards it on each signed-in desktop's `/events?steer=1` channel, replays live ones to a new connection, and drops one on `release:true`. It sees what it sees on every event (actor, session) and a base64 blob. Desktops open frames and keep teammates' claims in a second store; their own frames coming back are ignored by session.

Lifetime: the claimer's timeout (30 min, capped at 1 h) sealed inside the frame; expiry and session end (console `exit`) broadcast a release; the hub forgets after 2 h regardless. A hand claim from the file tree belongs to the agent in front, else to `manual` (timeout or Release). An agent session claims, when it is sent a prompt, the files the prompt names that exist.

Board: chip `claimed: <file|n files>` on the card of the claiming session, a dot in the claimer's team colour on the file (name on hover), right-click Claim / Release on a file.

**Known edges.** The first prompt of a new agent cannot claim (no session id yet). The sealed body does not bind the actor, so the hub (already trusted for names) could attribute a frame to another actor; it cannot read or alter paths. Same-branch counts as overlapping as specified, so two people on `main` always see each other.

## D-071 — Plan progress on read-only agent cards

_Renumbered at merge from D-060 (collided with spawn)._

**2026-10-07**

**Decision (Andrew, final).** Derive plans only from native engine todo snapshots:
Claude `TodoWrite`, Codex `update_plan`, and OpenCode todo events. The latest
snapshot replaces the previous one; no plan is inferred for an engine that did
not emit a todo list. Local console cards read the existing transcript, while
teammate cards receive an opaque client payload through the existing activity
event so the relay only folds and orders it and does not parse step text.

Cards show `done/total`, the active step, and an expandable step list with
done/active/pending states. Step owners and offer-to-take are explicitly out of
scope for this item.

**Tests.** Recorded per-engine parser fixtures, replacement ordering, local
card rendering, and teammate event folding.

## D-039 — Shipped: 0.2.96, Bundle for 0.2.96 (Zevet model, spawn via board) (shell release, hub deploy)

**Decided (automatic, `npm run ship`, 2026-09-30).** ? commit(s) past v0.2.95.

- **Shell release.** desktop/package-lock.json changed: installers + signed installer feed (`zevet-latest.json` -> 0.2.96) + payload.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.96`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `02284050…` (153066048 B), dmg `17586b6c…` (205216390 B); the stable links serve those bytes.
- **Payload:** canary, verified over HTTPS, then stable; seq 2096 on both platforms. Manifests win `a350983c…`, mac `4b4bd609…`. Delta: ? new blob(s) uploaded. 70 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `ce0b7413b53e` -> `ba9d7b69ccb5`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-040 — Shipped: 0.2.97, Keep claude's session id per console, so restarts resume them (payload-only, hub deploy)

**Decided (automatic, `npm run ship`, 2026-09-30).** 9 commit(s) past v0.2.96.

- **Payload-only, not a shell release.** No shell file changed; `zevet-latest.json` untouched. Installers for 0.2.97 were built and published, and the stable `Zevet-Setup.exe` / `Zevet.dmg` links repointed, for new downloads.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.97`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `8ae89213…` (153068536 B), dmg `19f96cda…` (205244081 B); the stable links serve those bytes.
- **Payload:** canary, verified over HTTPS, then stable; seq 2097 on both platforms. Manifests win `ac3c2e5b…`, mac `75584776…`. Delta: 7 new blob(s) uploaded. 71 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `ba9d7b69ccb5` -> `20cbf2ebb00a`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-041 — Shipped: 0.2.98, Agent API /list reports each console's session id (payload-only)

**Decided (automatic, `npm run ship`, 2026-09-30).** 2 commit(s) past v0.2.97.

- **Payload-only, not a shell release.** No shell file changed; `zevet-latest.json` untouched. Installers for 0.2.98 were built and published, and the stable `Zevet-Setup.exe` / `Zevet.dmg` links repointed, for new downloads.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.98`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `875a175c…` (153068456 B), dmg `f54b9b47…` (205246880 B); the stable links serve those bytes.
- **Payload:** canary, verified over HTTPS, then stable; seq 2098 on both platforms. Manifests win `402dc7ec…`, mac `28a1f2d3…`. Delta: 1 new blob(s) uploaded. 71 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-042 — Shipped: 0.2.99, Sprites show when the open folder is a worktree (payload-only, hub deploy)

**Decided (automatic, `npm run ship`, 2026-09-30).** 2 commit(s) past v0.2.98.

- **Payload-only, not a shell release.** No shell file changed; `zevet-latest.json` untouched. Installers for 0.2.99 were built and published, and the stable `Zevet-Setup.exe` / `Zevet.dmg` links repointed, for new downloads.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.99`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `40364417…` (153068744 B), dmg `9312df42…` (205236039 B); the stable links serve those bytes.
- **Payload:** canary, verified over HTTPS, then stable; seq 2099 on both platforms. Manifests win `ba28e63f…`, mac `c96b2d87…`. Delta: 3 new blob(s) uploaded. 71 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `20cbf2ebb00a` -> `59a26fa08c4b`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-043 — Shipped: 0.2.100, Force the TAP reporter so the gate can name failing files (shell release, hub deploy)

**Decided (automatic, `npm run ship`, 2026-09-30).** ? commit(s) past v0.2.99.

- **Shell release.** desktop/app-update.js, desktop/package-lock.json, desktop/package.json, desktop/update-rollback.js, desktop/update-signing.js changed: installers + signed installer feed (`zevet-latest.json` -> 0.2.100) + payload.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.100`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `6093238e…` (153077960 B), dmg `8d9afa0b…` (205199804 B); the stable links serve those bytes.
- **Payload:** canary, verified over HTTPS, then stable; seq 2100 on both platforms. Manifests win `63b632b2…`, mac `a734eb54…`. Delta: 9 new blob(s) uploaded. 74 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `59a26fa08c4b` -> `f6d7d5a2d34c`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-044 — Shipped: 0.2.101, Pick the cloud origin at launch (app.usemasora.com if it resolves, else the sslip one); Ma (shell release, hub deploy)

**Decided (automatic, `npm run ship`, 2026-10-01).** ? commit(s) past v0.2.100.

- **Shell release.** desktop/package-lock.json, desktop/payload-config.js changed: installers + signed installer feed (`zevet-latest.json` -> 0.2.101) + payload.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.101`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `9aa23103…` (153080528 B), dmg `3109baae…` (205197641 B); the stable links serve those bytes.
- **Payload:** stable, verified over HTTPS; seq 2101 on both platforms. Manifests win `02f5f390…`, mac `63dbe216…`. Delta: 0 new blob(s) uploaded. 75 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `9c3446cdcdbf` -> `9c3446cdcdbf`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-045 — Shipped: 0.2.102, Cloud origin is fixed at app.usemasora.com (payload-only)

**Decided (automatic, `npm run ship`, 2026-10-01).** 4 commit(s) past v0.2.101.

- **Payload-only, not a shell release.** No shell file changed; `zevet-latest.json` untouched. Installers for 0.2.102 were built and published, and the stable `Zevet-Setup.exe` / `Zevet.dmg` links repointed, for new downloads.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.102`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `de25c029…` (153079920 B), dmg `15a5954e…` (205202315 B); the stable links serve those bytes.
- **Payload:** stable, verified over HTTPS; seq 2102 on both platforms. Manifests win `fc82582f…`, mac `624e91b0…`. Delta: 2 new blob(s) uploaded. 75 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-046 — Shipped: 0.2.103, Masora link says offline (shell release, hub deploy)

**Decided (automatic, `npm run ship`, 2026-10-01).** ? commit(s) past v0.2.102.

- **Shell release.** desktop/package-lock.json changed: installers + signed installer feed (`zevet-latest.json` -> 0.2.103) + payload.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.103`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `05dccc37…` (153079944 B), dmg `5dbcc7f2…` (205193107 B); the stable links serve those bytes.
- **Payload:** stable, verified over HTTPS; seq 2103 on both platforms. Manifests win `6a795eea…`, mac `969debff…`. Delta: 0 new blob(s) uploaded. 75 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `9c3446cdcdbf` -> `12f071c4e39e`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-047 — Shipped: 0.2.104, A hub migration moves the open board with it (payload-only)

**Decided (automatic, `npm run ship`, 2026-10-01).** 2 commit(s) past v0.2.103.

- **Payload-only, not a shell release.** No shell file changed; `zevet-latest.json` untouched. Installers for 0.2.104 were built and published, and the stable `Zevet-Setup.exe` / `Zevet.dmg` links repointed, for new downloads.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.104`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `e731856b…` (153079832 B), dmg `88b72532…` (205200645 B); the stable links serve those bytes.
- **Payload:** stable, verified over HTTPS; seq 2104 on both platforms. Manifests win `4f472b6c…`, mac `7a57e169…`. Delta: 1 new blob(s) uploaded. 75 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-048 — Shipped: 0.2.105, Zevet router v2 (classified, seeded, free-only, privacy-gated) (payload-only, hub deploy)

**Decided (automatic, `npm run ship`, 2026-10-01).** 12 commit(s) past v0.2.104.

- **Payload-only, not a shell release.** No shell file changed; `zevet-latest.json` untouched. Installers for 0.2.105 were built and published, and the stable `Zevet-Setup.exe` / `Zevet.dmg` links repointed, for new downloads.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.105`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `7f8dee73…` (153084520 B), dmg `fd441d8a…` (205235433 B); the stable links serve those bytes.
- **Payload:** stable, verified over HTTPS; seq 2105 on both platforms. Manifests win `27997ec0…`, mac `edc44475…`. Delta: 4 new blob(s) uploaded. 76 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `12f071c4e39e` -> `3ad72bb5ee74`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-049 — Shipped: 0.2.106, Main into fix/no-workspace-error (payload-only, hub deploy)

**Decided (automatic, `npm run ship`, 2026-10-01).** 8 commit(s) past v0.2.105.

- **Payload-only, not a shell release.** No shell file changed; `zevet-latest.json` untouched. Installers for 0.2.106 were built and published, and the stable `Zevet-Setup.exe` / `Zevet.dmg` links repointed, for new downloads.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.106`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `19467a1d…` (153085464 B), dmg `6ebd6e8a…` (205222377 B); the stable links serve those bytes.
- **Payload:** stable, verified over HTTPS; seq 2106 on both platforms. Manifests win `da0bfa5f…`, mac `9ec88694…`. Delta: 2 new blob(s) uploaded. 77 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `3ad72bb5ee74` -> `9200e4e21d0e`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-050 — Shipped: 0.2.108, Google sign-in from a mapped Workspace domain joins the default team, no team name or key (shell release, hub deploy)

**Decided (automatic, `npm run ship`, 2026-10-01).** 3 commit(s) past v0.2.106.

- **Shell release.** desktop/package-lock.json changed: installers + signed installer feed (`zevet-latest.json` -> 0.2.108) + payload.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.108`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `8b1a90c2…` (153085544 B), dmg `3d9e57e7…` (205178450 B); the stable links serve those bytes.
- **Payload:** stable, verified over HTTPS; seq 2108 on both platforms. Manifests win `d108a753…`, mac `bab663fe…`. Delta: 1 new blob(s) uploaded. 77 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `9200e4e21d0e` -> `9200e4e21d0e`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-051 — Shipped: 0.2.109, One team per Google Workspace — sign-in routes to the domain's team, no second team can cl (payload-only, hub deploy)

**Decided (automatic, `npm run ship`, 2026-10-01).** 3 commit(s) past v0.2.108.

- **Payload-only, not a shell release.** No shell file changed; `zevet-latest.json` untouched. Installers for 0.2.109 were built and published, and the stable `Zevet-Setup.exe` / `Zevet.dmg` links repointed, for new downloads.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.109`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `71354d29…` (153085864 B), dmg `e1b2622f…` (205180670 B); the stable links serve those bytes.
- **Payload:** stable, verified over HTTPS; seq 2109 on both platforms. Manifests win `2508e64f…`, mac `6a65c856…`. Delta: 1 new blob(s) uploaded. 77 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `9200e4e21d0e` -> `9200e4e21d0e`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-052 — Shipped: 0.2.110, Fix Mac window controls overlapping Zevet navigation (payload-only, hub deploy)

**Decided (automatic, `npm run ship`, 2026-10-02).** 2 commit(s) past v0.2.109.

- **Payload-only, not a shell release.** No shell file changed; `zevet-latest.json` untouched. Installers for 0.2.110 were built and published, and the stable `Zevet-Setup.exe` / `Zevet.dmg` links repointed, for new downloads.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.110`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `84ff75e3…` (153085904 B), dmg `41f6aee3…` (205223813 B); the stable links serve those bytes.
- **Payload:** stable, verified over HTTPS; seq 2110 on both platforms. Manifests win `9e43c99c…`, mac `b3979d1c…`. Delta: 1 new blob(s) uploaded. 77 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `9200e4e21d0e` -> `81f2f9bda1ab`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-053 — Shipped: 0.2.111, Zevet pairs with the signed-in Masora cloud automatically (payload-only)

**Decided (automatic, `npm run ship`, 2026-10-05).** 2 commit(s) past v0.2.110.

- **Payload-only, not a shell release.** No shell file changed; `zevet-latest.json` untouched. Installers for 0.2.111 were built and published, and the stable `Zevet-Setup.exe` / `Zevet.dmg` links repointed, for new downloads.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.111`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `3b586e1a…` (153086704 B), dmg `73971e05…` (205235226 B); the stable links serve those bytes.
- **Payload:** stable, verified over HTTPS; seq 2111 on both platforms. Manifests win `74073991…`, mac `047b9f36…`. Delta: 2 new blob(s) uploaded. 77 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-054 — Shipped: 0.2.112, Chat thread spacing; Masora one-login hub sign-in (payload-only, hub deploy)

**Decided (automatic, `npm run ship`, 2026-10-05).** 6 commit(s) past v0.2.111.

- **Payload-only, not a shell release.** No shell file changed; `zevet-latest.json` untouched. Installers for 0.2.112 were built and published, and the stable `Zevet-Setup.exe` / `Zevet.dmg` links repointed, for new downloads.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.112`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `5a3746ab…` (153087112 B), dmg `2363d8e7…` (205234016 B); the stable links serve those bytes.
- **Payload:** stable, verified over HTTPS; seq 2112 on both platforms. Manifests win `631b2cc1…`, mac `0042127e…`. Delta: 2 new blob(s) uploaded. 77 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `81f2f9bda1ab` -> `1226eb09dff3`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-055 — Shipped: 0.2.115, Clearer labels: Resume, New agent + (shell release, hub deploy)

**Decided (automatic, `npm run ship`, 2026-10-05).** 18 commit(s) past v0.2.112.

- **Shell release.** desktop/package-lock.json changed: installers + signed installer feed (`zevet-latest.json` -> 0.2.115) + payload.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.115`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `9b66005f…` (153087560 B), dmg `54dd8804…` (205228985 B); the stable links serve those bytes.
- **Payload:** stable, verified over HTTPS; seq 2115 on both platforms. Manifests win `b29491d5…`, mac `c11bfe98…`. Delta: 2 new blob(s) uploaded. 78 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `d4dddd2a9d9d` -> `afb54a24e840`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-056 — Shipped: 0.2.116, Live agents show their sprite on the rail and in the conversation header (payload-only, hub deploy)

**Decided (automatic, `npm run ship`, 2026-10-05).** 2 commit(s) past v0.2.115.

- **Payload-only, not a shell release.** No shell file changed; `zevet-latest.json` untouched. Installers for 0.2.116 were built and published, and the stable `Zevet-Setup.exe` / `Zevet.dmg` links repointed, for new downloads.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.116`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `41c94366…` (153088016 B), dmg `cea2300c…` (205199625 B); the stable links serve those bytes.
- **Payload:** stable, verified over HTTPS; seq 2116 on both platforms. Manifests win `e2784dbb…`, mac `4934827c…`. Delta: 1 new blob(s) uploaded. 78 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `afb54a24e840` -> `8fc1a63ac8e6`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-057 — Shipped: 0.2.120, Merge remote-tracking branch 'origin/main' into int/1005-final (shell release, hub deploy)

**Decided (automatic, `npm run ship`, 2026-10-06).** 27 commit(s) past v0.2.116.

- **Shell release.** desktop/bootstrap.js, desktop/package-lock.json, desktop/session-meta.js changed: installers + signed installer feed (`zevet-latest.json` -> 0.2.120) + payload.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.120`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `79e1b414…` (153091616 B), dmg `38d69cbe…` (205217345 B); the stable links serve those bytes.
- **Payload:** stable, verified over HTTPS; seq 2120 on both platforms. Manifests win `21680d72…`, mac `fc0d9724…`. Delta: 13 new blob(s) uploaded. 79 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `8fc1a63ac8e6` -> `ae51dcbb3e12`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-058 — Cross-machine steering is built, gated by a team policy; prompt text is shared into agents

**2026-10-06**

**Decision (Andrew, final).** Two reversals of what this file and the README
used to say zevet deliberately does not do:

1. **A person can steer a teammate's agent** (amoeba gap plan, item B). The
   board's Steer button on a teammate's agent row retargets the composer; the
   desktop seals the text with the document key (`client/doc-crypto.mjs`, AAD
   binding steer id + target person + target session, so the relay cannot
   re-aim or re-number it) and POSTs `/api/steer`. The hub stamps `from` from
   the caller's session (a body `from` is ignored), refuses replays by id,
   rate-limits the sender (10/min), caps the sealed size, refuses a target
   agent its board has never seen, and relays ciphertext only to the target
   person's own channel (`/events?steer=1`), never the team. The target's
   desktop (`desktop/agent-steer.js`) reports `delivered`, finds the agent
   among its OWN consoles, and injects through the board's Send as a turn
   starting `[from <name>]` (never a slash command). Every steer ends in a
   status the sender sees: queued, delivered, accepted, declined (with why),
   refused-by-policy, offline, unknown-agent.
2. **Prompt text is shared, including into agents** (item D). A
   desktop-launched claude gets a bounded (≤1500 chars) team activity block —
   who is working on what, the first line of teammates' last three prompts,
   open comments from `~/.zevet/comments` — appended via
   `--append-system-prompt`, framed as data, not instructions. The desktop
   refreshes `~/.zevet/activity.md` every minute while signed in; the detached
   updater rewrites it for hook-only machines; `install.mjs --activity` adds an
   opt-in `@~/.zevet/activity.md` import to a repo's `CLAUDE.md`. Never via the
   hook's stdout.

**The policy.** One app-wide setting per team, `steer` ∈ {`on`, `ask`, `off`},
default `ask`, stored in the team's `accounts.json` (`policy`), served by
`GET /api/policy`, written by `PUT /api/policy` by the team owner only (the
existing owner gate), validated (anything but the three values is a 400 and a
bad batch changes nothing), audited (`accounts.audit`, plus a hub log line),
and enforced by the HUB: `off` is refused before anything is relayed; `ask`
is relayed flagged `approval: true` and the owner's app injects only after
Approve (the desktop treats a missing flag as `ask`); `on` injects directly.
The board's `<SteerPolicyControl />` (owner: three buttons; everyone else: a
sentence) is rendered in Settings by settings.tsx.

**Why ask is the default.** A steer is remote prompt injection into a machine
holding credentials. The update channel already taught this project not to
ship auto-accept first.

**Known limits, said plainly.**
- Only agents running in the target's Zevet app can be steered; a terminal
  session is declined ("not running in their Zevet app").
- An approval card nobody answers declines after 10 minutes; a hub restart
  loses in-flight statuses (steers already injected are unaffected).
- The hub holds the team secret on disk (`hub/accounts.mjs` header), so "the
  hub cannot read a steer" means the hub process never opens one.
- claude's system prompt is fixed for the life of its process, so the block is
  a snapshot at each process start (start, resume) plus a pointer to the live
  file. codex and opencode have no system-prompt flag here and get the file
  only. A `.cmd`-shim claude cannot take a multi-line argument at all
  (agent-console.js § CMD_METACHARACTERS), so it gets the file only too.
- Hook-only machines refresh the file at the updater's cadence (≤ every 30
  min) and only with a personal session; the board refuses the shared token.
- The cost of sharing prompt text into agents: a teammate's prompt is now
  input to your agent. The block is flattened, capped and labelled as data;
  that reduces the lever, it does not remove it.

**Tests.** `test/steer-hub.test.mjs` (non-admin PUT, bad values, policy=off
enforcement, approval flag, forged `from`, replay, oversize, malformed,
unknown agent, offline, wrong-recipient status, settled-stays-settled, rate
limit, shared token), `test/agent-steer.test.mjs` (AAD binding, no plaintext
on the wire, approval gate, decline/timeout, replay, text-only injection, and
one steer end to end through a real hub), `test/activity.test.mjs`.

## D-059 — Shipped: 0.2.121, Rebuild board bundle (payload-only, hub deploy)

**Decided (automatic, `npm run ship`, 2026-10-06).** 19 commit(s) past v0.2.120.

- **Payload-only, not a shell release.** No shell file changed; `zevet-latest.json` untouched. Installers for 0.2.121 were built and published, and the stable `Zevet-Setup.exe` / `Zevet.dmg` links repointed, for new downloads.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.121`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `20b6a0c8…` (153106536 B), dmg `c0958971…` (205269430 B); the stable links serve those bytes.
- **Payload:** stable, verified over HTTPS; seq 2121 on both platforms. Manifests win `be4f89ae…`, mac `bb2fb76f…`. Delta: 11 new blob(s) uploaded. 81 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `ae51dcbb3e12` -> `f7c2582d3539`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-060 — A teammate can start an agent on your machine, gated by the steer policy

**2026-10-07**

**Decision (Andrew).** People can create an agent under another teammate's
account: it RUNS on the teammate's machine, in their Zevet app, in their repo,
with their credentials, and shows on the board under their name. Built as a
sibling of D-058's steering, on the same machinery: the prompt is sealed with
the document key (AAD binding id, target person, repo, agent and model, so the
relay cannot re-aim any of them), `POST /api/spawn` relays it over the same
per-person channel (`/events?steer=1`, frame `spawn`), and the owner's app
reports through the same `/api/steer/status`. Statuses: queued, delivered,
accepted, started (carrying the new session id), declined, no-such-repo,
refused-by-policy, offline.

**Same policy, enforced by the hub.** The team's `steer` setting governs it
(no second knob): `off` refuses at the hub; `ask` (default) relays with
`approval: true` and the owner's card spells out the agent, the exact folder
and the full prompt — nothing starts before Start; `on` starts it directly.

**Why it is stricter than a steer.** A spawn starts a NEW process with the
owner's credentials. So:
- The repo is a folder NAME (`^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$`, no `..`),
  checked by the sender's app, the hub and the owner's app, and resolved only
  against the owner's open workspaces by folder name — what the hook reports
  as `repo`. Not open there: `no-such-repo`. Two open folders with that name:
  also refused, never guessed.
- The mode is the owner's own stored default when it is a safe one (`plan`,
  `ask`), otherwise `ask` — never `auto` or `dangerous`. The engine is the
  machine's default login. The hub refuses a body carrying `mode`,
  `permissionMode`, permissions, flags/args, `cwd`, `env`, `engine`,
  `systemPrompt` and similar; the owner's app reads none of them anyway.
- It is started directly by the main process (`startAgentCore`), not through
  the board page, because that page is served by the hub.
- At most 3 remote-started agents run on one machine at once (checked before
  the card and again after approval); at most 3 spawns wait on one person's
  answer at a time (hub); 5 per minute per sender (hub).
- `started` is accepted by the hub only after `accepted`; then the session is
  recorded as started by the sender and folded onto that agent in every
  board's snapshot (`agents[].startedBy`), shown as "by <sender>" on the row.
  The owner's own console is labelled "started by <sender>" and its first
  turn reads `[started by <sender>] <prompt>`.

**Known limits.** The repo list the sender sees is what the board has seen the
teammate work in (event `repo` names), not what they have open; their app's
`no-such-repo` is the authority. An unanswered card declines after 10 minutes.
If the new agent has not reported a session within 30 seconds, `started` is
sent with an empty session and the board mark is skipped. "started by" lives
in the hub's memory (lost on a hub restart). Codex/OpenCode take their first
prompt and exit (existing behaviour); a follow-up is the owner's to make.

**Tests.** `test/spawn-hub.test.mjs` (path repos, smuggled modes/flags, bad
agents/models, policy off, replay, oversize, shared token, card flood, rate
limit, offline, forged from, only-to-target, started-before-accepted,
wrong-person status, the startedBy mark), `test/agent-spawn.test.mjs` (AAD
binding, repo resolution, safe mode, ask approve/decline/timeout, no-such-repo,
cap before and after approval, replay, ignored sender fields, and one spawn end
to end through a real hub).

## D-061 — Microsoft is the third sign-in provider, mirroring Google; no domain door

**Decided (Andrew, 2026-10-07).** Add Microsoft (Entra ID + personal accounts, tenant `common`, OIDC authorization-code)
beside GitHub and Google, with the same routes (`/auth/microsoft/start|callback|finish`, one shared pairing table whose
entries record the provider that minted them), env (`ZEVET_MICROSOFT_*`), account provider `"microsoft"`, and a
"Continue with Microsoft" button wherever the other two are (setup window, Settings, Link another account).

- **Token trust is Google's:** the id token is fetched by the hub itself over TLS, so the signature is not re-verified
  (OIDC Core §3.1.3.7); the same condition applies — an id token from anywhere else makes JWKS verification mandatory.
  Claims checked: `iss` = `https://login.microsoftonline.com/<tid>/v2.0` with `tid` a GUID from the same token, `aud`,
  `exp`, and a per-attempt `nonce` (new; Google's flow has none).
- **Identity is `sub`**, unique only within provider. Email is evidence only with `xms_edov`; otherwise `emails` is empty
  and the login is namespaced `ms:<name>` so it cannot equal a Google/GitHub login that carries proof (nOAuth).
- **Domain door skipped.** Google's `hd` is a signed claim naming a Workspace domain; Entra's nearest thing is `tid`,
  a tenant id, not a domain, and domain proof would need `xms_edov` plus a suffix check — the exact email-suffix
  weakness google-auth.mjs warns about. Microsoft people join by invite (verified email or an already-listed identity).
- **Unclaimed-hub safety:** a Microsoft sign-in is held to `ZEVET_MICROSOFT_OWNER`, else `ZEVET_GOOGLE_OWNER`, else
  `ZEVET_GITHUB_OWNER`, so enabling Microsoft cannot open a hub reserved for someone else.
- **Cost:** personal Microsoft accounts may not carry `xms_edov` (unverified), in which case they cannot be auto-linked or claim an email invite
  until the app registration emits it; they can still own a hub or be linked from an existing session.

## D-062 — Shipped: 0.2.122, Rebuild board.js.map from a clean checkout (sources pointed at a linked node_modules, CI r (payload-only, hub deploy)

**Decided (automatic, `npm run ship`, 2026-10-07).** 17 commit(s) past v0.2.121.

- **Payload-only, not a shell release.** No shell file changed; `zevet-latest.json` untouched. Installers for 0.2.122 were built and published, and the stable `Zevet-Setup.exe` / `Zevet.dmg` links repointed, for new downloads.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.122`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `ca8a466d…` (153111440 B), dmg `fc8569b5…` (205272671 B); the stable links serve those bytes.
- **Payload:** stable, verified over HTTPS; seq 2122 on both platforms. Manifests win `0ed56733…`, mac `81d1dcce…`. Delta: 9 new blob(s) uploaded. 82 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `f7c2582d3539` -> `e65b755bd3fc`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-072 — Shipped: 0.2.123, Merge remote-tracking branch 'origin/main' into int/0.2.123 (payload-only, hub deploy)

**Decided (automatic, `npm run ship`, 2026-10-07).** 11 commit(s) past v0.2.122.

- **Payload-only, not a shell release.** No shell file changed; `zevet-latest.json` untouched. Installers for 0.2.123 were built and published, and the stable `Zevet-Setup.exe` / `Zevet.dmg` links repointed, for new downloads.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.123`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `a36367c6…` (153116656 B), dmg `def3f55f…` (205254623 B); the stable links serve those bytes.
- **Payload:** stable, verified over HTTPS; seq 2123 on both platforms. Manifests win `50fe6f8e…`, mac `786cedf8…`. Delta: 6 new blob(s) uploaded. 84 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `e65b755bd3fc` -> `79c173a36ba9`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-073 — Every dispatch and agent card shows who pays: engine + account

**2026-10-07**

**Decision (Andrew; filed as "D-072" in the brief — that number was taken by the 0.2.123 ship record, so this is D-073).** On every dispatch (composer, steer, spawn on a teammate's machine) and every agent card, a small muted label names which credential the turn bills: `Claude · andrew@… (Max)`, `Codex · ChatGPT Plus`, `OpenCode · free model`, `Zevet model`. Unknown shows nothing; nothing is guessed.

**Where identity comes from** (`desktop/payer.js`, identity only, never a token): claude — `oauthAccount.emailAddress` in `~/.claude.json` and `subscriptionType` in `.credentials.json` (a saved personal credential that overrides the login is named by its label; a team/auto pick and the second Max account are unknown); codex — `chatgpt_plan_type` in the claims of `auth.json`'s id_token (the JWT payload is read, the token is not kept), or "API key"; opencode — the model (`:free` = free model, else its provider); zevet — "Zevet model".

**Own cards and composer.** The board asks the desktop (`local:payerFor`) for each running console; the label is `c.payer` (and `c.account`, which the card's detail line already rendered), and the composer shows it above the box.

**Teammate cards.** The desktop seals `{label, account}` per session with the document key (AAD `payer\0session`, the same scheme as D-070 claims) and POSTs it as `kind: "payer"` to `/ingest`. The hub relays it as ciphertext on the steer channel (own map beside claims, 2 KiB cap, replayed to late joiners, released on session end, not an agent turn, never in the log or board snapshot). It cannot read it. Hook-only sessions (no Zevet console) have no payer and show nothing.

**Steer and spawn.** The label is the EXECUTING machine's, never the sender's: the owner's approval card (steer: under the title; spawn: a "Bills" row replacing "your account") carries `payer` computed on their machine; the sender's target line and the sent-status row read the teammate's sealed frame (steer: that session; spawn: that person's last label for the chosen engine, then the started session's own once it exists). No frame yet: nothing shown.

**Known limits.** A steer's owner card knows the console's agent but not its model, so an opencode steer card shows no payer. The second Max account (engine2) and team/auto-ladder credentials are unknown, so claude agents launched on them show nothing. A teammate on an older build shares nothing.

**Tests.** `test/payer.test.mjs`: per-engine extraction from fixture files (and that no token or email other than the named one leaks), the sealed frame (session AAD, key), through a real hub (relay, late joiner, release, never in clear, not an agent turn, bad payloads refused), the board wording, and the steer/spawn/agent-card wiring.

## D-074 — Shipped: 0.2.124, Amoeba site read, feature matrix and ranked build order (payload-only, hub deploy)

**Decided (automatic, `npm run ship`, 2026-10-07).** 3 commit(s) past v0.2.123.

- **Payload-only, not a shell release.** No shell file changed; `zevet-latest.json` untouched. Installers for 0.2.124 were built and published, and the stable `Zevet-Setup.exe` / `Zevet.dmg` links repointed, for new downloads.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.124`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `61482c26…` (153119792 B), dmg `09ac1b62…` (205235681 B); the stable links serve those bytes.
- **Payload:** stable, verified over HTTPS; seq 2124 on both platforms. Manifests win `63ed8ec7…`, mac `612d4271…`. Delta: 4 new blob(s) uploaded. 85 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `79c173a36ba9` -> `713e53eabdb1`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-075 — Subagent work integrates exactly once, only when it is safe (renumbered at merge from D-073, then D-074, which the 0.2.124 ship record took)

Verified against `origin/main` (2026-10-07): `desktop/agent-worktree.js` made an isolated `zevet/<slug>` branch
and `releasePlacement()` only committed and released it. There was no merge back, no check gate, no per-run key,
and nothing on the subagent row.

First attempt (65f4724) was rejected: it ran `npm test` + `npm run typecheck` in any repo on every release and
`git merge --no-ff` straight into the user's own checkout. Decided rules, all in `desktop/agent-integration.js`:

1. **Parent checkout is never touched while dirty** (tracked or untracked changes) **or mid-merge/rebase/cherry-pick/revert**:
   outcome `waiting` with the reason. Checked before the checks and again right before the merge (checks take minutes).
2. **A failed merge never leaves the repo half-merged.** Conflict files are listed, `git merge --abort` runs, and
   status is verified clean; outcome `failed: conflicts in <n> files` (files in `files`).
3. **Checks come from the repo**, read from the parent checkout (an agent cannot rewrite its own gate): `checks` in
   `.zevet/config` or `zevet.checks` in package.json, else `scripts.test` (+ `typecheck` only if that script exists;
   `npm init`'s placeholder test is not a check). None declared: the automatic trigger stops at `no checks` and never merges.
4. **Exactly once**: a per-run marker (`<zevet home>/integrations/<run>.json`) plus an in-flight map. The automatic
   trigger never retries a recorded outcome; `integrated` is final. The parent must still be the branch the worktree
   was cut from (`parentBranch` in the worktree record), else `waiting: parent moved to <branch>`.
5. **Checks run with a 15 min timeout** and are killed as a process tree (`taskkill /T` / process group) on timeout
   and on app quit.
6. **Visible**: the outcome is console meta plus `local:agentIntegration`, shown on the subagent row as
   integrated / waiting: why / failed: why / no checks, with Integrate and Discard (confirm on second click) once the
   agent is no longer running. Integrate (manual) retries a recorded outcome and, with no declared checks, merges
   after rules 1, 2 and 4. It still needs green checks when the repo declares them.

Trigger scope: only the end of a scheduled run integrates automatically. Closing a thread, quitting and failed
starts release the worktree (branch kept if it has commits) and never merge, since no row could show it. A held
worktree (waiting/failed/no checks) stays until Integrate, Discard, thread close, or the next start's prune; a held
worktree older than the app session is gone, its branch survives for a manual `git merge`.

## D-076 — Shipped: 0.2.125, Merge remote-tracking branch 'origin/main' into fix/subagent-integrate-once (payload-only, hub deploy)

**Decided (automatic, `npm run ship`, 2026-10-07).** 5 commit(s) past v0.2.124.

- **Payload-only, not a shell release.** No shell file changed; `zevet-latest.json` untouched. Installers for 0.2.125 were built and published, and the stable `Zevet-Setup.exe` / `Zevet.dmg` links repointed, for new downloads.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.125`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `84b50af6…` (153123984 B), dmg `209b8ecc…` (205237586 B); the stable links serve those bytes.
- **Payload:** stable, verified over HTTPS; seq 2125 on both platforms. Manifests win `a0e5ef9b…`, mac `f7621746…`. Delta: 5 new blob(s) uploaded. 86 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `713e53eabdb1` -> `9b6196041fef`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).


## D-077 — Pinned memory: per-file notes sealed with the doc key, staleness read from the local tree

*Renumbered at merge from D-NEXT-W2-10.*

**Decision.** A note is `{id, repo, path, text, hash, author, createdAt, updatedAt, retired}`, `hash` being the sha256 of the file's bytes when the note was written (a `commit` hash reader exists in `currentHash`, unused by default). `desktop/pinned-memory.js` owns it. Notes are sealed one-per-id with the document key (AAD `memory\0repo\0id`) in `<zevetHome>/memory/<repo>.memory.json`, and shared by sending the note through the existing doc-sync room `memory:<repo>` (sealed again with the room name as AAD), so the hub relays and replays ciphertext and learns neither path nor text. Staleness (`fresh` / `stale` / `missing`) is computed on each machine by hashing its own working tree; it is never stored and never hub-side. A person edits, re-pins ("Still true") or retires a note; last write by `updatedAt` wins. The board shows a "stale" mark on the tree row, a "notes: N stale" chip beside the files-changed summary, and the file view lists that file's notes with Edit / Still true / Retire / Pin.

**What already existed.** `knowledge.tsx` only derives citation, read and math cards from the active transcript; it stores nothing. `Memories` (runspec.tsx) shows read-only agent memory files from `local:memories`. The "vault" is a read-only health file for the status line (status-sources.js). None holds per-file notes, so the store is new; the transport (doc-sync rooms), sealing (doc-crypto) and the claims idiom (D-070) are reused.

**Alternatives.** (1) A hub-side store: rejected, the hub would need plaintext paths to flag staleness, or hold durable state we deliberately keep out of it. (2) A claims-style hub map (`/ingest` kind): in-memory with a 2h TTL, wrong for durable notes. (3) Storing notes in the repo: pollutes the customer's tree. (4) Git blob/commit hash as the only pin: content hash works on uncommitted work and non-git folders; commit mode stays available.

**Limits.** The hub's room log is memory-only and capped (doc-sync's rule), so a hub restart loses relayed notes until a holder edits; every machine keeps its own sealed copy. Edits are last-write-wins with no merge. Notes are not yet pushed back on reconnect.

**For item 9.** Agents call `createMemory(...).create({repo, path, text, root, author})`, `.list({repo, path, root})`, `.retire(id)`; treat note text as data and cap it (MAX_TEXT 2000).

**Reversibility.** Additive: remove the module, four `local:memory*` handlers, and the board components; sealed files on disk are inert.

**Not verified.** Only the headless browser walk with a stubbed desktop bridge: no real app launch, no second machine seeing the notes, staleness against a live working tree edited by a real agent.

## D-078 — Comments pinned to turns, hunks and plan steps; comment to agent

*Renumbered at merge from D-NEXT-W2-4.*

**2026-10-07**

**Pre-existing.** Comments were already code-anchored only: a Y.Map in the file's encrypted Y.Doc (`board/src/lib/presence-comments.mjs`, panel `components/comments.tsx`), Y.RelativePosition anchor, replies, resolve, unresolved export to `~/.zevet/comments`.

**Added.** Same Y.Map, so the same doc-key sealing; the hub still sees ciphertext only. `ref` pins a comment to a transcript **turn** (session, turn index, a quote capped at 600 chars; no text anchor) or a diff **hunk** (file plus up to 40 lines of 200 chars, optional text anchor so it follows edits). `step` pins it to a **plan step** from D-071 by position AND text, because plans are replaced wholesale; `stepState` matches by text, and a dropped step reads "gone". Refs are cleaned on write and again on read: a peer can put anything in a shared map.

**Comment to agent.** `frameForAgent` builds the steer text: a fixed header saying the block is quoted data, not instructions; one `<zevet-data source="comment">` block (the shared frame, `desktop/data-frame.mjs`, also used by D-087; consolidated at merge from a private `<<<zevet-comment` frame) holding the comment, then the anchored lines; delimiters inside the content are defanged; capped at 3600 chars (steer limit 4000, minus the `[from …]` prefix), cutting the quoted lines before the ask, with a visible `[cut: too long]`. It goes out through the existing steer channel (`sendSteerTo`), so the team steer policy (default ask), sealing, outcome rows and the receiving app's `[from …]` prefix all apply unchanged. Send needs a steer target already chosen.

**Limits (known).** Turn and hunk comments live in the open file's doc, so they need a shared editor open; with none, the Comment buttons are hidden. No separate per-session comment room was built. Turn index is the last message of the active console. The step picker lists the plan of the ACTIVE LOCAL console only (teammate plans are an opaque blob, D-071).

**Tests.** `test/comment-anchor.test.mjs`; each guard mutation-checked (defang, cap, data header, ref storage, step link, ref validation).

**Turn button (fixed at merge).** The headless walk found "Comment on this turn" could never render: it needs an open file's comment room but lived in TurnDetail, which renders only while no file is selected. It now renders from the conversation card (`TurnCommentButton`, conversation.tsx), next to the thread, like the hunk button. `test/turn-comment-button.test.mjs` fails without the mount. Starting an agent from the composer (`showConversation()`) clears `selectedPath` by design and leaves the editor session, and so the room, alive; that is the "Pick a file" pane the walk saw, not agent events resetting selection (local agent events never reach `followEvent`).

**Not verified.** Only the headless walk with a stubbed desktop bridge: no real shared-editor room with two people, no comment reaching a real running agent.

## D-079 — Per-team retention, and secret redaction on the client before anything leaves

*Renumbered at merge from D-NEXT-W2-13.*

**2026-10-07 (build-order item 13).**

**Retention.** A new team policy `retention` (forever | 90d | 30d | 7d | 1d; default forever), set by the owner through the existing `PUT /api/policy` (owner gate, validation and audit trail all reused) and shown under Settings > Team. The hub's existing TTL compaction now takes its window from `detailTtl(accounts)`: the shorter non-zero of the operator's `ZEVET_DETAIL_TTL_MS` (kept, as the floor) and the team's own setting. Compaction was boot-only; it is now `board.compact()`, run at boot and again the moment retention changes, and it blanks the in-memory events as well as the log file. Only `detail` is blanked; who/tool/file/repo is the board's long memory and is never trimmed. Alternative not taken: a free-form number of days. Five fixed windows are enough, are validated by the same table as `steer`, and cannot be set to a value that silently deletes everything.

**Redaction.** `client/redact.mjs` is the one net: 14 named rules (PEM private keys, sk-ant-, sk-or-, sk-, stripe, xai-, ghp_/gho_/ghu_/ghs_/ghr_/github_pat_, AKIA/ASIA, AIza, xox*, JWT, Bearer, NAME=secret .env lines, and the old keyword=value rule), each replacing with `[redacted:<kind>]`. It replaces the two divergent copies in `hook.mjs` and `opencode-plugin.mjs`. It runs in the hook before the event body is built (prompt, command and plan-step text), so what reaches the hub, its log and every board is already clean. It is client-side because the hub cannot read sealed traffic and a hub-side scrub would only cover the plaintext half. The opencode plugin is one self-contained file and cannot import; it carries a byte-identical copy of the rules block, and a test fails on drift.

**Behaviour change, deliberate.** The old net replaced any 40+ character hex run as a "long hex blob". That redacted every git sha and sha-256 on the board and caught almost no real secret (real keys carry a prefix and now have a rule). It is removed; a test pins that a 40-hex sha survives. Markers changed from `[redacted]` to typed ones.

**Where it is NOT applied.** Steer and spawn text typed into Zevet's own composer, and sealed claims, are not run through the net: the user typed those to an agent on purpose and a silently altered instruction is worse than a visible secret. No transcript is relayed to the hub today (the board shows hook activity and sealed steers only), so there is no transcript path to redact.

**Release note.** `client/redact.mjs` is new and listed in `CLIENT_FILES`; `hub/client-manifest.signed.json` is stale until re-signed with `scripts/sign-client-manifest.mjs` at release (release-check will say so).

**Tests.** `test/redact.test.mjs` (one case per rule, each proved reachable through that rule alone via `matchedRules`; false-positive cases; the hook end to end against a real hub; plugin parity) and `test/retention.test.mjs` (default keeps; owner 1d blanks board and log immediately; 7d keeps; member refused; bad value refused).

**Not verified.** No run against a real team hub with live clients: redaction was exercised on fixtures, and ship.mjs re-signs `client-manifest.signed.json` (with `client/redact.mjs`) at release, so the signed payload has not been checked end to end.

## D-080 — Agent notifications and editable shortcuts

*Renumbered at merge from D-NEXT-W2-14.*

**2026-10-07**

**Decision.** (a) Native OS notifications (Electron `Notification`, same code on Windows and macOS) for two kinds: **attention** (permission prompt, question, error result, non-zero exit; default on) and **finished** (clean result, exit 0; default off). Each has its own toggle in Settings > Agents > Notifications, stored in `zevet.notify.v1`. A click raises the window and focuses that agent's card (`local:notify` out, `local:notifyClick` back, keyed by console key). (b) Shortcuts live in one table (`board/src/lib/keybindings.mjs`); the palette and tree handlers call `matches()`. Settings > Appearance > Shortcuts rebinds, detects conflicts, resets per key or all; overrides in `zevet.keys.v1`.

**Where the logic lives.** The board decides (`board/src/lib/notify.mjs`, pure, clock/timer/OS call injected); main only shows. Chosen because the board already folds console events and owns the prefs mirror, so toggles apply per event with no IPC round trip.

**Coalescing.** Per 2 s window the first 2 notifications show; the rest are held and sent as one "N more agents". A clean agent already on screen with the app focused is not notified.

**Accelerators.** Electron spelling, `CommandOrControl+Shift+K`; it matches Ctrl or Cmd, as the old handlers did. A binding needs CommandOrControl or Alt. The menu zoom keys and copy/paste/cut/undo/select-all are reserved. Only the two board shortcuts are rebindable; menu zoom stays fixed (Electron menu accelerators are built once at startup).

**Limits.** Permit and ask requests carry no console id, so their click raises the window but does not pick a card (the request card is already global). "Idle waiting for input" is not distinguished from finished: a turn ending is both. Not verified: real OS toast rendering, macOS.

**Tests.** `test/notify-keys.test.mjs`: mapping, toggles, coalescing, conflicts, persistence, reset; each mutation-checked.

**Not verified.** Real OS toast rendering (Windows toast, macOS Notification Center) and click-through to the right console were never seen; macOS in particular was not run. Only the IPC wiring and key handling are tested.

## D-081 — Roles: Viewer / Commenter / Editor / Owner, enforced at the hub

*Renumbered at merge from D-NEXT-W2-7.*

**2026-10-07.** Item 7 of the Amoeba build order.

**Decision.** Each person on a team has a role: `viewer` < `commenter` < `editor` < `owner`. `owner` is not stored; it is `state.owner` and cannot be granted, removed or re-roled. Everyone else carries `role` on their person record. `accounts.roleOf(ref)` reads it live on every call and `accounts.can(ref, action)` checks it against `ACTION_ROLE`, so a demotion refuses that person's very next request (nothing is cached in a session).

- **Gated at the hub (403 `<role> role required`):** `/api/steer`, `/api/spawn` (Editor), `/team/credentials` add and secret fetch (Editor: the secret goes to a machine), and, for a person's own desktop (a session token), `/ingest` events (Editor) and claim/payer frames (Commenter). `take-over` is in `ACTION_ROLE` (Editor) for item 2 to call; there is no route yet.
- **Not gated:** `/ingest` carrying only the bare team secret (a hook-only machine has no person), board reads, `/ws` document sync (ciphertext; its token is usually the shared secret, so the hub cannot tell who is writing).
- **Change a role:** `POST /auth/role {login, role}`, owner only; `viewer|commenter|editor`. Audit entry `{what: "role.<login>", from, to, by}` in the same trail as policy. whoami, `/api/policy` and the people list report `role`. Board: a role select per member row in team settings, role label for non-owners; no explanatory text.
- **Migration:** a record with no valid `role` loads as Editor; the owner is Owner. Nobody loses what they could do. New invitees are Editors.
- **Merge:** two rows merged into one human keep the LOWER role, so linking an account cannot undo a demotion.

**Alternatives.** (a) Role on the session: stale after demotion, rejected. (b) Per-workspace roles: no workspace object exists yet; per team now. (c) Gate `/ws` by session role: blocked by the shared-secret token and by the hub being blind to which frames are comments vs edits. (d) Ownership transfer: out of scope.

**Why.** The ship rule: a demoted user must be stopped by the server, not by a desktop that obeys.

**Reversibility.** Additive. `role` is an extra field older hubs ignore; removing the gates restores today's behaviour (everyone Editor). No data to unwind.

**Tests.** `test/roles.test.mjs` (accounts unit + real hub). Mutation-checked: removing the steer gate, the spawn gate, the ingest gate, the owner check on `/auth/role`, the audit write, the rank comparison in `can`, and changing the migration default to viewer each turned the suite red; all restored.

**Not verified.** No UI walk of the role select, no two-machine run, `/ws` not role-gated.

## D-082 — Take over a teammate's running turn: sealed baton over the steer channel, one winner decided at the hub

*Renumbered at merge from D-NEXT-W2-2.*

**2026-10-07**

**Decision.** A Take over button on a teammate's agent row (next to Steer) asks for the baton. The taker picks the engine (Claude, Codex, OpenCode, Zevet model); a NEW turn starts in the taker's own app, on the taker's own login and credentials, in the taker's copy of the repo (resolved by folder name against their open workspaces, like D-060), carrying the owner's transcript tail (24 KB, newest kept) and a diff summary (branch, `git status --short`, `git diff --stat HEAD`), and opening with "[taken over from X]" plus the line the agent must lead with: where it resumes. It runs in the taker's safe mode (plan or ask), never auto. The transcript is framed as data, not instructions (D-058's injection rule).

**Flow and seams.** (1) Taker: `POST /api/takeover`, body sealed `{agent, payer}` with the document key (AAD `takeover, id, owner, session`). (2) Hub: policy `steer` gates it exactly as steer and spawn do (`off` refused before anything is relayed; `ask` relayed with `approval: true`; `on` straight through; a missing flag asks on the desktop), then the one-winner decision. (3) Owner's app: opens it, approves when asked (the card names the taker's engine and the payer their machine reported), captures, seals the baton (AAD `baton, id, owner, session`, so a request can never be replayed as one) and `POST /api/takeover/baton`. (4) Hub relays the baton to the taker's own channel only, as ciphertext it never opens; the owner's turn is stopped only AFTER the hub has relayed it, so a taker who went offline (`offline`, hold released) costs the owner nothing. (5) Taker's app: opens the baton, checks it names the engine THIS person asked for (an owner cannot pick it), starts the turn, and `POST /api/takeover/status` with `started` and the new session, or `start-failed` with why. Statuses reach the taker's board as steer-status frames (`of: "takeover"`).

**One winner.** The first request for an (owner, session) holds it in the hub, decided in a synchronous section with no await between the read and the set, so concurrent requests cannot both win. Every other taker gets HTTP 409 `status: "lost"` naming the winner. The hold counts while the request is queued, delivered or accepted (15 min cap on a pending one) and is final once `started`; a decline, an unanswered ask, an offline taker or `start-failed` free it, so the next request can try.

**Payer chip (D-073).** The label is the EXECUTING machine's, the taker's: the sent row on the taker's board shows `Bills you: <taker's login>`, the owner's approval card shows `Bills <taker>: ...` from the label the taker's machine sealed into the request, and the new console's own chip comes from the existing per-console payer path. Nothing is guessed; unknown shows nothing.

**Role hook (item 7, built in parallel).** `mayTakeOver(acc, sess)` in hub/server.mjs is the single hook point. It defaults to the current member check (any signed-in team member, which `teamFromSession` already enforces) and is where Editor-or-above goes.

**Alternatives.** (a) The taker pulls the transcript from the hub: rejected, the hub holds no transcripts and must not. (b) Owner stops first, then hands over: rejected, a failed handoff would kill work for nothing; baton first, stop after. (c) Optimistic claim in the taker's app: rejected, only the hub sees every taker. (d) Carry the full patch instead of a summary: not done; the spec says summary, and the taker's repo is expected to have the branch (see Not verified). (e) A new channel: rejected, the steer channel and its policy are the point.

**Why.** Amoeba's best story ("hit limit, teammate continues with full context, announces where it resumes"), but sealed, policy-gated, across all four engines, and never explicit-intent-free: default `ask`.

**Reversible.** Fully: one hub route group, one desktop module, one button; no stored state (holds are in memory, like steer records). An older desktop answers nothing to a `takeover` frame, so the taker sees the request stay queued; the board hides the button on a build without `takeoverSend`.

**Known limits.** "Safe checkpoint" is `stop()` on the owner's console, which ends the process mid-step; there is no gentler interrupt in the console layer today. The diff is a summary: uncommitted work lives on the owner's machine and is not transferred, so the taker works from their own checkout and the summary says what changed. The transcript is the console log's bounded head and tail; engines it cannot parse contribute nothing rather than noise. A hook-only agent (no Zevet console) cannot be taken over (`declined`: not running in their Zevet app).

**Tests.** `test/takeover.test.mjs` (30): sealing and AAD, per-engine transcript, owner and taker inboxes, a real hub for policy, one-winner, release, final, relay scope, ordering and refusals, and an end-to-end run with two desktops. **Mutation checks** (each broken, run, seen red, restored): one-winner check removed (race, decline-release and final tests red); policy-off gate removed (red); owner approval gate removed (3 red); owner keeps turn when taker offline removed (red); baton-picks-engine check removed (red); baton AAD label equal to request label (red); taker-status ordering removed (red). A "decline releases the lock" mutation survived because the release was redundant (the hold stops counting once the record is declined); the dead release was deleted rather than left untested.

**Role gate (wired at merge).** `POST /api/takeover` calls W2-7's `roleRefusal(auth, "takeover")`, so Editor or above; a Commenter gets 403 (`test/takeover.test.mjs`, mutation-proven). The old `mayTakeOver` hook is gone.

**Not verified.** Never run on two real machines. The safe checkpoint is `stop()` mid-step, so the stopped step is cut off; uncommitted work is not transferred, only the diff summary. Nothing here ran against a real second engine or account.



## D-083 — Read-only model catalogue in Settings > Agents (renumbered at merge from D-NEXT-W2-16)

**2026-10-07**

**Decision.** Settings > Agents gets a "Models" section under Model credentials: one row per model the
engines can run (claude and codex from their own catalogues, opencode's free list), showing readiness, who
pays, list price per MTok in/out, and the median cost of this board's recent runs on it. Read-only, no
resale (build order §4); nothing is metered or sold.

**Why there.** The credentials, the Auto ladder and the engine settings already live in that tab, and the
section reads exactly those (D-018 credentials and ladder rung, `local:agents` detection). No new IPC, no
desktop module: everything the rows need is already in the board store.

**Prices.** `board/src/lib/model-prices.mjs` is the only price source; each entry has `source` and `as_of`.
No entry means "—". Read 2026-10-07: Anthropic and OpenAI list prices from their pricing pages; free rows
from OpenRouter's models API and opencode Zen docs. List API prices only; a subscription login pays no
per-token price.

**Not done.** Per-turn cost: the board keeps one cumulative cost per console, so the figure is per run
(INSUFFICIENCIES INSUF-011). Teammate payer (D-073) is per session and is not a row.

## D-084 — A restart for an update never lands under a working agent, and a continued agent keeps its id and label (renumbered at merge from D-NEXT-UPD-BUSY)

**Observed (0.2.125, 2026-10-07 19:30:20Z).** Two hosted agents were mid-turn when every Zevet process restarted. k11-kai-rebase (ea3598ff) kept its id; zv-int126 (b3645999) went to exited, its `zagent wait` exited 1 with no result, and the work continued as bc29d564 labelled "w2-walk" in the same worktree.

**Mechanism (evidence).**
- The payload swapper's gate (`desktop/payload-swap.js` `busyReason`) only blocked on a running agent when it was NOT resumable (`a.running > 0 && !a.resumable`), and `main.js` `useGate.activity` marks every claude/codex/opencode console with a session id resumable. So a resumable agent mid-turn did not block `app.relaunch(); app.exit(0)`. The idle INSTALLER already refused mid-turn consoles (`idle-install.js` `midTurn`, from `gate.working`); the payload swapper never got `working`. 0.2.125 was payload-only, so only the swapper applied. The swap also releases consoles whose turn dies with the process (`releaseForRelaunch` -> `c.stop()`).
- Restore keeps id and label (`restoreResumableConsoles`: `forcedId: s.id`, `label: s.label`; persistence round trip is tested). The only path that mints a new id and drops the label for a continued thread is `local:resumeAgent` (`main.js`): `instrumentedStartConsole` was called without an id (agent-console.js `options.id || randomUUID()`) and `consoleMeta` got no label. The board calls it with `continues: c.id` for any console that is not running with a session id (board.ts follow-up path), and the API's `send --via board` goes through the same path. A console that `releaseForRelaunch` had just stopped is exactly that. This matches "new id, label gone (falls back to the generated title), same worktree". Not reproduced against the live app; see Not verified.
- A waiter had no recovery: the API port and token change on relaunch, `zevet-agent wait` made one request, and `/wait` returned "exited" when the relaunch's own `stop()` fired.

**Decided.**
- `busyReason` takes `working()` and refuses with "an agent is mid-turn" before the resumable exemption, for every console, API-spawned and hosted included. Idle resumable consoles are still restored (unchanged). Both gates (swapper, idle installer) surface the deferral through `onWaiting`; `main.js` adds it to the `app:update` state as `waiting`, pushed to the board and setup window, and clears it when the next poll (30 s swapper, 60 s installer) lets the update through. Manual "Restart now" is a person's explicit click and is unchanged.
- A continued console keeps its id and label (`consolePersistence.resumedIdentity`, id reused only when the old process has exited). Chosen over an alias table: no second id to resolve, nothing for a waiter to follow.
- `/wait` does not report exited while `relaunching`; `zevet-agent wait` retries a dead connection or "no such console" for 120 s, re-reading `agent-api.json`, so a waiter survives a restart that restores the agent under the same id.

**Tests, each mutation-checked (break the code, red, restore).** payload-swap: busyReason mid-turn, swapper defers/surfaces/retries (gate line disabled: 2 fail). idle-install: deferral surfaced (onWaiting disabled: 1 fail). console-persistence: resumedIdentity + resumeAgent wiring (keep disabled: 1 fail). zevet-agent: wait rides out a restart (retry disabled: 2 fail). agent-api: /wait during relaunch (condition disabled: 1 fail).

**Not verified.** No live app was launched. The `resumeAgent` trigger for zv-int126 is inferred from code; the incident logs were not available. Full `npm test` was not run locally (it opens sign-in windows until fix/no-signin-popup-in-tests lands); CI runs it on the branch.

## D-085 — Shipped: 0.2.126, Merge remote-tracking branch 'origin/main' into int/w2-10-4 (shell release, hub deploy)

**Decided (automatic, `npm run ship`, 2026-10-07).** 37 commit(s) past v0.2.125.

- **Shell release.** desktop/zevet-agent.mjs changed: installers + signed installer feed (`zevet-latest.json` -> 0.2.126) + payload.
- **Verified.** Gate `node scripts/run-tests.mjs` green on the release tree; tag `v0.2.126`; `build.yml` both legs green; exe Authenticode `Valid CN=Andrew Doft`. sha256: exe `98886b5e…` (153144064 B), dmg `8a808601…` (205296251 B); the stable links serve those bytes.
- **Payload:** stable, verified over HTTPS; seq 2126 on both platforms. Manifests win `1517c541…`, mac `64ce6473…`. Delta: 14 new blob(s) uploaded. 90 blobs per platform brotli-decode to their manifest hashes; pulses verify under `zevet-2026-09`.
- **Hub** redeployed from the tag in place; `BUILD_ID` `9b6196041fef` -> `f5ebdfe979d7`; `/healthz` ok.

**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).

## D-086 — Cross-machine approval cards: an Editor answers a teammate agent's permission prompt

*Renumbered at merge from D-NEXT-W2-8.*

**2026-10-07.** Item 8 of the Amoeba build order.

**Decision.** When an agent on machine A asks permission, A (the executing side) may publish a card sealed with the document key (`desktop/agent-approval.js`, `POST /api/approval/open`). Any Editor on the team may answer it (`POST /api/approval/answer`, gated by `roleRefusal(auth, "approve")`; `approve: "editor"` in `ACTION_ROLE`). The hub relays the sealed answer to A's own channel as `approval-answer`.

- **Policy `approve` ∈ {off, ask, on}, default OFF**, owner-set through the existing `PUT /api/policy`, enforced at the hub on open AND on answer (turning it off bites an already-open card). `on`: the answer is applied. `ask`: the answer is only shown to the owner, whose own click decides. A frame missing the flag is read as `ask`.
- **The hub never decides.** It checks policy and role and arbitrates one thing: the first answer from an Editor wins (synchronous, so atomic); later ones get 409 with the winner. It sees ids, names, the allow/deny bit and times, never the tool or arguments.
- **Exact action, once, enforced on the executing machine.** The card seals a secret nonce and sha256 of the canonical `[tool, arguments]`. The answer seals the nonce, the hash and the decision, with AAD `id+session+hash`. A recomputes the hash from its OWN pending request and rejects any answer whose nonce, hash or decision (also sent in the clear for arbitration) differs. A rejected answer is reported `invalid` and the hub re-opens the card (3 tries). A settled id is remembered, so a replay settles nothing, and an old answer cannot authorise a later identical prompt (new id, new nonce). A remote answer never carries `always`.
- **Local wins.** A remote answer is held 1.5 s before it is applied; the person's own click inside that window (or at any time under `ask`) cancels it, and a local report overrides a relayed remote answer at the hub.
- **Outcomes shown to everyone:** open, answered, held, approved by X, denied by X, expired, unknown ("outcome unknown"). Unknown = an answer was relayed or an approval released less than 30 s ago and the executing app closed or its channel dropped (reported by the app on interrupt, and by the hub when the owner's last channel closes). An interruption before anyone answered is `expired`: the action never ran.
- **Board:** `ApprovalCards` (zevet-style one-liners, text children only), a policy control in Settings, the owner's own permit card is removed when a teammate's answer is applied (`permit-gone`). Own cards offer no buttons.

**Alternatives.** (a) Hub decides validity: it cannot, it is blind to the action. (b) Reuse the steer policy: steer is prompt injection, this is tool authorisation; they need separate switches. (c) Timestamp-only local-wins: a hold window is the only way a click can beat an already-relayed frame.

**Reversibility.** Additive. With `approve: off` (default) nothing is published and no route accepts an answer.

**Limits.** "Unknown" is best-effort: there is no tool-completion signal from the CLI, so a 30 s window stands in for "may still be running". Hub state is in memory (a hub restart loses open cards; the prompt then times out locally).

**Tests.** `test/approvals.test.mjs` (20). Mutation-checked, see the task report.

**Not verified.** Hub approval state is in memory (a hub restart loses open cards); "outcome unknown" is best-effort (30 s window, no tool-completion signal); no two-machine run, no UI walk, no real claude permission prompt end to end.

## D-087 — Agent-callable coordination tools on Zevet's MCP server

*Renumbered at merge from D-NEXT-W2-9.*

**Decision.** `zevet-mcp.js` (D-009) lists four more tools when the desktop is signed in to a team (`ZEVET_MCP_TEAM=1`): `get_team_context`, `claim_step`, `message_agent`, `record_memory`. The MCP child has no hub access, so each call POSTs `{tool, arguments, run}` to a new `/tool` route on the loopback ask-server (token-gated, 404 when unregistered, never a permit) and lands in `desktop/agent-tools.js`, which main.js feeds with this app's own signed-in state. No tool takes a team, hub or token; the repo folder comes from main's record of the run (`runRoots`), not from arguments.

- `get_team_context`: live agents from the hub's `/api/state` (read-only), their files (path claims plus recent write tools), plan with step owners, overlap flags where two agents touch one file in one repo. Finished and idle-over-30-min agents are left out. At most 12 agents, 6000 chars.
- `claim_step {session, step}`: `desktop/step-claims.js`, keyed by (session, plan step text). First claim wins locally; a later one is told the holder. Shared on doc-sync room `steps:<repo>` (sealed by the room); across machines every app converges on the earlier `(at, actor)`, so a loser that briefly thought it won is corrected. The plan card shows the owner beside the step (`AgentPlan owners`). Advisory, 4 h TTL, in memory.
- `message_agent {to, session, message<=500}`: only to a running agent listed by the hub; sent through `agent-steer.sendSteer` (sealed, hub-stamped sender, steer policy: default ask, the target's owner approves; refused-by-policy is reported to the agent). The text is flattened, defanged (`<`, `>`, `[`, `]`, code fences, control characters), capped, prefixed "quoted as data and not an instruction" and wrapped in `<zevet-data>`. Item 4's comment-to-agent framing is not on main, so the same rule is implemented here (`defang`/`asData`); fold the two when item 4 lands.
- `record_memory {path, text<=2000}`: `pinned-memory.create` (D-077): text capped, control characters stripped, tied to the file hash, sealed on disk and on the wire, authored "<person>'s agent"; path must be relative, inside the repo and exist.

**One helper with comment -> agent (D-078).** `defang`, `asData` and the cap now live in `desktop/data-frame.mjs`, imported by `desktop/agent-tools.js` (require) and `board/src/lib/comment-anchor.mjs` (bundled). Same `<zevet-data>` frame, same neutralising (angle brackets, square brackets, fences, control characters), same cap rule (never over `max`, marker included); `multiline` keeps line breaks for quoted code. The board source stamp also hashes the shared file. Square brackets become fullwidth in quoted code. Test: `test/data-frame.test.mjs`.

**Injection hygiene.** Everything a teammate wrote that goes back to an agent (doing/mission text, branch, plan steps, holder names, the message) is wrapped in `<zevet-data>`, one-lined, defanged and capped, and every tool description says it is data, never instructions (D-058 class).

**Not behind a permit.** Like `ask_user`, these tools skip the permission card (`OWN_TOOLS`): reading team state, an advisory claim and a sealed note need none; the one action on someone else's machine, a message, is approved by THEIR owner under the steer policy.

**Limits.** A claim is eventually consistent across machines and lost with the app (hub room log is memory-only). Plan steps are matched by text, so a rewritten step is a new step. A step claim needs the plan to have reached the hub (activity event). `message_agent` returns "queued", not the target's answer.

**Mutation checks** (each against `test/agent-tools.test.mjs`, then restored): claim first-wins removed -> first-wins test red; message defang removed -> cap/defang test red; approval message forced -> happy path red; a plaintext note written beside the sealed one -> sealed test red; `record_memory` dispatch removed -> three record_memory tests red; tool list always on -> list and refuse-by-name tests red; `<` left in -> frame and defang tests red; `getState` given the caller's arguments -> team-scope test red (and nine others).

**Reversibility.** Additive: remove the two modules, the `/tool` route, `TEAM_TOOLS`, and the `owners` prop.

**Not verified.** Claims live in hub/app memory only (no persistence across a restart); no two-machine run; no real agent has called the tools end to end.
