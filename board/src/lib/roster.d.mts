export type RosterEntryLike = { actor: string; lastEvent?: { repo?: string } | null } | null | undefined;
export type EventLike = {
  actor?: string;
  kind?: string;
  tool?: string;
  target?: string | null;
  detail?: string;
  repo?: string;
} | null;

export function clampPaneWidth(v: unknown, min: number, max: number): number;
export function newestHunk(hunks: Array<{ start?: number }> | undefined): { start: number } | null;
export function followAllows(mode: string, actor: string, myActor: string | null | undefined): boolean;
export function lastToolFor(events: EventLike[], repoName: string, relPath: string): EventLike | null;
export function spritesByPath(
  events: EventLike[],
  opts: {
    repoName: string | null | undefined;
    followMode: string;
    myActor: string | null | undefined;
    now: number;
    idleAfterMs: number;
  },
): Record<string, { actor: string; tool: string | undefined; ts: number }>;
export function turnTrace(events: EventLike[], actor: string): {
  prompt: EventLike | null;
  tools: EventLike[];
  ended: boolean;
};
export function turnSummary(
  entry: { actor: string } | null | undefined,
  events: EventLike[],
): { mission: string; current: string };
export function verbFor(e: EventLike | null | undefined): string;
export function folderOf(e: EventLike | null | undefined): string;
export function ago(ms: number): string;
export function agoText(now: number, ts: number): string;
export function liveActorsOf(
  roster: RosterEntryLike[],
  repoName: string | null | undefined,
): Array<{ actor: string; lastEvent?: { repo?: string } | null }>;
export const AGENT_MARKS: Record<string, string>;