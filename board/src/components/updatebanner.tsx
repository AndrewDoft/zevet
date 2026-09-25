/**
 * The small bar that appears when a downloaded update is ready.
 *
 * Andrew: "when you are in the middle of using the app it should just say
 * update available." UpdateRow already carries the quiet, always-there
 * status in the rail; this replaces the MODAL that used to interrupt at
 * exactly `phase === "ready"` with a non-blocking bar in the same spot a
 * modal would have grabbed focus from. "Restart now" installs and relaunches
 * (or, on Windows and a self-replacing Mac build, installs and relaunches);
 * "Close" only dismisses the bar — the update stays downloaded and verified,
 * and installs on quit instead (see desktop/app-update.js's installOnQuit).
 *
 * Dismissal is per-version, same as the dialog this replaces: `zStorage`
 * remembers the version string, not a single boolean, so a *newer* release
 * still shows its own bar.
 */
import { bridge, zStorage } from "../lib/bridge";
import { selectUpdates, useBoard } from "../lib/board";
import { useState } from "react";

const DISMISSED_KEY = "zevet.update.dismissed.v1";

function loadDismissed(): string {
  return zStorage.getItem(DISMISSED_KEY) || "";
}

function saveDismissed(version: string): void {
  zStorage.setItem(DISMISSED_KEY, version);
}

export function UpdateBanner() {
  const { state: s, installing, installError } = useBoard(selectUpdates);
  const [dismissedVersion, setDismissedVersion] = useState(loadDismissed);
  const hasInstall = Boolean(bridge.local && typeof bridge.local.updateInstall === "function");

  const version = s && s.phase === "ready" && s.canInstall === true && hasInstall ? s.version : undefined;
  if (!version || version === dismissedVersion) return null;

  return (
    <div className="update-toast" role="status">
      <div className="update-toast-row">
        <span className="update-toast-title">Update available</span>
        <button
          type="button"
          className="update-toast-btn"
          disabled={installing}
          onClick={() => {
            saveDismissed(version);
            setDismissedVersion(version);
          }}
        >
          Close
        </button>
        <button
          type="button"
          className="update-toast-btn update-toast-btn-primary"
          disabled={installing}
          onClick={() => useBoard.getState().updateInstall()}
        >
          {installing ? "Restarting…" : "Restart now"}
        </button>
      </div>
      {installError ? (
        <div className="update-toast-error" role="alert">
          {installError}
        </div>
      ) : null}
    </div>
  );
}
