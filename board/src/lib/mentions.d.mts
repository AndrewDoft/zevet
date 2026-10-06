export interface Mention {
  type: string;
  id: string;
}
export interface MentionItem {
  id: string;
  type: "user" | "agent";
  label: string;
  description?: string;
}
export type MentionSegment = { kind: "text"; text: string } | { kind: "mention"; type: string; label: string; id: string };
export function agentName(agent: string | null | undefined): string;
export function mentionCategories(o: {
  roster: ReadonlyArray<{ actor: string; idle?: boolean }>;
  agents: ReadonlyArray<{ key: string; actor: string; agent: string; ended?: boolean; mission?: string; repo?: string }>;
  myActor: string | null;
}): Array<{ id: string; label: string; items: MentionItem[] }>;
export function splitMentions(text: string): MentionSegment[];
export function mentionsOf(text: string): Mention[];
export function plainMentions(text: string): string;
