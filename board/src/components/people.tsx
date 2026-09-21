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
 * The tree is person → repo → agent → the subagents that agent spawned:
 *
 *     ● andrew                    you
 *       ▾ zevet                     2
 *           ▾ [mark] Zevet bugs   4m
 *               [mark] Explore
 *               [mark] code-reviewer
 *           [mark] Fix the parser 9m
 *       ▸ metrodora                 1
 *     ○ @kabbott2             invited
 *
 * Andrew: "under user (andrew) is repo(s) (zevet), inside of that filetree is
 * the icon for the model type next to the 1-3 word blurb like what exists in
 * claude code in the terminal." The blurb is the CLI's own `ai-title`, so it
 * is the same words its terminal header shows.
 *
 * ⚠️ THE CHEVRONS ARE THE FILE TREE'S. Andrew: "take the dropdown arrow from
 * the filetree to keep things consistent." Same lucide icons, same size, same
 * muted weight as components/tree.tsx — not a glyph in a `::before`, which is
 * what these were and which could never match it.
 *
 * The history lives in the repo pane (components/detail.tsx § blank-repo),
 * which is a column built for a long list rather than a 250px rail. The plus
 * is in this pane's own title row (App.tsx).
 */
import { type CSSProperties, useEffect, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { hueOf, isIdle, selectRoster, serverNow, useBoard } from "../lib/board";
import type { RosterEntry } from "../lib/types";
import type { SessionAgent, SessionSummary } from "../lib/sessions.d.mts";
import { missionOf } from "../lib/text";
import { agoLabel } from "../lib/fmt";
import { sessionBlurb, sessionProject } from "../lib/sessions.mjs";
import { AgentLogo } from "./brand";
import { bridge } from "../lib/bridge";
import { HUES, LIVE_SESSION_MS } from "../lib/constants";

/** The file tree's own twisty, so the two trees cannot drift apart. */
function Twist({ open }: { open: boolean }) {
  return open ? (
    <ChevronDownIcon className="text-foreground/25 size-3 shrink-0" />
  ) : (
    <ChevronRightIcon className="text-foreground/25 size-3 shrink-0" />
  );
}

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
 *  the seven-row trace that used to live here was the single biggest thing the
 *  rail spent height on, and the conversation column shows the same work in
 *  full. */
function PersonDetail({ r }: { r: RosterEntry }) {
  const mission = missionOf(r);
  if (!mission) return null;
  return (
    <div className="person-detail" style={{ "--who": hueOf(r.actor) } as CSSProperties}>
      <div className="mission">{mission}</div>
    </div>
  );
}

/** One subagent of the agent above it. This is the list that used to be behind
 *  "8 agents" in the banner over the transcript; Andrew asked for it here
 *  instead, and the banner lost both that control and "Back to session" with
 *  it. */
function SubagentRow({ a, hue }: { a: SessionAgent; hue: number }) {
  const openAgent = useBoard((st) => st.sessions.openAgent);
  const openSessionAgent = useBoard((st) => st.openSessionAgent);
  return (
    <button
      type="button"
      className="agent-sub"
      data-active={String(openAgent?.id === a.id)}
      style={{ "--who": `var(--who-${((hue % HUES) + HUES) % HUES})` } as CSSProperties}
      onClick={() => openSessionAgent(a)}
      title={[a.kind, a.model].filter(Boolean).join(" · ")}
    >
      {/* The owner colour, like its parent row. A subagent mark left on the
          vendor default painted an orange asterisk under a blue one for the
          same agent, which reads as two different things rather than one
          agent and its children. */}
      <AgentLogo agent="claude" model={a.model} hue={hue} className="agent-sub-mark size-3" />
      <span className="agent-sub-name">{a.title || a.kind || a.id}</span>
    </button>
  );
}

/**
 * One agent: its CLI's mark, the CLI's own two-word summary of the work, and
 * how long ago it last wrote anything.
 *
 * ⚠️ THE SUBAGENT NAMES COST A FILE EACH, so they are only ever fetched for the
 * session that is open — `children` is a readdir count and is free, the names
 * are not (desktop/main.js § local:sessionAgents). Opening the row is what
 * loads them, which is the same bargain the banner made; the difference is
 * that the tree can show them without a second piece of navigation.
 */
function AgentRow({ s, hue }: { s: SessionSummary; hue: number }) {
  const open = useBoard((st) => st.sessions.open);
  const agents = useBoard((st) => st.sessions.agents);
  const loading = useBoard((st) => st.sessions.openLoading);
  const openSession = useBoard((st) => st.openSession);
  const now = serverNow();
  const isOpen = open?.id === s.id && open?.source === s.source;
  const hasKids = Number(s.children) > 0;
  return (
    <div className="agent-row-wrap">
      <button
        type="button"
        className="agent-row"
        data-active={String(isOpen)}
        style={{ "--who": `var(--who-${((hue % HUES) + HUES) % HUES})` } as CSSProperties}
        aria-current={isOpen ? "true" : undefined}
        aria-expanded={hasKids ? isOpen : undefined}
        onClick={() => openSession(s)}
        title={`${s.cwd || s.slug}${s.branch ? ` · ${s.branch}` : ""}`}
      >
        {hasKids ? <Twist open={isOpen} /> : <span className="agent-row-gap" aria-hidden="true" />}
        <AgentLogo agent={s.source} hue={hue} className="agent-row-mark size-3" />
        <span className="agent-row-name">{sessionBlurb(s as unknown as Record<string, unknown>)}</span>
        <span className="agent-row-ago">{agoLabel(s.updated, now)}</span>
      </button>
      {isOpen && hasKids ? (
        agents.length ? (
          agents.map((a) => <SubagentRow key={a.id} a={a} hue={hue} />)
        ) : (
          <div className="agent-sub agent-sub-note">{loading ? "reading…" : "no subagents recorded"}</div>
        )
      ) : null}
    </div>
  );
}

/** One repo, and the agents running in it. */
function RepoGroup({
  repo,
  rows,
  hue,
  open,
  onToggle,
}: {
  repo: string;
  rows: SessionSummary[];
  hue: number;
  open: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <div className="repo-group">
      <button
        type="button"
        className="repo-group-head"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
      >
        <Twist open={open} />
        <span className="repo-group-name">{repo}</span>
        <span className="repo-group-count">{rows.length}</span>
      </button>
      {open ? rows.map((s) => <AgentRow key={`${s.source}:${s.id}`} s={s} hue={hue} />) : null}
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

  /* ⚠️ THE FETCH LIVES HERE NOW, not in the history list. This pane is always
     mounted; the history is in the repo column and only renders while nothing
     is selected, so leaving the refresh there meant the live tree went stale
     the moment somebody clicked a file. */
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
     the repo it ran in. All of them are mine: every file the scan reads comes
     out of this machine's own store.

     ⚠️ "RUNNING" IS A GUESS AND THE CODE SHOULD SAY SO. A session read off disk
     has no pid — desktop/agent-sessions.js is a read-only scan — and neither
     CLI writes a marker when it exits, so the only signal is how recently the
     transcript was appended to. This is RECENCY, and `LIVE_SESSION_MS` is the
     width of the window. Do not put the word "running" in the UI on the
     strength of it. */
  const groups: Array<{ repo: string; rows: SessionSummary[] }> = [];
  if (bridge.local) {
    const bucket = new Map<string, SessionSummary[]>();
    for (const s of list) {
      if (now - Number(s.updated || 0) >= LIVE_SESSION_MS) continue;
      const key = sessionProject(s as unknown as Record<string, unknown>) || "elsewhere";
      const g = bucket.get(key);
      if (g) g.push(s);
      else bucket.set(key, [s]);
    }
    for (const [repo, rows] of bucket) {
      rows.sort((a, b) => Number(b.updated || 0) - Number(a.updated || 0));
      groups.push({ repo, rows });
    }
    groups.sort((a, b) => Number(b.rows[0].updated || 0) - Number(a.rows[0].updated || 0));
  }

  /* Open unless the group was shut by hand: a tree whose branches all start
     closed makes you click twice to learn what is already known. */
  const myRepos = (hue: number) =>
    groups.map((g) => (
      <RepoGroup
        key={g.repo}
        repo={g.repo}
        rows={g.rows}
        hue={hue}
        open={!shut[g.repo]}
        onToggle={(on) => setShut((o) => (o[g.repo] === !on ? o : { ...o, [g.repo]: !on }))}
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
            {me ? myRepos(r.hue) : null}
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
          {myRepos(0)}
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
