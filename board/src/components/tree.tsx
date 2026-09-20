import { type CSSProperties, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon, FileIcon, FolderIcon } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { cn } from "@/lib/utils";
import { mono } from "./assistant-ui/elements/surfaces";
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

function StatBadge({ path }: { path: string }) {
  const stats = useBoard(selectStats);
  const localRoot = useBoard((s) => s.localRoot);
  const local = Boolean(bridge.local);
  if (!local || stats.root !== localRoot) return null;
  const lines = stats.lines[path];
  const d = stats.diff && stats.diff[path];
  if (lines == null && !d) return null;

  // The diff-stat treatment is elements/file-tree's: tabular numerals, its
  // emerald/red pair, and the same order. zevet adds the two things that
  // element has no notion of — an untracked file, and a line count.
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
      if (d.added)
        parts.push(
          <span className="text-emerald-600 dark:text-emerald-400" key="a">
            +{d.added}
          </span>,
        );
      if (d.removed)
        parts.push(
          <span className="text-red-600 dark:text-red-400" key="d">
            {"\u2212" + d.removed}
          </span>,
        );
    }
  }
  if (lines != null) parts.push(
    <span className="loc" key="loc">
      {lines}
    </span>,
  );
  if (!parts.length) return null;
  return <span className={cn(mono, "stat shrink-0 tabular-nums")}>{parts}</span>;
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
        // The element's own indent formula, in the units it uses.
        style={{ paddingInlineStart: `${0.85 + depth * 0.85}rem` }}
        onClick={() => {
          if (isDir) setCollapsed(path, !open);
          else toggleSelection(path);
        }}
      >
        <span className="label">
          {isDir ? (
            open ? (
              <ChevronDownIcon className="text-foreground/25 size-3 shrink-0" />
            ) : (
              <ChevronRightIcon className="text-foreground/25 size-3 shrink-0" />
            )
          ) : null}
          {isDir ? (
            <FolderIcon className="text-foreground/35 size-3.5 shrink-0" />
          ) : (
            <FileIcon className="text-foreground/30 size-3.5 shrink-0" />
          )}
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

/** elements/file-tree's header line: how much changed, in one row. The data
 *  was already in the store and the old tree never said it. */
function TreeSummary() {
  const stats = useBoard(selectStats);
  const diff = stats.diff || {};
  const paths = Object.keys(diff);
  if (!paths.length) return null;
  let added = 0;
  let removed = 0;
  for (const p of paths) {
    const d = diff[p];
    if (!d) continue;
    added += typeof d.added === "number" ? d.added : 0;
    removed += typeof d.removed === "number" ? d.removed : 0;
  }
  return (
    <div className="flex items-baseline justify-between px-4 pt-1 pb-2">
      <span className="text-[12.5px] font-medium">{paths.length} files changed</span>
      <span className={cn(mono, "tabular-nums")}>
        <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>{" "}
        <span className="text-red-600 dark:text-red-400">{"\u2212"}{removed}</span>
      </span>
    </div>
  );
}

const FOLLOW_LABEL: Record<string, string> = {
  mine: "Follow mine",
  all: "Follow all",
  off: "Follow off",
};

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
        {/* Was a native <select>. On Windows the OS draws that popup in its own
            colours, so in dark mode it opened as a white menu — the one piece
            of the board that never followed the theme. */}
        {!blanked ? (
          <Select
            value={followMode}
            onValueChange={(v: string | null) => { if (v) setFollowMode(v as "mine" | "all" | "off"); }}
          >
            <SelectTrigger id="followSel" className="follow" size="sm" aria-label="Follow agent activity">
              <SelectValue>{(v: string) => FOLLOW_LABEL[v] ?? v}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(FOLLOW_LABEL).map(([value, label]) => (
                <SelectItem value={value} key={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      <div className="pane-body" id="treeBody">
        <div className="tree" id="tree">
          {!blanked && any ? <TreeSummary /> : null}
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
                  <p>Reconnecting… Check the hub if this continues.</p>
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