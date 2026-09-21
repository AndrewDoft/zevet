/** Labels and status lines for the Settings connect/disconnect rows.
 *  Pure JavaScript so the gate tests execute this exact file. */

/**
 * How to name somebody in a sentence a person reads.
 *
 * A GitHub login wants its "@"; an email address already has one and gains
 * nothing from a second. Deciding by the string rather than by a provider
 * argument is safe because the two namespaces cannot overlap — GitHub usernames
 * may not contain "@" — and it means every call site that has a login can print
 * it correctly without also having to have carried the provider there.
 */
export function who(login) {
  const l = String(login || "");
  return l.includes("@") ? l : "@" + l;
}

/** `label` is the provider's name. It defaults to GitHub because that is what
 *  every existing caller means, and because these two functions are what the
 *  gate tests execute directly. */
export function connectPhaseLabel(phase, label = "GitHub") {
  return phase === "starting" ? "Starting…" :
    phase === "waiting" ? "Cancel" :
    phase === "fail" ? "Retry" : "Connect " + label;
}

export function connectValue(phase, p, label = "GitHub") {
  // ⚠️ THE WAITING LINE IS NOT THE SAME SENTENCE FOR BOTH PROVIDERS, and the
  // difference is the flow, not the wording: GitHub's device flow gives the
  // person a code to approve, Google's web flow gives them nothing to read
  // because the browser finishes it. A missing code is therefore the Google
  // case, not a bug to paper over with an empty string after a colon.
  if (phase === "waiting") return p.code ? "Approve on " + label + ": " + p.code : "Finish in your browser…";
  if (phase === "done") return "Signed in as " + who(p.login) + ".";
  if (phase === "fail") return p.message || "";
  return "";
}

export const SIGNED_OUT = "Signed out.";
export const SIGN_OUT_FAILED = "Could not sign out.";

export function disconnectValue(phase) {
  return phase === "done" ? SIGNED_OUT : phase === "fail" ? SIGN_OUT_FAILED : "";
}
