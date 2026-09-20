import { scoped } from "./board";
import { turnTrace } from "./roster.mjs";
import type { HubEvent, RosterEntry } from "./types";

export { ago, agoText, folderOf, verbFor } from "./roster.mjs";

export function hhmm(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

export interface Turn {
  prompt: HubEvent | null;
  tools: HubEvent[];
  ended: boolean;
}

/** Everything since the actor's most recent prompt. */
export function turnOf(r: RosterEntry): Turn {
  const t = turnTrace(scoped(), r.actor);
  return { prompt: t.prompt as HubEvent | null, tools: t.tools as HubEvent[], ended: t.ended };
}

export function missionOf(r: RosterEntry) {
  const t = turnTrace(scoped(), r.actor);
  if (!t.prompt || !t.prompt.detail) return "";
  return String(t.prompt.detail).slice(0, 80);
}

export function currentOf(r: RosterEntry) {
  const t = turnTrace(scoped(), r.actor);
  const e = t.tools[t.tools.length - 1];
  if (!e) return t.ended ? "turn finished" : "";
  return (e.tool || "tool") + (e.target || e.detail ? "  " + (e.target || e.detail) : "");
}