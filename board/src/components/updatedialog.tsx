/**
 * The pop-up that asks whether to put a downloaded update on.
 *
 * Andrew: "users get an in-app pop-up to download a new version of the app
 * when it drops." updaterow.tsx already carries the quiet, always-there
 * status ("Downloading 47%", "Checking…") — this is the one moment that is
 * allowed to interrupt, and only that one moment: `phase === "ready"` means
 * the build is already on disk and verified (see app-update.js's `check()`),
 * so there is an actual decision to make. "checking" and "downloading" never
 * open this — telling someone a download is in progress is a notification,
 * not a decision, and the row already says it.
 *
 * Windows and macOS are NOT the same button, and this file does not decide
 * that by sniffing the platform — `state.manual` does (set in app-update.js's
 * constructor from `this.platform === "darwin"`, and it is what `install()`'s
 * darwin branch actually returns too). See D-006 and the header of
 * app-update.js: the macOS build is unsigned, so `install()` there only opens
 * the .dmg and hands back `{ ok: true, manual: true }` — the person still
 * drags the app across themselves, same as the first install. A button that
 * says "Install" and instead pops open a disk image is exactly the kind of
 * lie this codebase keeps removing, so both the button label and the
 * sentence beside it come from `update.mjs`'s `updateCommand`/
 * `updateStatusText` — the same two functions updaterow.tsx and settings.tsx
 * read, so this dialog cannot say something they don't already agree with.
 *
 * Dismissal is per-version: "Not now" (and Escape, and the backdrop, and the
 * dialog's own close button — all of them route through Dialog's
 * `onOpenChange`) remember the version string, not a single boolean, so a
 * *newer* release still interrupts. Storage is guarded try/catch exactly
 * like promptlib.tsx's saved-prompt read/write — a browser that refuses
 * localStorage must not take the dialog down, it should just ask again next
 * time.
 */
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { bridge } from "../lib/bridge";
import { selectUpdates, useBoard } from "../lib/board";
import { updateCommand, updateStatusText } from "../lib/update.mjs";

const DISMISSED_KEY = "zevet.update.dismissed.v1";

function loadDismissed(): string {
  try {
    return localStorage.getItem(DISMISSED_KEY) || "";
  } catch {
    return ""; // private mode / storage quota: falls back to "always ask"
  }
}

function saveDismissed(version: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    // the session still works, it just asks again next launch
  }
}

export function UpdateDialog() {
  const { state: s, checking, installing, installError } = useBoard(selectUpdates);
  const [dismissedVersion, setDismissedVersion] = useState(loadDismissed);

  const version = s && s.phase === "ready" ? s.version : undefined;
  const hasInstall = Boolean(bridge.local && typeof bridge.local.updateInstall === "function");
  const cmd = version && s ? updateCommand(s, { checking, installing }, { hasCheck: false, hasInstall }) : null;

  // Nothing downloaded and verified, nothing this build can install, or this
  // exact version was already sent away — nothing to say.
  if (!version || !cmd || version === dismissedVersion) return null;

  function dismiss() {
    saveDismissed(version!);
    setDismissedVersion(version!);
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next) dismiss(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{updateStatusText(s!, { checking, installing })}</DialogTitle>
          {s!.notes ? <DialogDescription>{s!.notes}</DialogDescription> : null}
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          {s!.manual
            ? "This build isn't signed, so it can't install itself: the disk image will open, and you drag Zevet into Applications, same as the first time."
            : "Installing quits Zevet and finishes on relaunch."}
        </p>

        {installError ? (
          <p role="alert" className="text-sm" style={{ color: "var(--alert)" }}>
            {installError}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={dismiss}>
            Not now
          </Button>
          <Button disabled={cmd.disabled} onClick={() => useBoard.getState().updateInstall()}>
            {cmd.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
