/**
 * Who pays (D-073): one small muted line saying whose account a turn bills.
 * Unknown renders nothing. The label is text, never markup.
 */
"use client";

import { selectActiveConsole, useBoard } from "../lib/board";
import { usePayers } from "../lib/claimstore";
import { billsLine, payerOfActor, payerOfSession } from "../lib/payer.mjs";

/** `who` "" is the reader. */
export function PayerNote({ who = "", label }: { who?: string; label: string }) {
  const line = billsLine(who, label);
  if (!line) return null;
  return (
    <span data-payer={label} className="text-foreground/45 text-xs">
      {line}
    </span>
  );
}

/** The payer of a teammate's session (or, with none yet, of their machine's login for an engine). */
export function useTeammatePayer(actor: string, session: string, agent = ""): string {
  const payers = usePayers((s) => s.payers);
  return payerOfSession(payers, actor, session) || (session ? "" : payerOfActor(payers, actor, agent));
}

/** Above my composer: which of my accounts the next message bills. */
export function ComposerPayer() {
  const label = useBoard((s) => selectActiveConsole(s)?.payer) || "";
  if (!label) return null;
  return (
    <div data-slot="composer-payer" className="px-4 pt-1.5">
      <PayerNote label={label} />
    </div>
  );
}

/** On a teammate's agent card: just the label, muted. Unknown renders nothing. */
export function TeamPayer({ actor, session, agent }: { actor: string; session?: string; agent: string }) {
  const label = useTeammatePayer(actor, session || "", agent);
  if (!label) return null;
  return (
    <div data-team-payer={label} className="agent-row-detail pl-[34px]" title={`Bills ${actor}`}>
      {label}
    </div>
  );
}
