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
 * ⚠️ A CONSOLE ZEVET LAUNCHED IS AN AGENT ROW HERE TOO, not a second list
 * under its own "You" heading. Andrew: "this terminal conv is tracked in the
 * right place (people), but the claude session in zevet is at the bottom of
 * the people window, somewhere else ... the zevet one is a better
 * construction (it has the claude logo, the permissions, and a stop option)."
 * The old "You" section (components/consoles.tsx, mounted under its own
 * heading in App.tsx) is gone; its row — logo, posture, Stop — is folded into
 * `AgentRow` below, which now renders off a normalised `Row` rather than off
 * a `SessionSummary` directly. See `Row` and `buildGroups` for the merge and
 * the dedupe that merge requires.
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
import { Twist } from "./twist";
import {
  hueOf,
  isIdle,
  resumeIdForSession,
  selectActiveConsole,
  selectMyConsoles,
  selectRoster,
  serverNow,
  useBoard,
} from "../lib/board";
import type { RosterEntry } from "../lib/types";
import type { SessionAgent, SessionSummary } from "../lib/sessions.d.mts";
import type { ConsoleEntry } from "../lib/types";
import { missionOf } from "../lib/text";
import { agoLabel } from "../lib/fmt";
import { sessionBlurb, sessionProject } from "../lib/sessions.mjs";
import { AgentLogo } from "./brand";
import { ghostButton, mono } from "./assistant-ui/elements/surfaces";
import { cn } from "@/lib/utils";
import { bridge } from "../lib/bridge";
import { HUES, LIVE_SESSION_MS, MODE_LABEL, MODES } from "../lib/constants";

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
 * One row of the tree, whichever of the two sources it came from.
 *
 * A terminal session on disk (`SessionSummary`) and a console zevet itself
 * launched (`ConsoleEntry`) used to be two different row types in two
 * different lists — this is the shape both are normalised into before
 * `AgentRow` ever sees them, so the component renders one thing instead of
 * forking into a session branch and a console branch. `console`/`session` are
 * mutually exclusive: exactly one is non-null, and it is what the row's extra
 * slot (posture + Stop, or "4m ago") and click handler key off.
 */
type Row = {
  key: string;
  agent: string;
  model?: string;
  blurb: string;
  updated: number;
  console: ConsoleEntry | null;
  session: SessionSummary | null;
};

/** The console's first user message, verbatim. `sessionBlurb` does the
 *  1-3 word cut from here, same as it does for a disk session's `prompt` —
 *  this used to be `consoles.tsx`'s own `taskOf`, which returned the raw
 *  prompt straight to the row and was exactly Andrew's complaint ("neither
 *  the zevet nor the terminal agents have good descriptions, they just read
 *  the first prompt"). ThreadMessageLike allows `content` to be a bare
 *  string, which has no parts — the same shape trap RunMeterCard's tool
 *  count works around. */
function firstPrompt(c: ConsoleEntry): string {
  const first = c.transcript.messages.find((m) => m.role === "user");
  if (!first) return "";
  const text =
    typeof first.content === "string"
      ? first.content
      : first.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join(" ");
  return text.replace(/\s+/g, " ").trim();
}

/** The repo a console belongs to: the last segment of where it is running.
 *  Disk sessions get the analogous answer from `sessionProject`, which also
 *  unmangles claude's dash-slugged directory name — `root` is a real
 *  filesystem path already, so only the last-segment half applies here. */
function consoleProject(c: ConsoleEntry): string {
  const parts = c.root.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || c.root || "elsewhere";
}

/**
 * One agent: its CLI's mark, the CLI's own two-word summary of the work, and
 * either how long ago it last wrote anything (a disk session) or its posture
 * and a Stop button (a live console).
 *
 * ⚠️ THE STOP BUTTON NEVER APPEARS OR DISAPPEARS ON A ROW THAT HAS ONE — its
 * label swaps between "Stop" and "Close" (and its colour between red and
 * muted) but it is always mounted for a console row, exactly like the old
 * consoles.tsx did it. A button that pops in under the pointer when a process
 * exits is worse than a button that just relabels itself; same reasoning as
 * the reserved task line below.
 *
 * ⚠️ THE SUBAGENT NAMES COST A FILE EACH, so they are only ever fetched for the
 * session that is open — `children` is a readdir count and is free, the names
 * are not (desktop/main.js § local:sessionAgents). Opening the row is what
 * loads them, which is the same bargain the banner made; the difference is
 * that the tree can show them without a second piece of navigation. A console
 * row has no subagent list here — it is not read off disk, and a running
 * process's subagents are not yet a file `openSessionAgent` can read.
 */
function AgentRow({ row, hue }: { row: Row; hue: number }) {
  const open = useBoard((st) => st.sessions.open);
  const agents = useBoard((st) => st.sessions.agents);
  const loading = useBoard((st) => st.sessions.openLoading);
  const openSession = useBoard((st) => st.openSession);
  const activeConsole = useBoard(selectActiveConsole);
  const setActiveConsole = useBoard((st) => st.setActiveConsole);
  const closeConsole = useBoard((st) => st.closeConsole);
  const setConsoleMode = useBoard((st) => st.setConsoleMode);
  const now = serverNow();

  const c = row.console;
  const s = row.session;
  const isOpen = c ? activeConsole?.key === c.key : Boolean(s) && open?.id === s!.id && open?.source === s!.source;
  const hasKids = Boolean(s) && Number(s!.children) > 0;
  const title = c
    ? c.root + (MODE_LABEL[c.mode] ? ` · ${MODE_LABEL[c.mode]}` : "")
    : `${s!.cwd || s!.slug}${s!.branch ? ` · ${s!.branch}` : ""}`;
  // What the console is actually headed for: `nextMode` when one is parked
  // (see `ConsoleEntry.nextMode`), otherwise `mode` itself. Cycling from here
  // means a second click while a change is pending moves on from where it's
  // already pointed, not back from the still-running `mode`.
  const heading = c ? c.nextMode ?? c.mode : null;
  const pending = Boolean(c && c.nextMode && c.nextMode !== c.mode);

  return (
    <div className="agent-row-wrap">
      <div
        className="agent-row"
        data-active={String(isOpen)}
        style={{ "--who": `var(--who-${((hue % HUES) + HUES) % HUES})` } as CSSProperties}
      >
        <button
          type="button"
          className="agent-row-pick"
          aria-current={isOpen ? "true" : undefined}
          aria-expanded={hasKids ? isOpen : undefined}
          onClick={() => (c ? setActiveConsole(c.key) : openSession(s!))}
          title={title}
        >
          {hasKids ? <Twist open={isOpen} /> : <span className="agent-row-gap" aria-hidden="true" />}
          <AgentLogo agent={row.agent} model={row.model} hue={hue} className="agent-row-mark size-3" />
          <span className="agent-row-name">{row.blurb}</span>
          {/* Reserved either way, so the row never grows or shrinks when a
              console starts or a session ages: a console shows its posture
              here (as its own button, below — a disk session's "4m ago" is
              plain text and stays in this slot; a console's posture is a
              control, and a <button> cannot nest inside `agent-row-pick`,
              which is a <button> itself). */}
          {c ? null : <span className="agent-row-ago">{agoLabel(s!.updated, now)}</span>}
        </button>
        {/* Cycles MODES on click. Andrew: "you should be able to change
            permissions throughout, even to dsp [dangerous]." A RUNNING
            console can't take a new posture mid-turn — there is no way to
            hand a live process new argv — so `setConsoleMode` parks the pick
            in `nextMode` instead of applying it, and this button says so
            ("Auto → Skip permissions") rather than looking like the click did
            nothing. The store's prompt-sending action is what actually
            swaps it in, on the next turn. A disk session gets no control
            here — zevet did not start it and cannot restart it. */}
        {c ? (
          <button
            type="button"
            className={cn(mono, "agent-row-mode")}
            data-danger={String(c.mode === "dangerous" || c.nextMode === "dangerous")}
            data-pending={String(pending)}
            title={
              pending
                ? `Posture for the next turn — click to change. Currently ${MODE_LABEL[c.mode] || c.mode}, switching to ${MODE_LABEL[heading!] || heading}.`
                : "Posture for the next turn — click to change."
            }
            onClick={(e) => {
              e.stopPropagation();
              const idx = MODES.findIndex((m) => m.id === heading);
              const next = MODES[(idx + 1 + MODES.length) % MODES.length];
              setConsoleMode(c.key, next.id);
            }}
          >
            {pending ? `${MODE_LABEL[c.mode] || c.mode} → ${MODE_LABEL[heading!] || heading}` : MODE_LABEL[c.mode] || c.mode}
          </button>
        ) : null}
        {/* Only a console row gets this — a disk session cannot be stopped,
            it already finished writing. Andrew asked for Stop specifically in
            red; Close (the same button once the process has exited) is not
            destructive, so it stays the muted colour every other control in
            this pane uses. */}
        {c ? (
          <button
            type="button"
            className={cn(ghostButton, "agent-row-stop")}
            data-running={String(c.running)}
            onClick={() => closeConsole(c.key)}
            aria-label={(c.running ? "Stop " : "Close ") + c.agent}
          >
            {c.running ? "Stop" : "Close"}
          </button>
        ) : null}
      </div>
      {isOpen && hasKids ? (
        agents.length ? (
          agents.map((a) => <SubagentRow key={a.id} a={a} hue={hue} />)
        ) : (
          <div className="agent-sub agent-sub-note">{loading ? "reading…" : "no subagents recorded"}</div>
        )
      ) : null}
      {c && c.error ? <div className="agent-row-err">{c.error}</div> : null}
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
  rows: Row[];
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
      {open ? rows.map((row) => <AgentRow key={row.key} row={row} hue={hue} />) : null}
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
  const myConsoles = useBoard(selectMyConsoles);
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
     the repo it ran in — merged with every console zevet itself has running,
     bucketed by `consoleProject`. All of it is mine: every file the scan reads
     comes out of this machine's own store, and a console only exists because
     this machine's own bridge launched it.

     ⚠️ "RUNNING" IS A GUESS AND THE CODE SHOULD SAY SO, for the disk half. A
     session read off disk has no pid — desktop/agent-sessions.js is a
     read-only scan — and neither CLI writes a marker when it exits, so the
     only signal is how recently the transcript was appended to. This is
     RECENCY, and `LIVE_SESSION_MS` is the width of the window. Do not put the
     word "running" in the UI on the strength of it. A console's `running` is
     the real thing — the process is either still alive or it is not.

     ⚠️ DEDUPE, OR THE SAME AGENT APPEARS TWICE. A console zevet launched
     ALSO writes a session file to disk as it goes, so the same agent can turn
     up from both `myConsoles` and the `list` scan below with the same resume
     id — `resumeIdForSession(s)` on the disk side, `c.sessionId` on the
     console side, matched by agent the same way `continueSession` in board.ts
     already does (`x.agent === s.source && x.sessionId === resumeId`) so this
     cannot drift from that check. THE CONSOLE WINS: it is live, and it is the
     only one of the two that can be stopped, so every console goes into the
     bucket unconditionally and any disk session whose resume id a console has
     already claimed is skipped. */
  const groups: Array<{ repo: string; rows: Row[] }> = [];
  if (bridge.local) {
    const bucket = new Map<string, Row[]>();
    const claimed = new Set(myConsoles.filter((c) => c.sessionId).map((c) => `${c.agent}:${c.sessionId}`));

    for (const c of myConsoles) {
      const row: Row = {
        key: `console:${c.key}`,
        agent: c.agent,
        model: c.model,
        blurb: sessionBlurb({ prompt: firstPrompt(c) }),
        updated: c.startedAt,
        console: c,
        session: null,
      };
      const key = consoleProject(c);
      const g = bucket.get(key);
      if (g) g.push(row);
      else bucket.set(key, [row]);
    }

    for (const s of list) {
      if (now - Number(s.updated || 0) >= LIVE_SESSION_MS) continue;
      const resumeId = resumeIdForSession(s);
      if (resumeId && claimed.has(`${s.source}:${resumeId}`)) continue;
      const row: Row = {
        key: `session:${s.source}:${s.id}`,
        agent: s.source,
        blurb: sessionBlurb(s as unknown as Record<string, unknown>),
        updated: Number(s.updated || 0),
        console: null,
        session: s,
      };
      const key = sessionProject(s as unknown as Record<string, unknown>) || "elsewhere";
      const g = bucket.get(key);
      if (g) g.push(row);
      else bucket.set(key, [row]);
    }

    for (const [repo, rows] of bucket) {
      rows.sort((a, b) => b.updated - a.updated);
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
