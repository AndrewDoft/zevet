// The live claims, mine and the team's (D-070). The desktop seals, shares and
// opens them; this only holds what it is told and asks it to claim or release.
import { create } from "zustand";
import { bridge } from "./bridge";
import type { Claim, OverlapHit } from "./claims.mjs";
import type { Payer } from "./payer.mjs";

export const useClaims = create<{ claims: Claim[] }>(() => ({ claims: [] }));
/** Teammates' payers (D-073), opened by the desktop from sealed frames. */
/** Plan-step owners (D-NEXT-W2-9): who claimed which step of which session's plan. */
export type StepOwner = { session: string; step: string; actor: string };
export const useStepOwners = create<{ steps: StepOwner[] }>(() => ({ steps: [] }));
const normStep = (t: string) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 200);
/** The owner of each step, in step order; "" for an unclaimed one. Same key rule as desktop/step-claims.js. */
export function ownersOf(steps: StepOwner[], session: string | null | undefined, texts: readonly string[]): string[] {
  return texts.map((t) => (session ? steps.find((s) => s.session === session && normStep(s.step) === normStep(t))?.actor || "" : ""));
}
export const usePayers = create<{ payers: Payer[] }>(() => ({ payers: [] }));

let wired = false;
function wire() {
  const l = bridge.local;
  if (wired || !l || typeof l.onClaimsEvent !== "function") return;
  wired = true;
  l.onClaimsEvent((e) => {
    useClaims.setState({ claims: e.claims || [] });
    usePayers.setState({ payers: e.payers || [] });
    useStepOwners.setState({ steps: e.steps || [] });
  });
  void l.claims?.().then((r) => {
    if (r && r.ok) {
      useClaims.setState({ claims: r.claims });
      usePayers.setState({ payers: r.payers || [] });
      useStepOwners.setState({ steps: r.steps || [] });
    }
  });
}
wire();

/** The overlap notice above the composer: set while a prompt waits on a person. */
export const useOverlap = create<{ pending: { hits: OverlapHit[]; answer: (a: "send" | "cancel") => void } | null }>(() => ({ pending: null }));

export function askOverlap(hits: OverlapHit[]): Promise<"send" | "cancel"> {
  return new Promise((resolve) => {
    useOverlap.setState({ pending: { hits, answer: (a) => { useOverlap.setState({ pending: null }); resolve(a); } } });
  });
}

/** Claim one path for a session. Advisory: nothing is blocked either way. */
export async function claimPaths(root: string, paths: string[], session: string, auto = false): Promise<void> {
  await bridge.local?.claim?.({ root, paths, session, auto });
}

export async function releasePath(session: string, path?: string): Promise<void> {
  await bridge.local?.releaseClaims?.(session, path);
}
