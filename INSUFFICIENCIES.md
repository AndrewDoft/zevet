# Insufficiencies

Open items, each with what is missing, what was tried and observed, the smallest action that
unblocks it, and what it blocks downstream (CLAUDE.md §6). Closed items keep their entry, with
the evidence that closed them.

---

## INSUF-001 — GitHub Actions billing-blocked, so no macOS `.dmg` — **RESOLVED 2026-09-18**

**Was:** every dispatched job failed in 4–7 seconds with `steps: 0` and the annotation *"The job
was not started because recent account payments have failed or your spending limit needs to be
increased."* Account-level, so both runners on a private repo. `electron-builder` cannot produce
a `.dmg` on Windows, so there was no local path around it.

**Resolved by making the repository public** — Actions minutes are free for public repos — under
a proprietary `LICENSE` that grants no rights (see `DECISIONS.md` D-003). History was scanned
for secrets before publishing: the hub token, SSH keys and credentials are absent from all 22
commits; the only token-shaped strings are secret-scrubbing test fixtures.

**Evidence:** run `35387047600`, both jobs `success`, artifacts `zevet-windows` (88,987,534 B)
and `zevet-macos` (110,131,957 B). The macOS artifact was downloaded and checked rather than
trusted: `zevet-0.1.1-macos-arm64.dmg`, 110,331,109 bytes, with a `koly` trailer in the last 512
bytes — a valid UDIF disk image.

**Still true, and not the same thing:** nobody has *launched* that `.dmg`. It builds and it is a
real disk image; that it runs on Apple silicon is INSUF-004.

---

## INSUF-002 — Codex hook trust could only be granted by a dangerous flag — **RESOLVED 2026-09-18**

**Was:** Codex will not run a hook until its trust is recorded, and says nothing when it is
missing — `codex exec` completes the turn and silently skips every hook, which is
indistinguishable from zevet being broken. Every firing observed used
`--dangerously-bypass-hook-trust`, which is per-invocation and is not something zevet can inject
into a teammate's own runs. The interactive TUI review could not be driven without a terminal.

**Resolved without the TUI.** `codex app-server` speaks newline-delimited JSON-RPC on stdio, and
`hooks/list` returns each hook's `key`, `currentHash` and `trustStatus`. Writing
`hooks.state.'<key>'.trusted_hash = "<currentHash>"` into `$CODEX_HOME/config.toml` flips the
hook to `trusted`. `client/codex-trust.mjs` does exactly that, and `install.mjs` calls it.

The hash is **read from Codex, never computed** — a guessed hash would be precisely the kind of
invention §4 forbids. Only entries carrying zevet's own `--zevet-hook` marker are trusted, so a
hook somebody else added keeps its review.

**Evidence:** trust block removed, `node client/install.mjs C:\dev\GitHub\zevet` printed
`trusted 3 zevet hooks`, and a plain `codex exec` with **no flags** then produced
`hook: UserPromptSubmit Completed`, `hook: Stop Completed` and two events on the live hub
(`codex | zevet | prompt`, `codex | zevet | turn_end`).

**Corrected along the way:** the note in `docs/contracts/codex-hooks.md` claimed project trust
(`[projects.'<path>'] trust_level`) was *also* required for hooks. That was read off a string in
the binary, not observed, and it is wrong — the hooks fire with the project reported untrusted.
The claim is retracted in place.

---

## INSUF-003 — The POSIX Codex hook command has never been run by Codex — **NARROWED, still open**

**Blast radius: MEDIUM — both teammates are the macOS users.**

**What is missing.** A macOS (or Linux) machine with Codex installed *and signed in*. CI runners
have no Codex, and a turn requires authentication, so the GitHub macOS runner cannot close this.

**What has changed.** It is no longer "never exercised at all":

- The POSIX branch is now generated and asserted under a forced `process.platform = "darwin"`:
  bare `/opt/homebrew/bin/node` as the program with no `cmd /c` wrapper and no quotes around it,
  the script path still quoted, and a **loud refusal** if the node path contains a space rather
  than a hook that would silently never fire.
- The full suite now runs on `macos-latest` every build and passes (237 tests). That covers
  `hook.mjs`, `local-fs`, the installer and the hub on macOS — it exposed two real macOS/CI
  defects the first time it ran, both fixed.

**What remains unverified.** That Codex *on macOS* resolves that command the way Codex on
Windows does. The parser is the same Rust binary and the shape follows the measured rule, but
that is reasoning, not observation.

**Smallest action that unblocks it.** On a Mac with Codex signed in: `node client/install.mjs
<repo>`, one Codex turn, check the board. Five minutes, once INSUF-004 is done.

---

## INSUF-004 — No macOS build has ever been launched — **OPEN**

**Blast radius: HIGH — it is the artifact the two teammates actually receive.**

**What is missing.** Apple silicon hardware. The `.dmg` is verified to be a well-formed disk
image and nothing more.

**What is known about what happens when they open it.** It is unsigned and unnotarised. macOS
will refuse it with *"zevet can't be opened because Apple cannot check it for malicious
software"*, and the recipient must right-click → Open, or clear the quarantine flag:

```
xattr -dr com.apple.quarantine /Applications/zevet.app
```

This is documented in `.github/workflows/build.yml` and was accepted deliberately — signing
needs an Apple Developer account at 99 USD/year.

**Smallest action.** Send the `.dmg` to one teammate, have them open it and report what the
screen said. That single report closes this and probably INSUF-003 with it.

**Blocks.** Everything multi-user. The roster, collision detection and per-user colour coding
have only ever been exercised with one participant on one machine, so none of them can be
called verified.
