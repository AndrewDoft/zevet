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
