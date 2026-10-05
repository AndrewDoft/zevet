# Zevet Silent Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all update UI and make verified desktop updates install silently through lifecycle-safe triggers.

**Architecture:** Keep manifest/download/checksum logic in `desktop/app-update.js`, but make readiness immediately schedule installation and retry failures with bounded backoff. Remove renderer update state, components, styling, preload exposure, and IPC wiring; Settings retains only the current version.

**Tech Stack:** Electron main process, Node.js tests, React/TypeScript board.

**Spec:** User request in the task prompt.

## Global Constraints

- Never show update UI, notification, tray, or menu affordances.
- Never launch the packaged app or installer during verification on this PC.
- Preserve silent relaunch and console/window resume behavior already present in the app.
- Failed attempts retry with bounded backoff and never strand the install.

## Review Focus

- A ready verified artifact installs without renderer participation.
- Spawn errors do not quit the app and are retried.
- Resume/focus/quit triggers do not duplicate concurrent installs.
- Settings exposes version only.
- No stale update labels or IPC remain in shipped sources/tests.

### Task 1: Silent updater lifecycle

**Files:** Modify `desktop/app-update.js`, `desktop/main.js`, `test/app-update.test.mjs`.

- [ ] Add failing tests for auto-install on ready, bounded retry after spawn failure, and lifecycle trigger deduplication.
- [ ] Implement injected `installWhenReady`, retry backoff, `trigger`, and main-process focus/resume/quit wiring.
- [ ] Run focused updater tests.

### Task 2: Remove renderer update surfaces

**Files:** Modify `board/src/App.tsx`, `board/src/components/settings.tsx`, `board/src/lib/board.ts`, `board/src/lib/bridge.ts`, `board/src/lib/update.mjs`, `board/src/lib/update.d.mts`, `desktop/preload.js`, `test/board-updates.test.mjs`, `test/desktop-bridges.test.mjs`; delete `board/src/components/updaterow.tsx`, `board/src/components/updatedialog.tsx`.

- [ ] Add failing source-contract tests asserting no update bar/actions/IPC and version-only Settings.
- [ ] Remove update state/control code and all update bridge exposure.
- [ ] Remove update CSS and stale tests.
- [ ] Run board and bridge tests.

### Task 3: Full verification and release

- [ ] Run `node scripts/run-tests.mjs` with the ship environment.
- [ ] Commit named files, push, rebase, merge to main, and run the prescribed ship command.
- [ ] Verify the published manifest reports the shipped version.
