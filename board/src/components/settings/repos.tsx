/**
 * Settings → Repos: every folder this machine has open and every repo the hub
 * has heard from, with what is known about each. All from data the board
 * already holds (localWorkspaces, hub events, the roster) — nothing new is
 * asked of the desktop.
 */
import { hueOf, selectRoster, useBoard, workspaces } from "../../lib/board";
import { liveActorsOf } from "../../lib/roster.mjs";
import { agoLabel } from "../../lib/fmt";
import { bridge } from "../../lib/bridge";
import { PageSection } from "./parts";
import type { CSSProperties } from "react";

export function ReposPanel() {
  const local = useBoard((s) => s.localWorkspaces);
  const localRoot = useBoard((s) => s.localRoot);
  const roster = useBoard(selectRoster);
  const events = useBoard((s) => s.events);
  const addWorkspace = useBoard((s) => s.addWorkspace);
  const repos = workspaces();
  void events; // workspaces() reads the store directly; subscribing here re-renders it.

  const hooked = (repo: string) => events.some((e) => e.repo === repo);
  const rows = new Map<string, { name: string; dir?: string; repo: string; branch?: string; lastTs?: number }>();
  for (const w of local || []) rows.set(w.repo || w.name, { name: w.name, dir: w.dir, repo: w.repo || w.name });
  for (const r of repos) {
    const prev = rows.get(r.repo);
    rows.set(r.repo, { name: prev?.name || r.repo, dir: prev?.dir, repo: r.repo, branch: r.branch, lastTs: r.lastTs });
  }
  const list = [...rows.values()];

  return (
    <PageSection title="Repos" summary={list.length ? String(list.length) : "none"}>
      {!list.length ? <p className="snote">No repos yet. Open a folder{bridge.local ? "" : " in the desktop app"}, or start an agent and it appears here.</p> : null}
      <div className="spage-cards">
        {list.map((r) => {
          const active = liveActorsOf(roster, r.repo);
          return (
            <div className="spage-card" key={r.repo} data-open={r.dir === localRoot ? "true" : undefined}>
              <div className="spage-card-title">
                <strong>{r.name}</strong>
                {r.dir && r.dir === localRoot ? <span className="spage-tag">open</span> : null}
              </div>
              <dl className="spage-dl">
                {r.dir ? (
                  <>
                    <dt>Path</dt>
                    <dd className="mono">{r.dir}</dd>
                  </>
                ) : null}
                <dt>Branch</dt>
                <dd>{r.branch || "unknown"}</dd>
                <dt>Hooks</dt>
                <dd>{hooked(r.repo) ? "Installed (events are arriving)" : "None seen yet"}</dd>
                <dt>Last event</dt>
                <dd>{r.lastTs ? agoLabel(r.lastTs, Date.now()) : "never"}</dd>
                <dt>Active now</dt>
                <dd>
                  {active.length
                    ? active.map((a) => (
                        <span className="spage-who" key={a.actor}>
                          <span className="livedot" style={{ "--who": hueOf(a.actor) } as CSSProperties} />
                          {a.actor}
                        </span>
                      ))
                    : "nobody"}
                </dd>
              </dl>
            </div>
          );
        })}
      </div>
      {bridge.local ? (
        <button className="sbtn" type="button" style={{ marginTop: "14px" }} onClick={() => addWorkspace()}>
          Add a folder…
        </button>
      ) : null}
    </PageSection>
  );
}
