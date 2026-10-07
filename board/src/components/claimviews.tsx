// The claim pieces that read the live stores. The drawing is in claims.tsx,
// which touches no store so it renders anywhere (tests included).
import { claimedBySession } from "../lib/claims.mjs";
import { useClaims, useOverlap } from "../lib/claimstore";
import { ClaimChip, OverlapNoticeView } from "./claims";

/** The chip for one session, read from the live claims. */
export function SessionClaimChip({ session }: { session?: string | null }) {
  const claims = useClaims((s) => s.claims);
  return <ClaimChip paths={claimedBySession(claims, session)} />;
}

export function OverlapNotice() {
  const pending = useOverlap((s) => s.pending);
  if (!pending) return null;
  return <OverlapNoticeView hits={pending.hits} onSend={() => pending.answer("send")} onCancel={() => pending.answer("cancel")} />;
}
