export const NOTIFY_KEY: string;
export const NOTIFY_DEFAULTS: { finished: boolean; attention: boolean };
export const BURST_MS: number;
export const BURST_SHOWN: number;
export type NotifyPrefs = { finished: boolean; attention: boolean };
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
export function readNotifyPrefs(storage: Store): NotifyPrefs;
export function writeNotifyPrefs(storage: Store, prefs: NotifyPrefs): void;
export function classifyAgentEvent(evt: unknown): { kind: "finished" | "attention"; reason: string } | null;
export function classifyRequest(type: "permit" | "ask"): { kind: "attention"; reason: string };
export function createNotifier(deps: {
  prefs(): NotifyPrefs;
  now(): number;
  schedule(fn: () => void, ms: number): unknown;
  show(n: { title: string; body: string; key: string }): void;
  viewing?(key: string): boolean;
  burstMs?: number;
  shown?: number;
}): { notify(n: { kind: "finished" | "attention"; label: string; reason: string; key: string }): boolean };
