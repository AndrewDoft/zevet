export const COMMENTS_KEY: string;
export interface Comment { id: string; author: string; text: string; createdAt: number; resolvedAt: number | null; replies: Array<{ author: string; text: string; at: number }>; index: number | null; line: number | null }
export function addComment(ydoc: any, Y: any, o: { author: string; text: string; index: number; id?: string; now?: number }): string;
export function replyTo(ydoc: any, id: string, o: { author: string; text: string; now?: number }): boolean;
export function setResolved(ydoc: any, id: string, resolved: boolean, now?: number): boolean;
export function listComments(ydoc: any, Y: any): Comment[];
export function exportUnresolved(list: Comment[], text: string, room: string): { room: string; comments: Array<{ id: string; author: string; line: number | null; lineText: string | null; text: string; replies: Array<{ author: string; text: string }> }> };
