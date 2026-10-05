import type { EventLike } from "./roster.d.mts";

export type AgentRow = {
  key: string;
  actor: string;
  machine: string;
  agent: string;
  repo: string;
  branch: string;
  session: string;
  firstTs: number;
  lastTs: number;
  mission: string;
  current: string;
  ended: boolean;
  state?: "working" | "idle" | "finished";
};
export function agentKey(e: EventLike & { session?: string; agent?: string; machine?: string; branch?: string }): string;
export function foldAgent(map: Map<string, AgentRow>, e: unknown): AgentRow | null;
export function agentsOf(events: unknown[], now: number, idleAfterMs?: number): AgentRow[];
export function withState(list: AgentRow[], now: number, idleAfterMs?: number): AgentRow[];
