# Single sign-in across Zevet, Zevet Voice and Masora (one machine, one OS user)

Andrew: "if you log into one it logs you into the other two."

Status: Zevet <-> Voice implemented (`desktop/sso.js`, zevet-voice `masora_dictation/sso.py` + `hub.sync`).
Masora is specified below, not implemented.

## Source of truth

- **The hub (hub.usemasora.com) decides whether a session is valid.** Nothing local can make a token work;
  every adopted token is checked with `GET /auth/whoami` first, and the login stored is the hub's answer, not
  the envelope's claim.
- **`<family dir>/sso.json` records the last sign-in or sign-out any app made on this machine.** Last writer
  wins, ordered by `issued_at` (ms). Each app keeps the session in its own store as before (Voice: DPAPI slot
  `hub`; Zevet: `config.json` `session`), so an app keeps working if the file disappears.

## What is shared, and how it is protected

One file, `sso.json`, in the existing per-user family dir (`%LOCALAPPDATA%\Masora\family`, macOS
`~/Library/Application Support/Masora/family`, Linux `$XDG_DATA_HOME/masora/family`):

```
envelope  {"v":1, "alg":"A256GCM", "nonce":b64(12 bytes), "ct":b64(ciphertext||16-byte tag)}
payload   {"v":1, "state":"signed_in"|"signed_out", "hub", "issued_at", "by":"zevet"|"voice"|"masora",
           "token", "login", "provider", "team", "owner", "secret"}       (the last six: signed_in only)
key       HKDF-SHA256(ikm = the 64 ASCII hex chars of family.key, salt = none, info = "zevet-sso/v1", 32 bytes)
AAD       "zevet-sso/v1"
```

- The token is **never in plain text on disk**: the whole payload, metadata included, is encrypted and
  authenticated. A file that does not authenticate under this machine's `family.key` is ignored.
- `family.key` is the existing pairing secret, restricted to the current user (Windows: `icacls
  /inheritance:r /grant:r DOMAIN\user:(R,W,D)`; POSIX: 0600). Masora writes it today. If it is missing, the
  first app that has to *publish* creates it in the same format: exclusive create (`O_EXCL`/`wx`), restricted
  while empty, then filled. Masora's `ensure_family_key` and the kit's `ensureKey` keep a well-formed existing
  key, so whoever creates it first, it stays. On POSIX a key that is not ours or is group/world readable is
  refused.
- `secret` (the team's master secret) rides along only so a fresh Zevet that adopts a Voice sign-in gets a
  working editor. It is what `/auth/<p>/finish` already hands whoever signs in. Voice never stores it.
- Byte compatibility is pinned: each suite opens a fixture the other language sealed.

**Rejected:** plain JSON with the token (even ACL'd: any backup or sync of the folder would carry it);
anything in `%TEMP%`, `%PUBLIC%`, `ProgramData` or the registry under HKLM (readable by other users); a
loopback HTTP endpoint that hands out the token (any local process, including another user's, can connect,
and it needs a running app); Electron `safeStorage` blobs (per-app key, Python cannot open them); raw DPAPI
from Node (needs a native module or a PowerShell spawn per read, and does nothing on macOS/Linux).

## Pick-up without a click

- Voice: the family thread's `tick()` (every 2 s) calls `hub.sync()`.
- Zevet: `sso.sync()` every 3 s, started with the family loop in `main.js`.
- `sync`: read and authenticate the envelope. Ignore it unless `issued_at` is newer than the newest this
  process applied or wrote, and not more than 60 s in the future. Ignore it if `hub` is not this app's own hub
  (a token is only ever sent to the origin that minted it). Then:
  - `signed_in` with a token this app does not already hold: `whoami`. Live personal session: store it exactly
    where the app's own sign-in would. Refused (401/not personal): drop the envelope. Hub unreachable: try again
    in 30 s.
  - `signed_out`: if this app holds a session, run its normal sign-out without publishing (best-effort hub
    logout of its own token, then forget it locally). Zevet keeps its team key, as its own Sign out does.
- Publishing: every sign-in path writes `signed_in` (Zevet: provider sign-in, team key join, Masora assertion
  sign-in; Voice: provider sign-in). Every sign-out writes `signed_out` (Zevet: Sign out, Sign out of team, only
  when a session existed; Voice: Sign out). An adopted change is never re-published, so there is no echo.
- Bootstrap: with no `sso.json` at all, an app that is signed in seeds it, so sessions from before this feature
  propagate. A file that exists but does not authenticate (for example `family.key` was replaced) is not
  overwritten by a seed; the next explicit sign-in or sign-out rewrites it.
- Masora -> Zevet -> Voice works today: Masora's cloud shell hands Zevet a hub assertion
  (`zevet.credentials.json` `hub`), Zevet redeems it at `/auth/masora`, and that sign-in is published.

Voice's Settings row re-renders every 3 s, so a change made elsewhere shows without a click. Zevet's board picks
the new config up on its next read; a first-run setup window that is open does not jump to the board (next launch
does).

## Sign-out

One session token is shared, so a sign-out in any app revokes it at the hub (`/auth/logout`) and the
`signed_out` envelope makes every other app forget it within one poll. An app that is not running applies it
when it next starts, because the envelope is still the newest one. If the hub was unreachable at sign-out, the
token stays valid at the hub until its idle TTL, but no app here presents it any more.

## Not installed, not running

- Not installed: nothing reads the file; nothing else changes. Installing later picks up the current state on
  first start (signed in if the last envelope is `signed_in` and the hub still accepts the token).
- Not running: the envelope waits. No age limit is needed, because whoami is the check.
- Signed out everywhere, or no family dir at all: every app works as before (dictation never needs a hub
  session); `sync` is a no-op and never throws.

## Relationship to feat/one-login

Both `origin/feat/one-login` branches are duplicates of what is already on main (triage: scrap-dup). masora2's
landed on main as D-905/D-906 (Masora Context 0.3.137, `c852db7f`); file by file it differs from `origin/main` only
in decision numbers and in what main gained since (Microsoft sign-in). zevet's two commits (`cc03467`, `8dc9aed`)
are patch-equivalent to commits on main (`git cherry main origin/feat/one-login`: both `-`). Neither needs
merging. This design builds on what they shipped and adds only the missing local-sharing piece.

### Already exists (do not rebuild)

masora2 `origin/main`:
- `packages/core/core/config.py:221,563`: `zevet_hub_secret` / `ZEVET_HUB_SECRET` (with `ZEVET_HUB_URL`).
- `apps/api/api/routers/family.py:214-225`: `_hub_assertion`, an HS256 `zevet_hub_assertion` (aud `zevet-hub`,
  10 min, `jti`, person, email, workspace, `admin`).
- `apps/api/api/routers/family.py:274-276`: `/family/cloud/credentials` adds `hub: {url, assertion}` for
  `app == "zevet"` only.
- `apps/desktop/shell/family-cloud.js:56-57,67`: re-issues for a Zevet whose heartbeat `hub_email` is not the
  signed-in person; writes the `hub` block into `zevet.credentials.json`.
- `apps/api/api/auth/desktop.py:179,193,792` and `apps/desktop/shell/desktop-login.js:6,52`: `signin_hint`
  (incremental Google consent, D-905). Unrelated to hub sign-in.

zevet `main`:
- `hub/masora-auth.mjs:10,33`: `verifyAssertion` (pinned alg/typ/aud, expiry) and `replayGuard` (single-use jti).
- `hub/server.mjs:1015,2199-2218`: `POST /auth/masora`, with an ownerless team opening only for a Masora admin.
- `hub/accounts.mjs:293-297`: `signInMasora`, a Google-style record keyed by email.
- `desktop/family.js:9,338-378`: consumes `zevet.credentials.json` in cloud mode and redeems its `hub` block
  (`#signInHub`, :388); `:220-222` heartbeat `masora.hub_email`.
- `desktop/main.js:1609` (main): `hubSignInFromMasora` writes the config as a key join does.

### The gap this change fills

- **Zevet <-> Voice on one machine, both directions.** Nothing on main shares a hub session between them; Voice's
  hub sign-in (`feat/signin`) was standalone.
- **Sign-out propagation.** None exists: Masora signing out only deletes the credentials files.
- **Apps that start later.** `<app>.credentials.json` is one-shot (consumed and deleted, 10 min), so an app that
  is not running misses it. `sso.json` is the durable, authenticated last-state record.
- **Masora -> Voice.** Gets through by chaining: Masora -> Zevet (D-906, unchanged) -> `sso.json` -> Voice.
  The one Zevet line added for it is the `sso.publish` after `hubSignInFromMasora`.

Why not extend the credentials-file mechanism (a `voice.credentials.json` written by Zevet): it is one-way,
one-shot, carries no sign-out, and holds the token in plain JSON protected only by its ACL. The two coexist:
Masora keeps issuing credentials files, and `sso.json` is the hub-session record shared by the hub's clients.

## Masora (usemasora.com cloud accounts) <-> hub identity

The hub already accepts Masora's signed assertion (D-906, see "Already exists"; `POST /auth/masora`, `hub/masora-auth.mjs`): HS256 over a
secret shared only by the Masora API (`ZEVET_HUB_SECRET`) and the hub (`ZEVET_MASORA_SECRET`), `typ`
`zevet_hub_assertion`, `aud` `zevet-hub`, 10 min, single-use `jti`. `accounts.mjs signInMasora` stores the person
as a Google-style record keyed by the asserted email, so a later Google sign-in with that email links to it.

**Exact trust assumption:** the hub treats the `email` in a Masora assertion as *verified*. That holds only if
every way a Masora `people.email` gets set proves control of that address. Today, as read in masora2:
Google requires `email_verified: true` (`apps/api/api/auth/google.py`); Entra work/school accounts take the UPN
or a mailbox on the tenant's verified domain and refuse guests (`microsoft.py`); invites store an admin-typed
address that the login flow "upgrades in place" (`invites.py`; not traced here whether the stored email is then
the signed-in one or stays the typed one). **Open:** that, and the
personal Microsoft account (MSA) branch takes Graph `mail or userPrincipalName` with no explicit verified flag.
Until that is confirmed or tightened, an MSA-only Masora person's email is the weakest link in auto-linking.

Rules for any follow-up: link on a verified email only; never auto-link on an unverified or merely public-profile
email (the hub's `verifiedEmails` already drops those); never create a Masora account from a hub identity, only
match an existing person.

## Threat model

| Threat | Outcome |
|---|---|
| Another local user | Cannot read `family.key` (ACL / 0600) or, by default, the family dir under their own profile. Even with a writable dir, cannot forge an envelope (GCM) and cannot read a token. |
| Another process of the same user | Out of scope, and stated: it can read `family.key`, DPAPI blobs and Zevet's `config.json` anyway. OS user = trust boundary, same as today. |
| Stale envelope | Older than the newest applied: ignored. A token revoked since: whoami refuses it. |
| Forged envelope (no key) | Fails authentication: ignored, never overwritten by a seed, never sent anywhere. |
| Envelope naming another hub | Ignored; the token is never sent to a hub other than the app's own. |
| Replay of an old, genuine envelope | Ignored while the app runs (`issued_at` <= seen). After a restart it can be re-applied once, and only if the hub still accepts that token, which means a session that really was signed in on this machine and whose hub logout never landed. Writing the file at all needs write access to the user's profile. |
| Future-dated envelope (would freeze others) | Rejected beyond 60 s skew. |
| Session fixation (attacker's token planted) | Needs `family.key`, so needs the user's own account (row 2). |
| Lost sign-out (hub unreachable) | Local copies dropped; the hub token lives until its idle TTL. |

## Pre-existing gaps (not changed here)

- Zevet keeps its hub `session` and team `secret` in plain JSON (`~/.zevet/config.json`, 0600 / inherited
  user ACL) because the CLI hooks read that file. An adopted session lands there too, exactly like Zevet's own
  sign-in. Moving it to safeStorage means changing `client/secret.mjs` and every hook reader; that is its own
  change.
- Masora's `<app>.credentials.json` hand-off is plain JSON, ACL'd to the user, deleted on consume, valid for
  10 min.

## Masora follow-up spec (not implemented: needs masora2 changes plus hub and Masora API deploys)

The Masora-side gap, ordered smallest first. (1)-(3) extend D-906 and do not replace it. Only (2) and (3) are
needed for "log into one, logged into all three" between Masora and Voice and for sign-out from Masora; (4) is
the reverse direction and needs a decision from Andrew first.

1. **Move `desktop/sso.js` into `@masora/desktop-kit`** as `kit.sso` (new tag, never move an existing one), and
   bump Zevet. Masora's shell then uses the same code, not a copy.
2. **Masora signed in -> Voice, with no Zevet installed.** `apps/api/api/routers/family.py`
   `POST /family/cloud/credentials`: return `hub: {url, assertion}` for `app == "voice"` too (today `zevet` only).
   zevet-voice `family.consume_credentials`: redeem `hub.assertion` at `{hub.url}/auth/masora` (same-origin and
   https checks as Zevet's `#signInHub`), store via `hub._store`, then `hub._publish("signed_in", ...)`.
   `apps/desktop/shell/family-cloud.js`: D-906's `hub_email` re-issue rule (today `app !== "zevet"` short-circuits
   it) applies to voice as well, and Voice's heartbeat gains `masora.hub_email`. Contract:
   `docs/contracts/cross_app_context.md` "Hub sign-in" gains the voice case.
3. **Masora sign-out -> the others.** `apps/desktop/shell/family-cloud.js` `clear()` (the shell's sign-out):
   also `kit.sso.publish(dir, "signed_out", hubUrl)`. Masora does not hold a hub token, so it does not call
   `/auth/logout`; the apps that hold it do, on adoption.
4. **Zevet/Voice signed in -> Masora signed in (the reverse direction).** Needs a new assertion in the other
   direction, with its own secret (not reused) so an assertion can never be reflected back:
   - hub `hub/server.mjs`: `POST /auth/masora/assertion`, session-gated, returns an HS256 JWT `typ`
     `masora_hub_assertion`, `aud` `masora`, 5 min, `jti`, carrying only `verifiedEmails` of the caller
     (`accounts.mjs`). New env `ZEVET_TO_MASORA_SECRET`.
   - Masora `apps/api/api/auth/`: new route `POST /api/auth/zevet-hub` that verifies it (pinned alg/typ/aud,
     exp, single-use jti), matches an existing `people` row by email (exact, lowercase; refuse when it matches
     people in more than one workspace and none is chosen), and mints a normal Masora session. Never creates a
     person.
   - Masora shell `family-cloud.js`: when signed out and `sso.json` is a newer `signed_in`, ask the hub for that
     assertion (with the envelope's token, to the envelope's hub only) and redeem it.
   - Andrew decides whether a hub sign-in may sign someone into Masora at all; it raises the hub's sign-in to
     the level of a Masora login (including clinics' data in Masora).
5. Confirm or tighten the MSA email branch in `apps/api/api/auth/microsoft.py` before (4) ships.
