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
