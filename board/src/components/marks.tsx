import { AGENT_MARKS } from "../lib/roster.mjs";

export const FILE_SVG =
  '<svg class="ficon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">' +
  '<path d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5Z"/>' +
  '<path d="M9 1.5V5a.5.5 0 0 0 .5.5H13"/></svg>';

export function agentMark(agent: string | null | undefined) {
  /* An object lookup answers for the WHOLE PROTOTYPE CHAIN, and `agent` here
     is a string off a hub roster event — it comes from another machine. There
     are three own keys; "constructor" returns a function, "__proto__" returns
     Object.prototype, and both are truthy, so the `if (!d)` guard below let
     them straight into dangerouslySetInnerHTML. Own-property AND a string, in
     that order: the second is what actually keeps a non-string out of innerHTML
     and it is cheap enough to keep even though the first makes it unreachable
     today. */
  const d = agent && Object.hasOwn(AGENT_MARKS, agent) ? AGENT_MARKS[agent] : null;
  if (typeof d !== "string" || !d) return null;
  return <span className="mark" dangerouslySetInnerHTML={{ __html: d }} />;
}

export function agentBadge(agent: string | null | undefined) {
  return agentMark(agent) ?? <span className="bead" />;
}