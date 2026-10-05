/**
 * Error reporting for the board's own renderer realm.
 *
 * This file runs in TWO very different places: as the remote-origin page
 * inside Zevet's board window (a real BrowserWindow, preload-bridged, see
 * desktop/preload.js and desktop/main.js § openBoard), and — unmodified,
 * same bundle — as a plain web page for anyone who opens the hub in an
 * ordinary browser with no desktop app at all. `boot()` in ./board.ts only
 * calls `initBoardSentry` when `bridge.local` exists, which is exactly the
 * signal this codebase already uses elsewhere for "are we inside Zevet's own
 * Electron window" (see App.tsx's own `Boolean(bridge.local)`) — so a plain
 * browser visitor never gets a client at all, rather than one that quietly
 * never delivers anything.
 *
 * NO dsn/release/environment passed to `Sentry.init` here: as in desktop/
 * preload.js, those are deprecated on the renderer SDK because every event
 * is actually sent by the MAIN process's own client over IPC (desktop/
 * sentry.js owns the DSN, the scrubbing, and the release name). This file
 * only supplies per-report tags the main process cannot know on its own —
 * which member, which app version — via `setTag`, which the SDK's
 * `scopeToMainIntegration` forwards across the same IPC link.
 */
import * as Sentry from "@sentry/electron/renderer";

let initialized = false;

export function initBoardSentry(cfg: { actor?: string; version?: string } = {}): void {
  if (initialized) return;
  initialized = true;

  Sentry.init({ sendDefaultPii: false });
  Sentry.setTag("realm", "renderer-board");
  if (cfg.version) Sentry.setTag("app_version", cfg.version);
  if (cfg.actor) Sentry.setTag("member", cfg.actor);

  // ZEVET_SENTRY_TEST=1: desktop/main.js appends this to the board URL,
  // since a remote-origin page has no other way to learn a test run asked
  // for one deliberate, unmistakable event.
  if (new URLSearchParams(window.location.search).get("sentryTest") === "1") {
    Sentry.captureMessage("zevet sentry test");
  }
}
