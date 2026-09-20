import { type CSSProperties, type ReactNode } from "react";
import {
  buildTree,
  collisionSet,
  hueOf,
  selectCollapsed,
  selectEvents,
  selectStats,
  toggleSelection,
  useBoard,
} from "../lib/board";
import type { TreeNode } from "../lib/board";
import { bridge } from "../lib/bridge";
import { ago } from "../lib/text";
import { FILE_SVG } from "./marks";

function StatBadge({ path }: { path: string }) {
  const stats = useBoard(selectStats);
  const localRoot = useBoard((s) => s.localRoot);
  const local = Boolean(bridge.local);
  if (!local || stats.root !== localRoot) return null;
  const lines = stats.lines[path];
  const d = stats.diff && stats.diff[path];
  if (lines == null && !d) return null;

  const parts: ReactNode[] = [];
  if (d && d.status === "untracked") {
    parts.push(
      <span className="new" key="new">
        new
      </span>,
    );
  } else if (d) {
    if (d.added == null && d.removed == null) {
      parts.push(
        <span className="new" key="bin">
          bin
        </span>,
      );
    } else {
      if (d.added) parts.push(<span className="add" key="a">+{d.added}</span>);
      if (d.removed) parts.push(<span className="del" key="d">{"\u2212" + d.removed}</span>);
    }
  }
  if (lines != null) parts.push(
    <span className="loc" key="loc">
      {lines}
    </span>,
  );
  if (!parts.length) return null;
  return <span className="stat">{parts}</span>;
}

function NodeRow({ node, path, depth, now }: { node: TreeNode; path: string; depth: number; now: number }) {
  const collapsed = useBoard(selectCollapsed);
  const setCollapsed = useBoard((s) => s.setCollapsed);
  const selectedPath = useBoard((s) => s.selectedPath);
  const selectedActor = useBoard((s) => s.selectedActor);
  const idleAfterMs = useBoard((s) => s.idleAfterMs);
  const isDir = node.kind === "dir";
  const open = !collapsed[path];
  const addicts = Object.keys(node.who);
  const marks = addicts
    .filter((a) => !selectedActor || a === selectedActor)
    .sort((a, b) => node.who[b] - node.who[a])
    .slice(0, 4);

  return (
    <>
      <button
        className="node"
        data-kind={node.kind}
        data-collide={String(Boolean(collisionSet()[path]))}
        data-touched={String(addicts.length > 0)}
        data-sel={String(!isDir && selectedPath === path)}
        style={{ paddingLeft: 16 + depth * 14 + "px" }}
        onClick={() => {
          if (isDir) setCollapsed(path, !open);
          else toggleSelection(path);
        }}
      >
        <span className="label">
          <span className="caret">{isDir ? (open ? "\u25be" : "\u25b8") : ""}</span>
          {!isDir ? <span className="ficon-wrap" dangerouslySetInnerHTML={{ __html: FILE_SVG }} /> : null}
          <span className="name">{node.name}</span>
        </span>
        {!isDir ? <StatBadge path={path} /> : null}
        <span className="marks">
          {marks.map((a) => (
            <span
              key={a}
              className="mark"
              style={{ "--who": hueOf(a) } as CSSProperties}
              data-stale={String(now - node.who[a] > idleAfterMs)}
              title={a + " \u00b7 " + ago(now - node.who[a]) + " ago"}
            />
          ))}
        </span>
      </button>
      {isDir && open ? <TreeChildren node={node} depth={depth + 1} prefix={path} now={now} /> : null}
    </>
  );
}

function TreeChildren({ node, depth, prefix, now }: { node: TreeNode; depth: number; prefix: string; now: number }) {
  const names = Object.keys(node.children).sort((a, b) => {
    const A = node.children[a];
    const B = node.children[b];
    if (A.kind !== B.kind) return A.kind === "dir" ? -1 : 1;
    return a.localeCompare(b);
  });
  return (
    <>
      {names.map((name) => {
        const child = node.children[name];
        const path = prefix ? prefix + "/" + name : name;
        return <NodeRow key={path} node={child} path={path} depth={depth} now={now} />;
      })}
    </>
  );
}

export function TreeFill({ blanked }: { blanked?: boolean }) {
  const selectedRepo = useBoard((s) => s.selectedRepo);
  const needsToken = useBoard((s) => s.needsToken);
  const conn = useBoard((s) => s.conn);
  const followMode = useBoard((s) => s.followMode);
  const setFollowMode = useBoard((s) => s.setFollowMode);
  useBoard(selectEvents);
  const built = buildTree();
  const any = Object.keys(built.root.children).length > 0;

  return (
    <div className="treecol">
      <div className="pane-title row">
        <span id="filesTitle">{selectedRepo ? "Files \u2014 " + selectedRepo : "Files"}</span>
        {!blanked ? (
          <select
            id="followSel"
            className="follow"
            aria-label="Follow agent activity"
            value={followMode}
            onChange={(ev) => setFollowMode(ev.target.value as "mine" | "all" | "off")}
          >
            <option value="mine">Follow mine</option>
            <option value="all">Follow all</option>
            <option value="off">Follow off</option>
          </select>
        ) : null}
      </div>
      <div className="pane-body" id="treeBody">
        <div className="tree" id="tree">
          {blanked ? (
            <div className="blank">
              {needsToken ? (
                <>
                  <h2>Not signed in.</h2>
                  <p>Open your invitation link or sign in through the desktop app.</p>
                </>
              ) : conn === "down" ? (
                <>
                  <h2>{"Can't reach the hub."}</h2>
                  <p>Reconnecting\u2026 Check the hub if this continues.</p>
                </>
              ) : (
                <>
                  <h2>No activity yet</h2>
                  <p>Open a folder or start an agent in a connected repo.</p>
                  <p>
                    To wire a repo: <code>node client/install.mjs &lt;repo&gt;</code>
                  </p>
                </>
              )}
            </div>
          ) : any ? (
            <TreeChildren node={built.root} depth={0} prefix="" now={built.now} />
          ) : (
            <div className="empty-tree">
              {needsToken ? "Sign in to see what the team is working on." : "No files touched yet. Shows where agents read and edit \u2014 never file contents."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}