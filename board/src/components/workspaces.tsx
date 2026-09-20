import { hueOf, selectRoster, useBoard, workspaces } from "../lib/board";
import { liveActorsOf } from "../lib/roster.mjs";
import { bridge } from "../lib/bridge";
import type { CSSProperties, ReactNode } from "react";

function WsItem({ repoName, selected, onSelect, children }: { repoName: string; selected: boolean; onSelect: () => void; children: ReactNode }) {
  const roster = useBoard(selectRoster);
  const inRepo = liveActorsOf(roster, repoName);
  return (
    <button className="ws-item" data-sel={String(selected)} data-live={String(inRepo.length > 0)} onClick={onSelect}>
      {children}
      {repoName
        ? inRepo.map((r) => (
            <span key={r.actor} className="livedot" style={{ "--who": hueOf(r.actor) } as CSSProperties} title={r.actor} />
          ))
        : null}
    </button>
  );
}

export function WorkspacesPane() {
  const localRoot = useBoard((s) => s.localRoot);
  const localWorkspaces = useBoard((s) => s.localWorkspaces);
  const localError = useBoard((s) => s.localError);
  const selectedRepo = useBoard((s) => s.selectedRepo);
  const openLocalRoot = useBoard((s) => s.openLocalRoot);
  const unsetLocalRoot = useBoard((s) => s.unsetLocalRoot);
  const toggleRepo = useBoard((s) => s.toggleRepo);
  const addWorkspace = useBoard((s) => s.addWorkspace);
  const local = Boolean(bridge.local);

  if (local) {
    return (
      <div className="ws" id="workspaces">
        {(localWorkspaces || []).map((w) => (
          <WsItem
            key={w.dir}
            repoName={w.repo || w.name}
            selected={localRoot === w.dir}
            onSelect={() => {
              if (localRoot === w.dir) unsetLocalRoot();
              else openLocalRoot(w.dir);
            }}
          >
            <span>{w.name}</span>
            <br />
            <span className="branch">{w.repo ? "git repo" : w.dir}</span>
          </WsItem>
        ))}
        <button className="ws-add" type="button" onClick={() => addWorkspace()}>
          Open a folder\u2026
        </button>
        {localError ? <div className="ws-note">{localError}</div> : null}
      </div>
    );
  }

  const list = workspaces();
  return (
    <div className="ws" id="workspaces">
      {list.map((w) => (
        <WsItem key={w.repo} repoName={w.repo} selected={selectedRepo === w.repo} onSelect={() => toggleRepo(w.repo)}>
          <span>{w.repo}</span>
          {w.branch ? (
            <>
              <br />
              <span className="branch">{w.branch}</span>
            </>
          ) : null}
        </WsItem>
      ))}
      {!list.length ? <div style={{ color: "var(--subtle)", fontSize: "12.5px" }}>none yet</div> : null}
    </div>
  );
}