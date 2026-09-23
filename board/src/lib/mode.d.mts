export const MODE_KEY: string;
export const LAST_CHAT_KEY: string;
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
export function readMode(storage: Store, chatAvailable: boolean): "code" | "chat";
export function writeMode(storage: Store, mode: "code" | "chat"): void;
export function readLastChat(storage: Store): string | null;
export function writeLastChat(storage: Store, id: string | null): void;
