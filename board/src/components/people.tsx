import { type CSSProperties, useEffect, useState } from "react";
import { hueOf, isIdle, selectRoster, serverNow, useBoard } from "../lib/board";
import type { RosterEntry } from "../lib/types";
import { agoText, currentOf, folderOf, missionOf, turnOf, verbFor } from "../lib/text";
import { agentBadge } from "./marks";

function expandedStored(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem("zevet.expanded.v1") || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function PersonDetail({ r, now }: { r: RosterEntry; now: number }) {
  const t = turnOf(r);
  const mission = missionOf(r);
  const cur = currentOf(r);
  return (
    <div className="person-detail" style={{ "--who": hueOf(r.actor) } as CSSProperties}>
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
        const lastAgent = r.lastEvent && r.lastEvent.agent;
        const last = r.lastEvent;
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
              {agentBadge(lastAgent)}
              <span>
                <span className="nm">{r.actor}</span>
                <span className="sub">
                  {idle ? (
                    agoText(now, r.lastTs)
                  ) : last ? (
                    <>
                      <span className="verb">{verbFor(last)}</span>
                      {"  "}
                      {folderOf(last)}
                    </>
                  ) : null}
                </span>
              </span>
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