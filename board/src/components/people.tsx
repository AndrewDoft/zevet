import { type CSSProperties, useEffect, useState } from "react";
import { hueOf, isIdle, selectRoster, serverNow, useBoard } from "../lib/board";
import type { RosterEntry } from "../lib/types";
import { agoText, currentOf, missionOf, turnOf } from "../lib/text";
import { SubagentList, type SubagentItem } from "./assistant-ui/elements/subagent-list";
import { AgentLogo } from "./brand";
import type { AgentState } from "./assistant-ui/elements/agent-status";

function expandedStored(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem("zevet.expanded.v1") || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** A teammate's state in the element's vocabulary. "failed" is deliberately
 *  never produced: the hub sees that somebody stopped, never why, and calling
 *  an idle teammate failed would be an invention. */
function stateOf(r: RosterEntry, idle: boolean): AgentState {
  if (idle) return "waiting";
  return r.lastEvent && r.lastEvent.kind === "turn_end" ? "done" : "working";
}

function PersonDetail({ r, now }: { r: RosterEntry; now: number }) {
  const t = turnOf(r);
  const mission = missionOf(r);
  const cur = currentOf(r);
  return (
    <div className="person-detail" style={{ "--who": hueOf(r.actor) } as CSSProperties}>
      {/* Whose tool they are running, in their own colour. The agent name is
          on the hub event (`HubEvent.agent`), so this is the mark of the
          thing actually running on their machine rather than a decoration —
          and it renders nothing for an agent with no honest logo, which is
          opencode, because it fronts a dozen providers. */}
      {r.lastEvent?.agent ? (
        <div className="person-agent">
          <AgentLogo agent={r.lastEvent.agent} hue={r.hue} className="size-3" />
          <span className="mono">{r.lastEvent.agent}</span>
        </div>
      ) : null}
      {mission ? <div className="mission">{mission}</div> : null}
      {cur ? (
        <div className="step">
          <span className="t">now</span>
          <span className="v mono">{cur}</span>
        </div>
      ) : null}
      {t.tools
        .slice(-7)
        .slice(0, -1)
        .map((e) => (
          <div className="step" key={e.id}>
            <span className="t">{e.tool || "tool"}</span>
            <span className="v mono">{e.target || e.detail || ""}</span>
          </div>
        ))}
      {!mission && !cur ? <span>{agoText(now, r.lastTs)}</span> : null}
    </div>
  );
}

export function PeoplePane() {
  const roster = useBoard(selectRoster);
  const selectedActor = useBoard((s) => s.selectedActor);
  const setSelectedActor = useBoard((s) => s.setSelectedActor);
  const [expanded, setExpanded] = useState<string[]>(() => expandedStored());
  const [now, setNow] = useState(() => serverNow());

  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(t);
  }, []);

  function toggleExpanded(actor: string, on: boolean) {
    const list = expanded.filter((x) => x !== actor);
    if (on) list.push(actor);
    setExpanded(list);
    try {
      localStorage.setItem("zevet.expanded.v1", JSON.stringify(list));
    } catch {
      // Private mode etc: expansion just does not persist.
    }
  }

  return (
    <div className="pane-body" id="people">
      {roster.map((r) => {
        const idle = isIdle(r, now);
        const open = expanded.indexOf(r.actor) >= 0;
        const state = stateOf(r, idle);
        const item: SubagentItem = { name: r.actor, model: r.lastEvent?.agent ?? "" };
        return (
          <div className="person-wrap" key={r.actor}>
            <button
              className="person"
              style={{ "--who": hueOf(r.actor) } as CSSProperties}
              data-idle={String(idle)}
              data-sel={String(selectedActor === r.actor)}
              aria-expanded={open}
              onClick={(ev) => {
                if (ev.shiftKey) {
                  setSelectedActor(selectedActor === r.actor ? null : r.actor);
                  return;
                }
                toggleExpanded(r.actor, !open);
              }}
            >
              {/* col-span-2 escapes .person's 10px/1fr badge grid now that
                  the row has one child, not a badge and a text column.
                  min-h-0 drops the element's 14.5rem floor, sized for a
                  standalone panel, not a rail row repeated per teammate.
                  Progress only fills at 100 on completion: nothing upstream
                  gives a fractional signal, and the spinner already reads
                  as "in progress" without one. */}
              <SubagentList
                className="col-span-2 min-h-0 w-full max-w-none"
                agents={[item]}
                completedCount={state === "done" ? 1 : 0}
                progress={[state === "done" ? 100 : 0]}
                showSummary={false}
                summaryAgent={item}
              />
            </button>
            {open ? <PersonDetail r={r} now={now} /> : null}
          </div>
        );
      })}
      {!roster.length ? (
        <div style={{ padding: "14px 16px", color: "var(--subtle)", fontSize: "12.5px" }}>nobody yet</div>
      ) : null}
    </div>
  );
}
