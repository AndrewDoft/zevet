/**
 * The rail's "Sessions" section: every agent session on this machine.
 *
 * WHY IT IS HERE AND NOT SOMEWHERE ELSE. The rail already answers "what is
 * running" (People, You). This answers "what has run" — and until now zevet
 * could not, because it only knew about the agents it spawned itself. Andrew:
 * "zevet should be able to visualize and demonstrate all of my claude
 * sessions, including those on terminal", then "zevet should also detect from
 * the desktop (codex and claude desktop apps)". A session typed into a
 * terminal an hour ago now opens in the same Thread, with the same tool cards,
 * as one zevet started.
 *
 * READ ONLY, and the UI says so rather than implying otherwise: there is no
 * composer under an open session, no resume button and no delete. Resuming a
 * session is a different thing from reading one — it starts a process — and it
 * already has a home in the launcher.
 *
 * SCOPED TO THE OPEN FOLDER BY DEFAULT. There are 127 sessions and 625 MB of
 * transcript on this machine; a list that opens on all of them is a list
 * nobody reads. "All" is one click away and is what the filter box is for.
 */
import { useState } from "react";
import { Twist } from "./twist";
import { cn } from "@/lib/utils";
import { AgentLogo } from "./brand";
import { mono } from "./assistant-ui/elements/surfaces";
import { useBoard, resumeIdForSession } from "../lib/board";
import { bridge } from "../lib/bridge";
import { agoLabel } from "../lib/fmt";
import {
  sessionLabel,
  sessionMatches,
  sessionProject,
} from "../lib/sessions.mjs";
import type { SessionSummary } from "../lib/sessions.d.mts";

function SessionRow({ s, hue }: { s: SessionSummary; hue?: number }) {
  // Reuse the board clock; all rows advance together once a minute.
  useBoard((st) => Math.floor(st.tick / 60));
  const open = useBoard((st) => st.sessions.open);
  const openSession = useBoard((st) => st.openSession);
  const isOpen = open?.id === s.id && open?.source === s.source;
  const project = sessionProject(s);

  return (
    <button
      type="button"
      className="session-row"
      data-active={String(isOpen)}
      aria-current={isOpen ? "true" : undefined}
      onClick={() => openSession(s)}
      title={sessionLabel(s)}
    >
      {/* ⚠️ THE OWNER'S COLOUR, NOT THE CLI'S. It used to take the agent's own
          mark ("a session has no seat in the roster"), which was true of the
          data and wrong about the meaning: every file this list reads comes
          out of THIS machine's ~/.claude and ~/.codex, so every row in it is
          mine. The list now hangs under my row in People and takes my hue
          with it. `hue` is undefined for any other caller, which restores the
          old behaviour exactly. */}
      <AgentLogo agent={s.source} hue={hue} className="session-row-logo size-3" />
      <span className="session-row-title">{sessionLabel(s)}</span>
      <span className={cn(mono, "session-row-meta")}>
        {project ? <span className="session-row-project">{project}</span> : null}
        <span className="session-row-ago">{agoLabel(s.updated, Date.now())}</span>
      </span>
    </button>
  );
}

/** The scope toggle, shaped like the rail's other two-state controls. */
function ScopeControl() {
  const scope = useBoard((st) => st.sessions.scope);
  const setSessionScope = useBoard((st) => st.setSessionScope);
  const localRoot = useBoard((st) => st.localRoot);

  return (
    <span className="session-scope" role="group" aria-label="Which sessions">
      <button
        type="button"
        aria-pressed={scope === "repo"}
        // Scoping to a folder needs a folder. With none open the only honest
        // list is the whole machine, so the control says so instead of
        // offering a filter that would empty the pane.
        disabled={!localRoot}
        onClick={() => setSessionScope("repo")}
      >
        This project
      </button>
      <button
        type="button"
        aria-pressed={scope === "all"}
        onClick={() => setSessionScope("all")}
      >
        All
      </button>
    </span>
  );
}

/**
 * Sessions bucketed by the project they ran in, most recently touched first.
 *
 * ⚠️ FOUR HUNDRED ROWS IS NOT A LIST, IT IS A WALL. Andrew: "you need more
 * dropdowns to make this way cleaner, since there are just so many agents."
 * A disclosure per project turns it into ~20 headings you can read, with the
 * folder you are actually in already open.
 *
 * `<details>` rather than a hand-rolled collapse: it is a real disclosure
 * widget, it is keyboard-operable and announced correctly without a single
 * aria attribute, and it costs no state until somebody clicks one.
 */
function byProject(list: SessionSummary[]) {
  const groups = new Map<string, SessionSummary[]>();
  for (const s of list) {
    // Same helper the row uses, so a heading can never name a project
    // differently from the sessions under it.
    const key = sessionProject(s as unknown as Record<string, unknown>) || "elsewhere";
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  }
  return [...groups.entries()]
    .map(([name, rows]) => ({
      name,
      rows,
      updated: rows.reduce((m, r) => Math.max(m, Number(r.updated) || 0), 0),
    }))
    .sort((a, b) => b.updated - a.updated);
}

/** The folder name the rest of the rail calls "this repo". */
function hereName(root: string | null | undefined) {
  const parts = String(root || "").split(/[\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

export function SessionsPane({ hue }: { hue?: number } = {}) {
  const sessions = useBoard((st) => st.sessions);
  const setSessionQuery = useBoard((st) => st.setSessionQuery);
  const localRoot = useBoard((st) => st.localRoot);
  /* ⚠️ OPEN STATE LIVES IN REACT, NOT IN THE DOM. `<details open={...}>` is an
     attribute React re-applies on every render, and this component re-renders
     on a timer from the pane above it — so a group you had opened by hand
     snapped shut a second later. An entry here only appears once somebody has
     actually toggled that group; everything else falls back to the default. */
  const [opened, setOpened] = useState<Record<string, boolean>>({});

  /* ⚠️ NO FETCH HERE ANY MORE — components/people.tsx owns it. This pane now
     lives in the repo column, which only renders while nothing is selected, so
     a fetch driven from here stopped happening the moment somebody clicked a
     file, and the live tree in People went stale behind it. People is always
     mounted, so that is where the refresh belongs. */

  if (!bridge.local || typeof bridge.local.sessions !== "function") return null;

  // `sessionMatches` takes a bag of fields, not a SessionSummary — it is .mjs
  // and is shared with the subagent rows, which have a different shape.
  const shown = sessions.list.filter((s) =>
    sessionMatches(s as unknown as Record<string, unknown>, sessions.query),
  );
  const groups = byProject(shown);
  const here = hereName(localRoot);
  // A filter that hid its own matches inside collapsed groups would be a
  // filter that does not work. While one is typed, everything is open.
  const filtering = sessions.query.trim().length > 0;

  return (
    <>
      <div className="pane-title row">
        <span>Sessions</span>
        <ScopeControl />
      </div>
      <div className="pane-body" id="sessions">
        <input
          className="session-filter"
          type="search"
          value={sessions.query}
          placeholder="Filter sessions…"
          aria-label="Filter sessions"
          onChange={(e) => setSessionQuery(e.target.value)}
        />
        {sessions.error ? <div className="session-empty">{sessions.error}</div> : null}
        {!sessions.error && sessions.loading && !sessions.list.length ? (
          <div className="session-empty">Reading…</div>
        ) : null}
        {!sessions.error && !sessions.loading && !shown.length ? (
          <div className="session-empty">
            {sessions.list.length
              ? "Nothing matches that."
              : sessions.scope === "repo" && localRoot
                ? "No sessions in this folder yet."
                : "No sessions yet."}
          </div>
        ) : null}
        {groups.map((g) => {
          const on = filtering || (opened[g.name] ?? g.name === here);
          return (
            <details
              className="session-group"
              key={g.name}
              open={on}
              onToggle={(e) => {
                const next = (e.currentTarget as HTMLDetailsElement).open;
                setOpened((o) => (o[g.name] === next ? o : { ...o, [g.name]: next }));
              }}
            >
              {/* THE FILE TREE CHEVRON, not a glyph in a ::before pseudo. The
                  two trees now use the same lucide icons at the same size and
                  weight as components/tree.tsx and components/people.tsx, so
                  they cannot drift apart again. */}
              <summary className="session-group-head">
                <Twist open={on} />
                <span className="session-group-name">{g.name}</span>
                <span className="session-group-count">{g.rows.length}</span>
              </summary>
              {g.rows.map((s) => (
                <SessionRow key={`${s.source}:${s.id}`} s={s} hue={hue} />
              ))}
            </details>
          );
        })}
        {/* Keep the size of the loaded history without a dashboard total. */}
        {sessions.total > sessions.list.length ? (
          <div className="session-empty">
            {sessions.list.length} sessions
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * The bar above an open session, in the conversation column.
 *
 * It carries the one thing the transcript itself cannot say: that this is a
 * recording, whose, and how to get back to the live console.
 */
export function SessionBanner() {
  const open = useBoard((st) => st.sessions.open);
  const openAgent = useBoard((st) => st.sessions.openAgent);
  const truncated = useBoard((st) => st.sessions.openTruncated);
  const loading = useBoard((st) => st.sessions.openLoading);
  const closeSession = useBoard((st) => st.closeSession);
  const continueSession = useBoard((st) => st.continueSession);
  if (!open) return null;

  // `resumeIdForSession` is the SAME function `continueSession` guards on in
  // board.ts — asked here rather than re-deriving the claude/codex split, so
  // the button and the action can never disagree about what is resumable.
  const resumeId = resumeIdForSession(open);
  // A recording without a resumable id, or a build with no local bridge,
  // honestly offers no Continue — clicking one would start a fresh session
  // wearing the old one's title.
  const canContinue =
    Boolean(resumeId) && Boolean(bridge.local) && typeof bridge.local?.resumeAgent === "function";
  return (
    <>
      <div className="session-banner">
        <AgentLogo agent={open.source} className="size-3.5" />
        <span className="session-banner-title">
          {openAgent ? openAgent.title || "Agent" : sessionLabel(open)}
        </span>
        <span className={cn(mono, "session-banner-meta")}>
          {open.source === "codex" ? "Codex" : "Claude"}
          {!openAgent && open.branch ? ` · ${open.branch}` : ""}
          {loading ? " · reading…" : ""}
          {truncated ? " · earliest turns trimmed" : ""}
        </span>
        {/* ⚠️ ONE CONTROL, NOT THREE. The subagent dropdown and "Back to
            session" both lived here and are gone: the People tree shows the
            same subagents under the agent that spawned them, and clicking the
            parent there is how you go back up. Andrew: "you can click on them
            there. this should get rid of the nav at the top that says x agents
            and back to session."
            "Back to live" stays, because leaving a recording entirely is not
            something the tree expresses — every row in it opens something. */}
        {canContinue ? (
          <button
            type="button"
            className="session-banner-close"
            onClick={() => continueSession(open)}
          >
            Continue
          </button>
        ) : null}
        <button type="button" className="session-banner-close" onClick={() => closeSession()}>
          Back to live
        </button>
      </div>
    </>
  );
}
