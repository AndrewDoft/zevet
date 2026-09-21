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
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { AgentLogo } from "./brand";
import { mono } from "./assistant-ui/elements/surfaces";
import { useBoard } from "../lib/board";
import { bridge } from "../lib/bridge";
import { agoLabel } from "../lib/fmt";
import {
  sessionLabel,
  sessionMatches,
  sessionProject,
  sessionWhere,
} from "../lib/sessions.mjs";
import type { SessionSummary } from "../lib/sessions.d.mts";

/**
 * Where it was typed, as a badge.
 *
 * ⚠️ THE EMPTY CASE IS NOT "cli". A session file that recorded no provenance
 * tells us nothing, and printing the most likely answer turns a gap into a
 * claim. The badge is simply absent — which is also what happens for an older
 * CLI that did not write the field at all.
 */
const WHERE_LABEL: Record<string, string> = {
  cli: "terminal",
  desktop: "desktop",
  ide: "editor",
  sdk: "sdk",
};

function SessionRow({ s }: { s: SessionSummary }) {
  const open = useBoard((st) => st.sessions.open);
  const openSession = useBoard((st) => st.openSession);
  const isOpen = open?.id === s.id && open?.source === s.source;
  const where = sessionWhere(s);
  const project = sessionProject(s);

  return (
    <button
      type="button"
      className="session-row"
      data-active={String(isOpen)}
      aria-current={isOpen ? "true" : undefined}
      onClick={() => openSession(s)}
      title={`${s.cwd || s.slug}${s.branch ? ` · ${s.branch}` : ""}`}
    >
      {/* The CLI's own mark, same as a live console row uses. `hue` is not a
          console colour here — a session has no seat in the roster — so the
          logo takes the agent's own. */}
      <AgentLogo agent={s.source} className="session-row-logo size-3" />
      <span className="session-row-title">{sessionLabel(s)}</span>
      <span className={cn(mono, "session-row-meta")}>
        {project ? <span className="session-row-project">{project}</span> : null}
        {where ? (
          <span className="session-row-where" data-where={where}>
            {WHERE_LABEL[where] || where}
          </span>
        ) : null}
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
        This repo
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

export function SessionsPane() {
  const sessions = useBoard((st) => st.sessions);
  const setSessionQuery = useBoard((st) => st.setSessionQuery);
  const refreshSessions = useBoard((st) => st.refreshSessions);
  const localRoot = useBoard((st) => st.localRoot);

  // Fetched on first paint and again when the open folder changes under a
  // repo-scoped list — the scope is a query the desktop side runs, not a
  // filter over something already in hand.
  useEffect(() => {
    refreshSessions(true);
  }, [refreshSessions, localRoot]);

  if (!bridge.local || typeof bridge.local.sessions !== "function") return null;

  // `sessionMatches` takes a bag of fields, not a SessionSummary — it is .mjs
  // and is shared with the subagent rows, which have a different shape.
  const shown = sessions.list.filter((s) =>
    sessionMatches(s as unknown as Record<string, unknown>, sessions.query),
  );

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
                : "No claude or codex sessions on this machine."}
          </div>
        ) : null}
        {shown.map((s) => (
          <SessionRow key={`${s.source}:${s.id}`} s={s} />
        ))}
        {/* `total` counts every session file found, before the cap and before
            the filter — so a list that stops at 400 says so rather than
            looking complete. */}
        {sessions.total > sessions.list.length ? (
          <div className="session-empty">
            Showing {sessions.list.length} of {sessions.total}.
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
  const agents = useBoard((st) => st.sessions.agents);
  const openAgent = useBoard((st) => st.sessions.openAgent);
  const openSessionAgent = useBoard((st) => st.openSessionAgent);
  const truncated = useBoard((st) => st.sessions.openTruncated);
  const loading = useBoard((st) => st.sessions.openLoading);
  const closeSession = useBoard((st) => st.closeSession);
  const [showAgents, setShowAgents] = useState(false);
  if (!open) return null;

  const where = sessionWhere(open);
  return (
    <>
      <div className="session-banner">
        <AgentLogo agent={open.source} className="size-3.5" />
        <span className="session-banner-title">
          {openAgent ? openAgent.title : sessionLabel(open)}
        </span>
        <span className={cn(mono, "session-banner-meta")}>
          {openAgent ? [openAgent.kind, openAgent.model].filter(Boolean).join(" · ") : open.source}
          {!openAgent && where ? ` · ${WHERE_LABEL[where] || where}` : ""}
          {!openAgent && open.branch ? ` · ${open.branch}` : ""}
          {!openAgent && open.version ? ` · ${open.version}` : ""}
          {loading ? " · reading…" : ""}
          {truncated ? " · earliest turns trimmed" : ""}
        </span>
        {/* The subagents this session spawned. The count comes from a readdir
            on the row; the names cost a file each and are fetched only when
            the session is opened. Absent for codex, which records its
            subagent activity inline in the parent rollout instead. */}
        {open.children > 0 ? (
          <button
            type="button"
            className="session-banner-close"
            aria-expanded={showAgents}
            onClick={() => setShowAgents((v) => !v)}
          >
            {open.children} agent{open.children === 1 ? "" : "s"}
          </button>
        ) : null}
        <button
          type="button"
          className="session-banner-close"
          onClick={() => (openAgent ? openSessionAgent(null) : closeSession())}
        >
          {openAgent ? "Back to session" : "Back to live"}
        </button>
      </div>
      {showAgents && agents.length ? (
        <div className="session-agents">
          {agents.map((a) => (
            <button
              type="button"
              key={a.id}
              className="session-agent-row"
              data-active={String(openAgent?.id === a.id)}
              onClick={() => {
                setShowAgents(false);
                openSessionAgent(a);
              }}
            >
              <span className="session-agent-title">{a.title}</span>
              <span className={cn(mono, "session-agent-meta")}>
                {[a.kind, a.model].filter(Boolean).join(" · ")}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
