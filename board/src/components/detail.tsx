import { type CSSProperties, type ReactNode } from "react";
import {
  hueOf,
  scoped,
  selectCollisions,
  selectEdView,
  selectEvents,
  serverNow,
  useBoard,
} from "../lib/board";
import type { EditorViewState } from "../lib/board";
import { bridge } from "../lib/bridge";
import { Checkpoints, Schedules } from "./repoviews";
import { SessionsPane } from "./sessions";
import { CommitActivity, RepoTimeline } from "./historyviews";
import { Memories } from "./runspec";
import { IndexSearch } from "./search";
import { TurnDetail } from "./turndetail";
import { agoText, hhmm, verbFor } from "../lib/text";

function CollideBars() {
  const collisions = useBoard(selectCollisions);
  const selectedRepo = useBoard((s) => s.selectedRepo);
  const now = serverNow();
  return (
    <div id="collisions">
      {collisions
        .filter((c) => !selectedRepo || !c.repo || c.repo === selectedRepo)
        .slice(0, 3)
        .map((c) => (
          <div className="collide-bar" key={c.target}>
            <span className="file mono">{c.target}</span>
            <span className="who-list">
              {(c.actors || []).map((a) => (
                <span key={a.actor} style={{ "--who": hueOf(a.actor) } as CSSProperties}>
                  <b>{a.label || a.actor}</b>{" "}
                  <span className="who-ago">{agoText(now, a.ts)}</span>
                </span>
              ))}
            </span>
          </div>
        ))}
    </div>
  );
}

function EditorPane({ e }: { e: EditorViewState }) {
  const docStatus = useBoard((s) => s.docStatus);
  const canShare = bridge.canShare;
  const st = canShare ? docStatus[e.room] || { state: "connecting", detail: "" } : { state: "solo", detail: "" };
  const label =
    st.state === "open" ? "shared" :
    st.state === "connecting" ? "connecting" :
    st.state === "retrying" ? "reconnecting" :
    st.state === "undecipherable" ? "could not sync" :
    st.state === "error" ? (st.detail || "not shared") : st.state;

  return (
    <div className="ed">
      <div className="ed-bar">
        <span>{e.relPath}</span>
        {e.truncated ? <span className="ed-note">too large to edit {"\u2014 "}showing the first part, read-only</span> : null}
        <span className="grow" />
        <span className="ed-saved" id="edSaved" data-dirty={String(e.dirty)}>
          {e.error ? e.error : e.saving ? "saving\u2026" : e.dirty ? "unsaved" : e.savedAt ? "saved" : ""}
        </span>
        <span className="ed-state" data-state={st.state} title={st.detail || undefined}>
          <span className="dot" />
          <span>{label}</span>
        </span>
      </div>
{e.loading ? (
        <div className="ed-note">reading…</div>
      ) : e.error ? (
        <div className="ed-note">{e.error}</div>
      ) : (
        <div className="ed-host" id="edHost">
          <div className="riders" id="riders" />
        </div>
      )}
    </div>
  );
}

function ViewPane({ selectedPath }: { selectedPath: string }) {
  const localFile = useBoard((s) => s.localFile);
  const localRoot = useBoard((s) => s.localRoot);
  const local = Boolean(bridge.local);
  if (!local || !localRoot || !localFile || localFile.path !== selectedPath) return null;
  if (localFile.error) {
    return (
      <div className="viewer err">
        <span>{localFile.error}</span>
      </div>
    );
  }
  const w = window.zevetHighlight;
  const text = localFile.text;
  if (text == null) {
    return (
      <div className="viewer loading">
        <span>reading...</span>
      </div>
    );
  }
  const lang = w && w.languageFor ? w.languageFor(selectedPath) : "plain";
  /* ⚠️ NO HIGHLIGHTER IS NOT NO FILE. The fallback here was `""`, so whenever
     the highlighter had not loaded — a build without it, a slow chunk, a
     failed import — clicking a file gave you an empty code block with no
     error and nothing to suggest the text had in fact been read.

     And the fallback is rendered as TEXT, not through dangerouslySetInnerHTML.
     File contents are not ours: dropping them into innerHTML unescaped would
     make any repo containing a <script> tag an injection into the board. */
  if (!w || !w.highlight) {
    return (
      <div className="viewer">
        <pre className="code">{text}</pre>
        {localFile.truncated ? <div className="viewer-note">truncated {"— "}showing the first part of the file</div> : null}
      </div>
    );
  }
  return (
    <div className="viewer">
      <pre className="code" dangerouslySetInnerHTML={{ __html: w.highlight(text, lang) }} />
      {localFile.truncated ? <div className="viewer-note">truncated {"\u2014 "}showing the first part of the file</div> : null}
    </div>
  );
}

export function DetailPane({ blanked }: { blanked?: boolean }) {
  const selectedPath = useBoard((s) => s.selectedPath);
  const ed = useBoard(selectEdView);
  const localFile = useBoard((s) => s.localFile);
  useBoard(selectEvents);
  const local = Boolean(bridge.local);

  let body: ReactNode;
  let title = "Nothing selected";
  if (blanked) {
    body = null;
  } else if (!selectedPath) {
    body = (
      <div className="blank">
        <h2>Pick a file.</h2>
        {/* Keep repository tools available without turning the empty pane into
            a dashboard. Settings has the editable preferences; connection
            notices already report setup problems without a readiness score. */}
        <details className="blank-repo">
          <summary>Project</summary>
          {/* ⚠️ THIS USED TO BE A COLLAPSED ROW UNDER THE CHAT BOX, and it
              opened downward into the conversation. Andrew: "all of those
              dropdowns pop up under the chatbox, which are all superfluous.
              delete what it did, find, and read aloud."

              Find and read-aloud are deleted. This one is MOVED rather than
              deleted, and the difference is worth saying: it is not a panel,
              it is the host for eighteen of them — what the turn read, what it
              cited, what it ran, its raw output, its subagents, its run spec,
              and asking again from here. Deleting it would have taken all
              eighteen with it. This column is the one built for exactly that,
              and it is no longer under the chat box either way. Say the word
              and it goes. */}
          <TurnDetail />
          <IndexSearch />
          {/* ⚠️ EVERY SESSION EVER RUN ON THIS MACHINE, and it is here rather
              than in the rail because it is four hundred rows and this is the
              column with room for them. Andrew: "once agents are done, they
              should go somewhere like to history — they should not stay
              visualizable in people." People keeps the handful that are still
              being written to; everything else is read here. */}
          <div className="repo-sessions">
            <SessionsPane />
          </div>
          <RepoTimeline />
          <Checkpoints />
          <CommitActivity />
          <Schedules />
          <Memories />
        </details>
      </div>
    );
  } else {
    title = selectedPath;
    if (ed && ed.relPath === selectedPath) {
      body = <EditorPane e={ed} />;
    } else {
      const touching = scoped().filter((e) => e.target === selectedPath);
      const whoLast: Record<string, number> = {};
      touching.forEach((e) => {
        if (!whoLast[e.actor] || e.ts > whoLast[e.actor]) whoLast[e.actor] = e.ts;
      });
      const now = serverNow();
      const summary = (
        <div className="detail-who">
          {Object.keys(whoLast)
            .sort((a, b) => whoLast[b] - whoLast[a])
            .map((a) => (
              <span className="dwho" style={{ "--who": hueOf(a) } as CSSProperties} key={a}>
                <span className="bead" />
                <span>{a}</span>
                <span className="when">{agoText(now, whoLast[a])}</span>
              </span>
            ))}
        </div>
      );
      const list = (
        <div className={local && localFile && !localFile.error ? "detail-events after-code" : "detail-events"}>
          {touching
            .slice(-40)
            .reverse()
            .map((e) => (
              <div className="devent" style={{ "--who": hueOf(e.actor) } as CSSProperties} key={e.id}>
                <span className="dt">{hhmm(e.ts)}</span>
                <span className="da">{e.actor}</span>
                <span className="dv">{e.tool || verbFor(e)}</span>
                <span className="dd mono">{e.detail || ""}</span>
              </div>
            ))}
        </div>
      );
      body = (
        <>
          <ViewPane selectedPath={selectedPath} />
          {summary}
          {list}
        </>
      );
    }
  }

  return (
    <>
      <CollideBars />
      <div className="pane-title" id="detailTitle">
        {title}
      </div>
      <div className="pane-body" id="detail">
        {body}
      </div>
    </>
  );
}