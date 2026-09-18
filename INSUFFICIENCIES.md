# Insufficiencies

Open items, each with what is missing, what was tried and observed, the smallest action that
unblocks it, and what it blocks downstream (CLAUDE.md §6).

---

## INSUF-001 — GitHub Actions is billing-blocked, so the macOS `.dmg` cannot be built

**Opened 2026-09-18. Blast radius: HIGH — Michael and Kai cannot install zevet at all.**

**What is missing.** A working GitHub Actions entitlement on the `AndrewDoft` account.

**What was tried, and what was observed.** `.github/workflows/build.yml` was dispatched against
`main`:

```
$ gh workflow run build.yml --ref main
https://github.com/AndrewDoft/zevet/actions/runs/35369911483

$ gh api repos/AndrewDoft/zevet/actions/runs/35369911483/jobs
build (macos-latest, --mac, zevet-macos)     conclusion=failure  steps=0  (7s)
build (windows-latest, --win, zevet-windows) conclusion=failure  steps=0  (4s)
```

Zero steps ran on either job. The annotation states the cause directly:

> *The job was not started because recent account payments have failed or your spending limit
> needs to be increased. Please check the 'Billing & plans' section in your settings*

This is the same account-level block recorded as `INSUF-071` in the masora2 repo. It is not a
defect in the workflow, which was never reached.

**Why it cannot be worked around locally.** `electron-builder` cannot produce a `.dmg` on
Windows; the target requires macOS. There is no Mac in this session.

**Smallest action that unblocks it (human, ~2 minutes).** Open
<https://github.com/settings/billing> and either clear the failed payment or raise the Actions
spending limit. Then re-run:

```
gh workflow run build.yml --ref main
gh run watch
```

The macOS artifact appears as `zevet-macos` on the run.

**Alternative that costs nothing but changes something else.** Actions minutes are free for
**public** repositories. Making `AndrewDoft/zevet` public would unblock the build immediately.
The repo holds no secrets (the hub token lives in `/srv/zevet/.env` on the droplet and in
`~/.zevet/config.json`, never in git). But this is a product Andrew has said is his, and
publishing its source is his call, not a decision to take on his behalf.

**Blocks.** The macOS `.dmg`; therefore Michael and Kai connecting at all; therefore any
multi-user verification of the hub, the roster, collisions, or the per-user colour coding —
all of which have only ever been exercised with one participant.

---

## INSUF-002 — Codex hook trust has only been granted by bypass, never through the TUI

**Opened 2026-09-18. Blast radius: MEDIUM — the documented first-run instruction is untested.**

**What is missing.** A terminal. The interactive `codex` TUI could not be driven from this
session.

**What was observed.** Codex hooks do not run until hook trust is persisted, and
`codex exec` neither prompts for it nor warns that it is missing — a turn completes normally and
the hooks are simply skipped. Every successful firing recorded this session used
`--dangerously-bypass-hook-trust`, which is per-invocation and is not something zevet can or
should inject into a teammate's own runs.

The binary shows the intended path exists — `tui\src\startup_hooks_review.rs`,
`"Failed to trust hooks: "`, and persisted state as `hooks.state."<key>".trusted_hash` — but it
has not been seen working, so `install.mjs`'s instruction to "run `codex` once and accept the
trust prompt" is written from the binary's strings, not from observation.

**Smallest action that unblocks it (human, ~1 minute).** Run `codex` interactively once inside
`C:\dev\GitHub\zevet`, accept whatever hook-review prompt appears, quit, then run a normal turn
and check the board. If no prompt appears, that is the finding, and zevet must instead document
writing the trust entry by hand.

**Blocks.** Nothing already working — the connector itself is verified end to end. It blocks
only the claim that a *new* user can get Codex reporting without passing a dangerous flag.

---

## INSUF-003 — The POSIX Codex hook command has never been run

**Opened 2026-09-18. Blast radius: MEDIUM — affects both teammates, who are the macOS users.**

**What is missing.** A macOS or Linux machine.

**What was observed.** All seven command-shape experiments ran on Windows. The Windows form
(`cmd /c "<node>" "<hook>" ...`) is verified firing against the live hub. The POSIX branch
writes `<node> "<hook>" ...` directly, on the reasoning that node on macOS lives at an unspaced
path; the installer refuses to write that form at all if the node path contains a space, so the
failure mode is a loud refusal rather than a hook that silently never fires. That refusal path
is also untested.

**Smallest action that unblocks it.** On a Mac with Codex installed: run
`node client/install.mjs <repo>`, then a Codex turn, and check the board. Roughly five minutes
once INSUF-001 has put a build in their hands.

**Blocks.** Confidence that the Codex connector works for Michael and Kai specifically. The
Claude Code path on macOS is equally unexercised.
