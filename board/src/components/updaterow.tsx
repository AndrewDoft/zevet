/**
 * The update row in the rail.
 *
 * An app update really is a staged job — check, download, verify, install —
 * and the hand-rolled `<div class="bar"><i style="width:%"></div>` said only
 * "some of it has happened". The registry's JobProgress names the stage it is
 * in, which is the difference between a stall you can wait out and one you
 * cannot: a download that stopped at 60% and a checksum that is taking its
 * time look identical on a bare bar.
 *
 * The install prompt stays a plain button. Installing exits the app and brings
 * it back on the new version, and that is not a thing to bury in a card.
 */
import { JobProgress } from "./assistant-ui/elements/job-progress";
import { ErrorState } from "./assistant-ui/elements/error-state";
import { useBoard, selectUpdates } from "../lib/board";
import { bridge } from "../lib/bridge";
import { updateCommand, updatePercent, updateStatusText } from "../lib/update.mjs";

/** The stages an update actually goes through, weighted by how long each one
 *  takes. The download is ~117 MB and everything else is seconds. */
const STAGES = [
  { name: "check", weight: 1 },
  { name: "download", weight: 12 },
  { name: "verify", weight: 2 },
  { name: "install", weight: 1 },
];

export function UpdateRow() {
  const { state: s, checking, installing, installError, notice } = useBoard(selectUpdates);
  const show = s && (s.phase === "downloading" || s.phase === "ready" || s.phase === "error");
  if (!show) return null;

  const up = { checking, installing };
  const message = installError || notice;
  const hasCheck = Boolean(bridge.local && typeof bridge.local.updateCheck === "function");
  const hasInstall = Boolean(bridge.local && typeof bridge.local.updateInstall === "function");
  const cmd = updateCommand(s, up, { hasCheck, hasInstall });

  if (s.phase === "downloading") {
    const pct = updatePercent(s);
    return (
      <div className="updaterow" id="updateRow">
        <JobProgress
          title={updateStatusText(s, up)}
          stages={STAGES}
          stageIndex={installing ? 3 : 1}
          stageProgress={pct / 100}
          eta={s.version ? `v${s.version}` : ""}
        />
      </div>
    );
  }

  return (
    <div className="updaterow" id="updateRow">
      {s.phase === "error" ? (
        <ErrorState
          title={updateStatusText(s, up)}
          detail={s.error || "The update could not be fetched."}
          retrying={Boolean(checking)}
          onRetry={() => useBoard.getState().updateCheck()}
        />
      ) : (
        <div className="hd">{updateStatusText(s, up)}</div>
      )}

      {cmd ? (
        <>
          {s.notes ? <div className="sub">{s.notes}</div> : null}
          <button
            className="go"
            type="button"
            disabled={cmd.disabled}
            onClick={() =>
              cmd.kind === "check" ? useBoard.getState().updateCheck() : useBoard.getState().updateInstall()
            }
          >
            {cmd.label}
          </button>
        </>
      ) : null}

      {message && message !== s.error ? (
        <div
          className="sub"
          role={installError ? "alert" : "status"}
          style={installError ? { color: "var(--alert)" } : undefined}
        >
          {message}
        </div>
      ) : null}
    </div>
  );
}
