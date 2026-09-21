import { type CSSProperties, memo, useEffect, useState } from "react";
import { hueOf, isIdle, selectRoster, serverNow, useBoard } from "../lib/board";
import type { RosterEntry } from "../lib/types";
import { agoText, currentOf, missionOf, turnOf } from "../lib/text";
import { SubagentList, type SubagentItem } from "./assistant-ui/elements/subagent-list";
import { AgentLogo } from "./brand";
import { SessionsPane } from "./sessions";
import { bridge } from "../lib/bridge";
import { HUES } from "../lib/constants";
import type { AgentState } from "./assistant-ui/elements/agent-status";

/** Somebody the hub lets in who has not sent an event yet.
 *
 * ⚠️ THE ROSTER AND THE ALLOWLIST ARE DIFFERENT LISTS AND ALWAYS WERE. The
 * roster (`selectRoster`) is folded out of the live event stream, so a
 * teammate only appears in it once their machine has actually run something.
 * The allowlist (`/auth/whoami` → `people`) is who the owner has let in, and
 * carries `pending: !a.id` — no GitHub id means they were invited and have
 * never signed in. Until now only Settings → Account read it, so People could
 * not answer the one question you ask it after sending an invitation.
 *
 * `pending` is the honest boundary: false means they signed in, which is the
 * acceptance. It does NOT mean they are running anything — that is what a
 * roster row means, and anyone with one is filtered out below. */
function TeammateRow({ login, invited, hue }: { login: string; invited: boolean; hue: number }) {
  return (
    <div
      className="person-away"
      style={{ "--who": `var(--who-${((hue % HUES) + HUES) % HUES})` } as CSSProperties}
      data-invited={String(invited)}
    >
      <span className="person-away-dot" aria-hidden="true" />
      <span className="person-away-name">{"@" + login}</span>
      <span className="person-away-state">{invited ? "invited" : "active"}</span>
    </div>
  );
}

/** Every claude and codex session on this machine, under whoever owns them —
 *  which is always me. Two call sites because I am only in the roster once my
 *  machine has actually emitted an event; before that I still have sessions,
 *  and a list that disappears until the first tool call is a list nobody
 *  trusts.
 *
 *  ⚠️ MEMOISED. The pane above re-renders once a second to keep the "3m ago"
 *  labels honest, and without this every one of those ticks re-rendered four
 *  hundred session rows for nothing. */
const MySessions = memo(function MySessions({ hue }: { hue: number }) {
  return (
    <div className="person-sessions">
      <SessionsPane hue={hue} />
    </div>
  );
});

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
  const myActor = useBoard((s) => s.myActor);
  const who = useBoard((s) => s.who.state) as
    | { login?: string; people?: Array<{ login: string; owner?: boolean; pending?: boolean }> }
    | null;
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

  /* Everyone on the allowlist who is not already a live row. Matching a
     GitHub login to an actor name is a guess — they are different namespaces
     and nothing on the wire joins them — so the only join made here is the
     case-folded equality, plus my own login, which I already appear as. A
     teammate who is live AND spells their actor differently from their login
     will show twice; that is the failure this cannot rule out without a field
     the hub does not send, and showing them twice is better than hiding a
     live teammate. */
  const accounts = Array.isArray(who?.people) ? who.people : [];
  /* Two spellings of "me", and both are needed. `who.login` is the GitHub
     login of the browser session and is empty on a hub with no GitHub
     sign-in; `bridge.cfg.login` is what this machine signed in as and
     survives that. Missing either one puts my own account in the list a
     second time, under a name I do not recognise as mine. */
  const mine = new Set(
    [who?.login, bridge.cfg && bridge.cfg.login].map((x) => String(x || "").toLowerCase()).filter(Boolean),
  );
  const live = new Set(roster.map((r) => r.actor.toLowerCase()));
  const away = accounts.filter((p) => {
    const l = p.login.toLowerCase();
    return l && !mine.has(l) && !live.has(l);
  });
  const inRoster = roster.some((r) => r.actor === myActor);

  /* ⚠️ A FRAGMENT. App.tsx already wraps this in `.pane-body#people`; this
     used to open a SECOND one with the same id, nested inside the first. Two
     elements sharing an id is its own bug, and it broke the column layout
     below: the inner wrapper caught `#people > *` and stopped the session
     list from shrinking, so the list overflowed the pane instead of
     scrolling inside it. */
  return (
    <>
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
            {/* ⚠️ NOT GATED ON `open`. This list was a rail section of its own
                and is the main way past work gets opened; putting it behind
                the expand toggle would have relocated a feature and hidden it
                in the same change. The toggle still governs the detail card
                above — what they are doing right now — which is what it always
                governed. */}
            {r.actor === myActor ? <MySessions hue={r.hue} /> : null}
          </div>
        );
      })}
      {/* Me, before my first event of the session. `--who-0` is what `hueOf`
          answers for an actor with no roster seat, so the colour does not jump
          when the seat arrives. */}
      {!inRoster && myActor && bridge.local ? (
        <div className="person-wrap">
          <div className="person-away" data-invited="false" style={{ "--who": "var(--who-0)" } as CSSProperties}>
            <span className="person-away-dot" aria-hidden="true" />
            <span className="person-away-name">{myActor}</span>
            <span className="person-away-state">you</span>
          </div>
          <MySessions hue={0} />
        </div>
      ) : null}
      {away.map((p, i) => (
        <TeammateRow
          key={"away:" + p.login}
          login={p.login}
          invited={Boolean(p.pending)}
          hue={roster.length + i}
        />
      ))}
      {!roster.length && !away.length ? (
        <div style={{ padding: "14px 16px", color: "var(--subtle)", fontSize: "12.5px" }}>nobody yet</div>
      ) : null}
    </>
  );
}
