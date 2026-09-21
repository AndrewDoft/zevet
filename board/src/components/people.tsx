/**
 * The rail's People section: who is here, and what is running right now.
 *
 * ⚠️ RIGHT NOW, AND NOTHING ELSE. This pane used to carry three things at once
 * — a card of the last seven tool calls per teammate, the whole four-hundred
 * session history of the machine, and a button to start an agent. Andrew:
 * "there's no need in this People thing on the side to show any sort of tool
 * use, I think that just takes up too much space", "once agents are done they
 * should go somewhere like to history, they shouldn't stay visualizable in
 * people", and "there's also no need for like the new agent thing, you can put
 * a plus sign somewhere else".
 *
 * So the shape is a tree with the file tree's manners and none of its folder
 * icons:
 *
 *     ● andrew                    you
 *       ▾ [mark] claude code       2
 *           zevet          3m
 *           metrodora     12m
 *       ▸ [mark] codex             1
 *     ○ @kabbott2              invited
 *
 * The history moved to the repo pane (components/detail.tsx § blank-repo),
 * which is a column built for a long list rather than a 250px rail. The plus
 * moved to this pane's own title row (App.tsx § RailHead).
 */
import { type CSSProperties, useEffect, useState } from "react";
import { hueOf, isIdle, selectRoster, serverNow, useBoard } from "../lib/board";
import type { RosterEntry } from "../lib/types";
import type { SessionSummary } from "../lib/sessions.d.mts";
import { missionOf } from "../lib/text";
import { agoLabel } from "../lib/fmt";
import { sessionProject } from "../lib/sessions.mjs";
import { AgentLogo } from "./brand";
import { bridge } from "../lib/bridge";
import { HUES, LIVE_SESSION_MS } from "../lib/constants";

/** What a `SessionSummary.source` is called in front of a person. The CLIs
 *  spell themselves differently in the two vocabularies zevet reads — a hub
 *  event says "claude-code" where a session file says "claude" — and this is
 *  the one place that decides which spelling a human sees. */
const AGENT_LABEL: Record<string, string> = {
  claude: "claude code",
  codex: "codex",
  opencode: "opencode",
};

function expandedStored(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem("zevet.expanded.v1") || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Somebody the hub lets in who has not sent an event yet.
 *
 * ⚠️ THE ROSTER AND THE ALLOWLIST ARE DIFFERENT LISTS AND ALWAYS WERE. The
 * roster (`selectRoster`) is folded out of the live event stream, so a
 * teammate only appears in it once their machine has actually run something.
 * The allowlist (`/auth/whoami` → `people`) is who the owner has let in, and
 * carries `pending: !a.id` — no GitHub id means they were invited and have
 * never signed in. Until this existed only Settings read it, so People could
 * not answer the one question you ask right after sending an invitation.
 *
 * `pending` is the honest boundary: false means they signed in, which IS the
 * acceptance. It does not mean they are running anything — that is what a
 * roster row means, and anyone with one is filtered out before we get here. */
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

/** What they are working on, in their own words. One line, and no tool calls:
 *  the seven-row trace that used to live here is the single biggest thing the
 *  rail was spending its height on, and the conversation column shows the same
 *  work in full. */
function PersonDetail({ r }: { r: RosterEntry }) {
  const mission = missionOf(r);
  if (!mission) return null;
  return (
    <div className="person-detail" style={{ "--who": hueOf(r.actor) } as CSSProperties}>
      <div className="mission">{mission}</div>
    </div>
  );
}

function LiveSessionRow({ s, hue }: { s: SessionSummary; hue: number }) {
  const open = useBoard((st) => st.sessions.open);
  const openSession = useBoard((st) => st.openSession);
  const now = serverNow();
  const isOpen = open?.id === s.id && open?.source === s.source;
  const project = sessionProject(s as unknown as Record<string, unknown>);
  return (
    <button
      type="button"
      className="agent-session"
      data-active={String(isOpen)}
      style={{ "--who": `var(--who-${((hue % HUES) + HUES) % HUES})` } as CSSProperties}
      aria-current={isOpen ? "true" : undefined}
      onClick={() => openSession(s)}
      title={`${s.cwd || s.slug}${s.branch ? ` · ${s.branch}` : ""}`}
    >
      <span className="agent-session-name">{project || s.slug || s.id}</span>
      <span className="agent-session-ago">{agoLabel(s.updated, now)}</span>
    </button>
  );
}

/**
 * One CLI, and the sessions of it that are running.
 *
 * ⚠️ "RUNNING" IS A GUESS, AND THE CODE SHOULD SAY SO. A session read off disk
 * has no pid: `desktop/agent-sessions.js` is a read-only scan of
 * ~/.claude/projects and ~/.codex/sessions, and neither CLI writes a marker
 * when it exits. The only signal there is is how recently the transcript was
 * appended to, so this is RECENCY, not liveness, and `LIVE_SESSION_MS` is the
 * width of the window. A session that really has ended falls out of the tree
 * when it goes quiet, which is the behaviour that was wanted anyway — but do
 * not put the word "running" in the UI on the strength of it.
 */
function AgentGroup({
  source,
  rows,
  hue,
  open,
  onToggle,
}: {
  source: string;
  rows: SessionSummary[];
  hue: number;
  open: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <details
      className="agent-group"
      open={open}
      onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="agent-group-head">
        <AgentLogo agent={source} hue={hue} className="agent-group-mark size-3" />
        <span className="agent-group-name">{AGENT_LABEL[source] || source}</span>
        <span className="agent-group-count">{rows.length}</span>
      </summary>
      {rows.map((s) => (
        <LiveSessionRow key={`${s.source}:${s.id}`} s={s} hue={hue} />
      ))}
    </details>
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
  const list = useBoard((s) => s.sessions.list);
  const refreshSessions = useBoard((s) => s.refreshSessions);
  const localRoot = useBoard((s) => s.localRoot);
  const [expanded, setExpanded] = useState<string[]>(() => expandedStored());
  const [shut, setShut] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(() => serverNow());

  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(t);
  }, []);

  /* ⚠️ THE FETCH LIVES HERE NOW, not in SessionsPane. This pane is always
     mounted; the history list is in the repo pane and only renders while
     nothing is selected, so leaving the refresh there meant the live tree went
     stale the moment somebody clicked a file. */
  useEffect(() => {
    if (bridge.local) refreshSessions(true);
  }, [refreshSessions, localRoot]);

  function toggleExpanded(actor: string, on: boolean) {
    const next = expanded.filter((x) => x !== actor);
    if (on) next.push(actor);
    setExpanded(next);
    try {
      localStorage.setItem("zevet.expanded.v1", JSON.stringify(next));
    } catch {
      // Private mode etc: expansion just does not persist.
    }
  }

  /* Everyone on the allowlist who is not already a live row. Matching a GitHub
     login to an actor name is a guess — they are different namespaces and
     nothing on the wire joins them — so the only join made here is case-folded
     equality, plus my own login, which I already appear as. A teammate who is
     live AND spells their actor differently from their login will show twice;
     that is the failure this cannot rule out without a field the hub does not
     send, and showing them twice beats hiding a live teammate. */
  const accounts = Array.isArray(who?.people) ? who.people : [];
  const mine = new Set(
    [who?.login, bridge.cfg && bridge.cfg.login].map((x) => String(x || "").toLowerCase()).filter(Boolean),
  );
  const liveActors = new Set(roster.map((r) => r.actor.toLowerCase()));
  const away = accounts.filter((p) => {
    const l = p.login.toLowerCase();
    return l && !mine.has(l) && !liveActors.has(l);
  });
  const inRoster = roster.some((r) => r.actor === myActor);

  /* Every session written to inside the live window, newest first, bucketed by
     which CLI wrote it. All of them are mine: every file the scan reads comes
     out of this machine's own store. */
  const groups: Array<{ source: string; rows: SessionSummary[] }> = [];
  if (bridge.local) {
    const bucket = new Map<string, SessionSummary[]>();
    for (const s of list) {
      if (now - Number(s.updated || 0) >= LIVE_SESSION_MS) continue;
      const key = String(s.source || "");
      const g = bucket.get(key);
      if (g) g.push(s);
      else bucket.set(key, [s]);
    }
    for (const [source, rows] of bucket) {
      rows.sort((a, b) => Number(b.updated || 0) - Number(a.updated || 0));
      groups.push({ source, rows });
    }
    groups.sort((a, b) => Number(b.rows[0].updated || 0) - Number(a.rows[0].updated || 0));
  }

  /* Open unless the group was shut by hand: a tree whose branches all start
     closed makes you click twice to learn what is already known. */
  const myAgents = (hue: number) =>
    groups.map((g) => (
      <AgentGroup
        key={g.source}
        source={g.source}
        rows={g.rows}
        hue={hue}
        open={!shut[g.source]}
        onToggle={(on) => setShut((o) => (o[g.source] === !on ? o : { ...o, [g.source]: !on }))}
      />
    ));

  return (
    <>
      {roster.map((r) => {
        const idle = isIdle(r, now);
        const open = expanded.indexOf(r.actor) >= 0;
        const me = r.actor === myActor;
        return (
          <div className="person-wrap" key={r.actor}>
            <button
              className="person-row"
              style={{ "--who": hueOf(r.actor) } as CSSProperties}
              data-idle={String(idle)}
              data-sel={String(selectedActor === r.actor)}
              aria-expanded={open}
              onClick={(ev) => {
                // Shift-click has always meant "show me only this person's
                // work"; a plain click opens what they are doing.
                if (ev.shiftKey) {
                  setSelectedActor(selectedActor === r.actor ? null : r.actor);
                  return;
                }
                toggleExpanded(r.actor, !open);
              }}
            >
              <span className="person-row-dot" aria-hidden="true" />
              <span className="person-row-name">{r.actor}</span>
              <span className="person-row-state">{me ? "you" : idle ? "idle" : "working"}</span>
            </button>
            {open ? <PersonDetail r={r} /> : null}
            {me ? myAgents(r.hue) : null}
          </div>
        );
      })}
      {/* Me, before my first event of the session. The roster is folded out of
          the live event stream, so I have no row until my own machine emits
          something — and my running agents would go with it. `--who-0` is what
          `hueOf` answers for an actor with no roster seat, so the colour does
          not jump when the seat arrives. */}
      {!inRoster && myActor && bridge.local ? (
        <div className="person-wrap">
          <div className="person-row" style={{ "--who": "var(--who-0)" } as CSSProperties} data-idle="false">
            <span className="person-row-dot" aria-hidden="true" />
            <span className="person-row-name">{myActor}</span>
            <span className="person-row-state">you</span>
          </div>
          {myAgents(0)}
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
