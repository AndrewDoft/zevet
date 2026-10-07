/** Invite into one session, and join one (D-090). The desktop seals and
 *  probes; the hub decides. Every failure is ONE sentence from the hub. */
import { bridge } from "./bridge";

export type ShareMode = "watch" | "comment" | "edit";
export const SHARE_MODES: ReadonlyArray<{ mode: ShareMode; label: string }> = [
  { mode: "watch", label: "Watch" },
  { mode: "comment", label: "Comment" },
  { mode: "edit", label: "Edit" },
];

export function canShare(): boolean {
  return typeof bridge.local?.sessionInvite === "function";
}

export async function inviteIntoSession(session: string, mode: ShareMode): Promise<{ ok: boolean; id?: string; error?: string }> {
  const fn = bridge.local?.sessionInvite;
  if (!fn) return { ok: false, error: "Update Zevet to invite" };
  try {
    return await fn(session, mode, "");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not invite" };
  }
}

export async function joinSession(id: string, mode?: ShareMode) {
  const fn = bridge.local?.sessionJoin;
  if (!fn) return { ok: false, error: "Update Zevet to join" };
  try {
    return await fn(id.trim(), mode);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not join" };
  }
}
