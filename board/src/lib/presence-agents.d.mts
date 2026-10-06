import type { Range } from "./presence.mjs";
export class AgentPresence {
  constructor(d: { Y: any; Awareness: any; awarenessProtocol: any; ydoc: any; awareness: any; send: (bytes: Uint8Array) => void; ttlMs?: number; setTimeout?: any; clearTimeout?: any });
  show(range: Range & { actor: string; agent: string; tool: string }, color: string): void;
  hide(id: number): void;
  clear(): void;
}
