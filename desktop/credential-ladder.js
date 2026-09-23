// The pure decision behind "Auto" credential selection (D-0NN): given an
// ordered ladder of {credentialId, untilPct} steps and each credential's
// current plan utilization, which one does the next agent spawn with?
//
// Deliberately its own module with no Electron, no fetch, no fs: the choice
// itself is a few lines of arithmetic, and keeping it pure is what makes it
// unit-testable without a network or a keychain. Everything that FEEDS it a
// usage number — desktop/credential-usage.js's probe/cache — is a separate
// concern on purpose.
"use strict";

/**
 * Pick a credential id off the ladder, given each credential's current
 * utilization (a fraction 0..1, or absent when a probe failed or was never
 * taken).
 *
 * Walks the ladder in order and returns the first step whose credential is
 * BELOW its own ceiling: `utilization * 100 < untilPct`, strictly — hitting
 * a ceiling exactly rolls to the next rung, it does not stay put. A step
 * whose usage is unknown is SKIPPED, not treated as either empty or full:
 * there is nothing to compare, and the honest move is to try the next rung.
 * If nothing qualifies, the LAST step is used regardless of its own usage —
 * rotation has to land on something, and the last rung is the one the
 * person put there to catch that case.
 *
 * Returns null only for an empty ladder — there is nothing to choose.
 */
function choose(ladder, usageById) {
  const steps = Array.isArray(ladder) ? ladder : [];
  if (!steps.length) return null;

  for (const step of steps) {
    const usage = usageById ? usageById[step.credentialId] : undefined;
    if (usage === undefined || usage === null) continue;
    if (usage * 100 < step.untilPct) return step.credentialId;
  }
  return steps[steps.length - 1].credentialId;
}

module.exports = { choose };
