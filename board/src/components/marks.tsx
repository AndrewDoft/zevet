import { AGENT_MARKS } from "../lib/roster.mjs";

export const FILE_SVG =
  '<svg class="ficon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">' +
  '<path d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5Z"/>' +
  '<path d="M9 1.5V5a.5.5 0 0 0 .5.5H13"/></svg>';

export function agentMark(agent: string | null | undefined) {
  const d = agent && AGENT_MARKS[agent];
  if (!d) return null;
  return <span className="mark" dangerouslySetInnerHTML={{ __html: d }} />;
}

export function agentBadge(agent: string | null | undefined) {
  return agentMark(agent) ?? <span className="bead" />;
}