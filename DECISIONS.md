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
