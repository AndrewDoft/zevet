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
