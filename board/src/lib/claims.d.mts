export interface Claim { actor: string; session: string; repo: string; paths: string[]; expiresAt: number; mine: boolean }
export interface OverlapHit { actor: string; session: string; label: "overlapping" | "adjacent"; claimed?: boolean }
export function repoNameOf(root: string | null | undefined): string;
export function chipText(paths: string[]): string;
export function claimedBySession(claims: Claim[], session: string | undefined | null): string[];
export function claimOfPath(claims: Claim[], path: string, repo?: string): Claim | null;
export function pathsIn(text: string): string[];
export function gateSend(check: () => Promise<OverlapHit[]>, ask: (hits: OverlapHit[]) => Promise<"send" | "cancel">): Promise<boolean>;
export function hitLine(h: OverlapHit): string;
