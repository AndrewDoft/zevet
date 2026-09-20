/** Labels and status lines for the Settings GitHub connect/disconnect rows.
 *  Pure JavaScript so the gate tests execute this exact file. */

export function connectPhaseLabel(phase) {
  return phase === "starting" ? "Starting\u2026" :
    phase === "waiting" ? "Cancel" :
    phase === "done" ? "Connect GitHub" :
    phase === "fail" ? "Retry" : "Connect GitHub";
}

export function connectValue(phase, p) {
  if (phase === "waiting") return "Approve on GitHub: " + p.code;
  if (phase === "done") return "Signed in as @" + p.login + ".";
  if (phase === "fail") return p.message || "";
  return "";
}

export const SIGNED_OUT = "Signed out.";
export const SIGN_OUT_FAILED = "Could not sign out.";

export function disconnectValue(phase) {
  return phase === "done" ? SIGNED_OUT : phase === "fail" ? SIGN_OUT_FAILED : "";
}