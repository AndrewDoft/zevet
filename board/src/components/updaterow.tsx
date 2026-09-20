import { useBoard, selectUpdates } from "../lib/board";
import { bridge } from "../lib/bridge";
import { updateCommand, updatePercent, updateStatusText } from "../lib/update.mjs";

function UpdateBar({ phase }: { phase: "downloading" | "ready" }) {
  const s = useBoard(selectUpdates).state;
  if (phase === "downloading") {
    const pct = updatePercent(s);
    return (
      <div className="bar" role="progressbar" aria-label="Update download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <i style={{ width: pct + "%" }} />
      </div>
    );
  }
  return null;
}

export function UpdateRow() {
  const { state: s, checking, installing, installError, notice } = useBoard(selectUpdates);
  const show = s && (s.phase === "downloading" || s.phase === "ready" || s.phase === "error");
  if (!show) return null;

  const up = { checking, installing };
  const message = installError || notice;
  const hasCheck = Boolean(bridge.local && typeof bridge.local.updateCheck === "function");
  const hasInstall = Boolean(bridge.local && typeof bridge.local.updateInstall === "function");
  const cmd = updateCommand(s, up, { hasCheck, hasInstall });

  return (
    <div className="updaterow" id="updateRow">
      <div className="hd">{updateStatusText(s, up)}</div>
      {s.phase === "downloading" ? (
        <UpdateBar phase="downloading" />
      ) : cmd ? (
        <>
          {s.notes ? <div className="sub">{s.notes}</div> : null}
          {cmd.kind === "check" ? (
            <button className="go" type="button" disabled={cmd.disabled} onClick={() => useBoard.getState().updateCheck()}>
              {cmd.label}
            </button>
          ) : (
            <button
              className="go"
              type="button"
              disabled={cmd.disabled}
              onClick={() => useBoard.getState().updateInstall()}
            >
              {cmd.label}
            </button>
          )}
        </>
      ) : null}
      {message && message !== s.error ? (
        <div className="sub" role={installError ? "alert" : "status"} style={installError ? { color: "var(--alert)" } : undefined}>
          {message}
        </div>
      ) : null}
    </div>
  );
}