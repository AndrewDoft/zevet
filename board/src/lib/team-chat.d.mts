export type Role = "viewer" | "commenter" | "editor" | "owner";
export interface Msg { id: string; text: string; by: string; t: number; replyTo?: string; cardId?: string }
export interface ChatState { msgs: Record<string, { text: string; by: string; t: number; replyTo?: string; cardId?: string }> }
export type Op = { op: "post"; id: string; text: string; replyTo?: string; cardId?: string };
export const LIMITS: Readonly<Record<string, number>>;
export const NEED: Readonly<Record<string, Role>>;
export function may(role: Role | null | undefined, op: string): boolean;
export function emptyState(): ChatState;
export function merge(state: ChatState, delta: unknown, o: { roleOf: (login: string) => Role | null | undefined }): { state: ChatState; changed: boolean };
export function apply(state: ChatState, op: Op, o: { by: string; role: Role | null | undefined; now?: () => number }): { ok: true; state: ChatState; delta: ChatState } | { ok: false; error: string; role?: Role | null };
export function messages(state: ChatState): Msg[];
export function countByCard(state: ChatState): Record<string, number>;
export function unread(state: ChatState, lastRead: number | null | undefined, me: string): number;
export function readMark(state: ChatState): number;
export function mentions(text: string, names: string[]): boolean;
export function raiseMentions(state: ChatState, ctx: { names: string[]; me: string; lastRead: number; seen: Set<string>; notifier: { notify(n: { kind: "attention"; label: string; reason: string; key: string }): boolean } }): number;
export function encode(state: ChatState): Uint8Array;
export function decode(bytes: Uint8Array): ChatState | null;
export function newId(rand?: () => string, now?: () => number): string;
export function roomName(team?: string): string;
