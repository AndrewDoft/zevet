# Zevet 0.2.94 worker report

- Branch: `z94/agent-hooks`
- Commits: `0762a64` (`feat: report launched claude agents to hub`); report commit follows.
- Changed Claude launches to pass bundled hook settings for `UserPromptSubmit`, `PreToolUse` (`*`), and `Stop`, using the origin repo root and skipping when the repo already has `--zevet-hook`.
- Added shared hook command quoting and regression coverage for masora2-like and already-wired repos. Codex and OpenCode are unchanged.
- Mutation: added the argv/settings tests, ran `node --test test/agent-console.test.mjs`, and observed the new settings test fail because `--settings` was absent; restored the implementation and observed 46/46 pass.
- Full suite: `node scripts/run-tests.mjs` exited 0 — 2,737 passed, 0 failed, 0 cancelled, 7 skipped.
- Not verified: a real Claude CLI run against a scratch hub; no Claude credentials/agent execution was used. Packaged desktop runtime was not built.
