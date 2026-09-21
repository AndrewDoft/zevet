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

## INSUF-004 — No macOS build had ever been launched — **LARGELY RESOLVED 2026-09-18**

**What was missing.** Apple silicon hardware. The `.dmg` was verified to be a well-formed
disk image and nothing more, and the first person to find out whether it ran would have been
Michael or Kai.

**Resolved by using the Mac that was already available.** A `macos-latest` GitHub runner IS a
Mac. `.github/workflows/build.yml` now mounts the built image, inspects the bundle, and
launches the app, failing the job if it is not still alive twelve seconds later. Observed on
run 35407744201:

```
== bundle: /tmp/zevetdmg/zevet.app
   Format=app bundle with Mach-O thin (arm64)
   CodeDirectory v=20400 flags=0x20002(adhoc,linker-signed)
   Signature=adhoc      TeamIdentifier=not set
node inside the bundle: v22.19.0
   STILL RUNNING after 12s (pid 12650) — it launches
```

The launch log was empty: it starts clean, not crashing-but-slowly.

**What is still NOT proven, and is why this says "largely":**

1. **That the UI is usable.** The process stays up; nobody has looked at a window.
2. **What a real recipient sees from Gatekeeper.** The runner BUILT its copy, so the file
   carries no `com.apple.quarantine` attribute. A downloaded copy does, and that is the path
   that produces "zevet can't be opened because Apple cannot check it for malicious
   software". `spctl` on the runner reported *"code has no resources but signature indicates
   they must be present"* — a rejection, but not the same rejection a download gets.
3. The signature is ad-hoc and linker-generated: `Identifier=Electron`, not
   `com.andrewdoft.zevet`, and no team identifier. That is what unsigned means here.

**Smallest action to close the rest.** One teammate opens the downloaded `.dmg` and says what
the screen showed. Two minutes, and it also closes INSUF-003.

**Still blocked on a second person.** The roster, collision detection and per-user colour
coding have only ever been exercised with one participant on one machine.

---

## INSUF-005 — codex's `exec --json` vocabulary has never been observed here — **CLOSED 2026-09-21**

**Blast radius: MEDIUM — a codex user sees a degraded transcript, not a broken board.**

**What is missing.** A machine with codex installed and signed in, and one recorded
turn of `codex exec --skip-git-repo-check --json`. codex is not on the PATH of the
machine `board/src/lib/transcript.mjs` was written on, and no recorded `--json`
output exists anywhere in this repository — `test/codex.test.mjs` covers hook
installation and trust, not the streaming vocabulary.

**What this means for the code.** `fromClaude` and `fromOpencode` in
`transcript.mjs` are written against measurements (claude's `stream-json` is the
shape the console has consumed since it existed; opencode's was measured
2026-09-19, recorded in `agent-console.js` § send fact 5). `fromCodex` is written
against codex's *documented* event names — `item.started`/`item.completed` with an
`item.type` of `agent_message`, `reasoning` or `command_execution`, plus
`turn.completed`/`turn.failed`. That is reasoning, not observation, and it is the
one branch of the three that could be simply wrong.

**Why it fails safely.** `appendAgentPayload` renders any payload it does not
recognise as a `[codex: <type>]` line rather than dropping it. So a wrong table
costs fidelity — a command shows as a line instead of a tool card — and never
costs the event itself. The transcript still moves, and the real event names
appear in it, which is the measurement.

### How it closed

codex WAS installed on this machine all along — at
`%LOCALAPPDATA%/OpenAI/Codex/bin/<hash>/codex.exe`, which is not on the PATH,
which is why `command -v codex` said nothing and why this note said the machine
did not have one. zevet's own `client/detect.mjs` finds it (it globs that
directory on purpose) and reported it installed and signed in the whole time.

Two turns were captured 2026-09-21 against codex-cli 0.155.0-alpha.2.6: a
trivial reply, and one that wrote a file and ran a command. The table in
`transcript.mjs` was mostly right, and wrong in three ways that the capture
found:

1. **`error` arrives as an ITEM, not a top-level event**, and is not
   necessarily fatal — the captured one was a mid-turn notice about skill
   descriptions being shortened, with the turn completing normally. The table
   fell through it to `return state`, which DROPPED it silently. That is the
   one failure mode this whole file is organised around, and it was sitting in
   the branch written to avoid it.
2. **`file_change` carries `changes[].path`**, and passing the array straight
   through as `args` left the Edit card with no file name on it.
3. **usage says `cached_input_tokens`**, not claude's
   `cache_read_input_tokens`, and it is a SUBSET of `input_tokens` rather than
   a sibling of it. `usageOf` in board.ts matched neither spelling, so every
   codex turn read as a 0% cache hit — wrong, and wrong in the flattering
   direction. Adding them would have over-counted the window by 59%.

The full observed vocabulary is now written into the header comment of
`fromCodex`, with the note that it is a measurement and the date it was taken.

**Smallest action that unblocks it.** On a machine with codex signed in: start a
codex console from the board, run one turn, and read the `[codex: …]` lines. Each
one names an event the table does not handle. Correct the table from them and
record the shapes in `docs/contracts/`. Ten minutes.

**What it blocks.** Nothing ships on it — it is fidelity for one of three agents.
It should be closed before codex is described anywhere as fully supported.
