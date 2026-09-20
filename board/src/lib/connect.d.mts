export interface ConnectStateLike {
  phase?: string;
  code?: string;
  login?: string;
  message?: string;
}

export function connectPhaseLabel(phase: "idle" | "starting" | "waiting" | "done" | "fail"): string;
export function connectValue(phase: "idle" | "starting" | "waiting" | "done" | "fail", state: ConnectStateLike): string;
export const SIGNED_OUT: string;
export const SIGN_OUT_FAILED: string;
export function disconnectValue(phase: string): string;