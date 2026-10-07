# Zevet Wave 2 overlap check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish local overlap warnings and encrypted advisory path claims through IPC, board UI, activity relay, and generated payloads.

**Architecture:** The desktop main process exposes local overlap classification and claim operations through the generated IPC table. The board checks before dispatch and renders a compact confirmation; claims use the existing AES-GCM document key and activity SSE as opaque relay frames, with local expiry and UI projections.

**Tech Stack:** Node test runner, Electron IPC table, React/TypeScript board, existing `client/doc-crypto.mjs` AES-GCM, Node HTTP/SSE hub.

**Spec:** `C:/Users/andre/AppData/Local/Temp/claude/C--dev-GitHub-masora2/4d40d2c7-dc6f-416a-89b4-291554aca579/scratchpad/zv-overlap.md`

## Global Constraints

- Similarity is local via `desktop/embedder.js`; never a remote model.
- The hub relays encrypted activity and never receives plaintext paths.
- Claims never block writes and expire on session end or timeout.
- UI copy is compact zevet copy with no explanation text.
- Record the thresholds and integration decisions as D-070; run full tests and clean-main comparison; rebuild `hub/public`.

## Review Focus

- Missing/failed embedder must fail open with no composer delay or warning UI.
- Same branch/path claims must classify overlapping even with no embeddings.
- Cancel must not dispatch; Send anyway dispatches exactly once.
- A hub-captured claim frame must contain no plaintext path.
- Expired/session-ended claims must disappear from card/tree projections.

### Task 1: IPC and local claim service

**Files:** `desktop/ipc-table.js`, `desktop/main.js`, generated preload/types, `test/ipc-table.test.mjs`, new integration tests.

- Add `overlapCheck` and `claim`/`releaseClaims` calls to the table.
- Implement main handlers using `classifyOverlap`, `embedder` locally, and an in-memory session claim store.
- Test generated IPC and fail-open behavior.

### Task 2: Composer gate

**Files:** `board/src/lib/runtime.tsx`, board styles/components, `test/overlap-composer.test.mjs`.

- Run the local IPC check on the dispatch path.
- Hold hits in compact inline UI and continue only after Send anyway; cancel drops the pending text.
- Keep no-hit dispatch immediate and preserve slash/steer behavior.

### Task 3: Encrypted activity claims and projections

**Files:** `client/activity.mjs`, `hub/server.mjs`, `board/src/lib/board.ts`, `board/src/components/tree.tsx`, card/people component, `test/activity.test.mjs`, `test/claims.test.mjs`, hub tests.

- Seal claim frames with the existing document key and relay them as activity events without decoding at the hub.
- Open frames on desktop/board, update claim state, expire by timeout/session end, and project chips/markers.
- Prove the hub never sees clear paths.

### Task 4: Decision, verification, bundle, and delivery

- Rename the colliding decision entry to D-070.
- Run `npm ci` in `desktop/` if needed, `npm run ipc:gen`, `npm run ipc:check`, full suite and typecheck.
- Run the same failures against a clean `origin/main` worktree.
- Rebuild board bundle, commit named files only, verify ancestry, and push `feat/overlap-check`.
