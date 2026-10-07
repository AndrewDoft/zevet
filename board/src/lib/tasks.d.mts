export type Status = "todo" | "doing" | "done";
export type Role = "viewer" | "commenter" | "editor" | "owner";
export interface Link { kind: "path" | "agent"; ref: string }
export interface Comment { id: string; text: string; by: string; t: number }
export interface Card { id: string; title: string; owner: string; status: Status; link: Link | null; by: string; comments: Comment[] }
export interface TaskState { cards: Record<string, { f: Record<string, { v: unknown; t: number; by: string }>; c: Record<string, { text: string; by: string; t: number }> }> }
export type Op =
  | { op: "create"; id: string; title: string; owner?: string; link?: Link }
  | { op: "move"; id: string; status: Status }
  | { op: "assign"; id: string; owner: string }
  | { op: "edit"; id: string; title?: string; link?: Link | null }
  | { op: "remove"; id: string }
  | { op: "comment"; id: string; cid: string; text: string };
export const STATUSES: readonly Status[];
export const LIMITS: Readonly<Record<string, number>>;
export const NEED: Readonly<Record<string, Role>>;
export function may(role: Role | null | undefined, op: string): boolean;
export function emptyState(): TaskState;
export function merge(state: TaskState, delta: unknown, o: { roleOf: (login: string) => Role | null | undefined }): { state: TaskState; changed: boolean };
export function apply(state: TaskState, op: Op, o: { by: string; role: Role | null | undefined; now?: () => number }): { ok: true; state: TaskState; delta: TaskState } | { ok: false; error: string; role?: Role | null };
export function cards(state: TaskState): Card[];
export function encode(state: TaskState): Uint8Array;
export function decode(bytes: Uint8Array): TaskState | null;
export function newId(rand?: () => string, now?: () => number): string;
export function handoff(card: Card, role: Role | null | undefined): { ok: true; prompt: string; label: string } | { ok: false; error: string };
export function roomName(team?: string): string;
