import { type CSSProperties, type ReactNode, useMemo } from "react";
import { FileIcon, FolderIcon } from "lucide-react";
import { Twist } from "./twist";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { cn } from "@/lib/utils";
import { mono } from "./assistant-ui/elements/surfaces";
import {
  buildTree,
  fileEvents,
  collisionSet,
  hueOf,
  selectCollapsed,
  selectEvents,
  selectStats,
  toggleSelection,
  useBoard,
} from "../lib/board";
import type { TreeNode } from "../lib/board";
import { spritesByPath } from "../lib/roster.mjs";
import { bridge } from "../lib/bridge";
import { ago } from "../lib/text";

function StatBadge({ path }: { path: string }) {
  const stats = useBoard(selectStats);
  const localRoot = useBoard((s) => s.localRoot);
  const local = Boolean(bridge.local);
  if (!local || stats.root !== localRoot) return null;
  const d = stats.diff && stats.diff[path];
  if (!d) return null;

  // The diff-stat treatment is elements/file-tree's: tabular numerals, its
  // emerald/red pair, and the same order. zevet adds the two things that
  // element has no notion of — an untracked file.
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
          binary
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
  if (!parts.length) return null;
  return <span className={cn(mono, "stat shrink-0 tabular-nums")}>{parts}</span>;
}

type SpriteMap = ReturnType<typeof spritesByPath>;

/**
 * The agent-figure SVG from `window.zevetSprites`, tinted to the actor's
 * colour. Decorative next to a filename that already says what it is, so
 * it is `aria-hidden` with the explanation on `title` instead.
 *
 * ⚠️ THE ONE TRUSTED SOURCE. `spriteFor`'s return is first-party markup from
 * our own bundle (agent-sprites.js), safe for `dangerouslySetInnerHTML` —
 * but `actor`/`tool` are event-derived strings, so they go on `title`, a
 * plain text prop, and nowhere near the HTML string.
 */
function AgentSprite({ actor, tool }: { actor: string; tool?: string }) {
  const spriteFor = window.zevetSprites?.spriteFor;
  if (!spriteFor) return null; // no bundle script, or a plain browser tab
  const svg = spriteFor({ tool, width: 16, height: 14 });
  if (!svg) return null;
  return (
    <span
      className="fsprite"
      aria-hidden="true"
      title={actor + " · " + (tool || "working")}
      style={{ color: hueOf(actor) } as CSSProperties}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function NodeRow({
  node, path, depth, now, sprites,
}: { node: TreeNode; path: string; depth: number; now: number; sprites: SpriteMap }) {
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
  const sprite = !isDir ? sprites[path] : undefined;

  return (
    <>
      <button
        className="node"
        /* ⚠️ EVERY ROW WAS A TAB STOP. A plain button per node, in a tree that
           renders up to 4000 entries — measured 473 in this repo — so Tab out
           of the rail meant 473 presses to reach the conversation, and a
           screen reader was told "button" with no level, no expanded state and
           no selection. The tree is now one tab stop with arrow keys inside
           it; see TreeFill for the handler. */
        role="treeitem"
        tabIndex={-1}
        aria-level={depth + 1}
        aria-expanded={isDir ? open : undefined}
        aria-selected={isDir ? undefined : selectedPath === path}
        data-kind={node.kind}
        data-collide={String(Boolean(collisionSet()[path]))}
        data-touched={String(addicts.length > 0)}
        data-sel={String(!isDir && selectedPath === path)}
        // The element's own indent formula, in the units it uses.
        style={{ paddingInlineStart: `${0.85 + depth * 0.85}rem` }}
        onClick={() => {
          // `open` IS the new collapsed state: this row is open, so collapse
          // it. Passing `!open` wrote the current value back — see board.ts.
          if (isDir) setCollapsed(path, open);
          else toggleSelection(path);
        }}
      >
        <span className="label">
          {isDir ? <Twist open={open} /> : null}
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
        {sprite ? <AgentSprite actor={sprite.actor} tool={sprite.tool} /> : null}
      </button>
      {isDir && open ? (
        <TreeChildren node={node} depth={depth + 1} prefix={path} now={now} sprites={sprites} />
      ) : null}
    </>
  );
}

/**
 * Arrow keys for the tree, APG "Tree View Pattern".
 *
 * Driven off the DOM rather than off the store, because the rendered rows ARE
 * the flattened, ordered, currently-visible list — a collapsed directory's
 * children are not in the document, which is exactly what Down should skip.
 * Reproducing that from `built` would mean re-deriving the traversal and
 * keeping the two in step.
 */
function treeKeys(e: React.KeyboardEvent<HTMLDivElement>): void {
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  if (!items.length) return;
  const cur = items.indexOf(document.activeElement as HTMLElement);
  const go = (i: number) => {
    const el = items[Math.max(0, Math.min(items.length - 1, i))];
    if (!el) return;
    el.focus();
    el.scrollIntoView({ block: "nearest" });
  };
  const here = items[cur];
  const expanded = here ? here.getAttribute("aria-expanded") : null;

  if (e.key === "ArrowDown") { e.preventDefault(); go(cur + 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); go(cur - 1); }
  else if (e.key === "Home") { e.preventDefault(); go(0); }
  else if (e.key === "End") { e.preventDefault(); go(items.length - 1); }
  else if (e.key === "ArrowRight") {
    if (!here) return;
    e.preventDefault();
    // Closed folder opens; open folder steps into it; a file has nowhere to go.
    if (expanded === "false") here.click();
    else if (expanded === "true") go(cur + 1);
  } else if (e.key === "ArrowLeft") {
    if (!here) return;
    e.preventDefault();
    if (expanded === "true") {
      // Focus stays put: collapsing removes the children below, not this row.
      here.click();
      return;
    }
    const lvl = Number(here.getAttribute("aria-level") || 1);
    for (let i = cur - 1; i >= 0; i--) {
      if (Number(items[i].getAttribute("aria-level") || 1) < lvl) return go(i);
    }
  }
}

/** The tree is one tab stop. Landing on it puts focus on the selected row, or
 *  the first one — a wrapper that kept focus itself would be a dead end. */
function treeFocus(e: React.FocusEvent<HTMLDivElement>): void {
  if (e.target !== e.currentTarget) return;
  const sel = e.currentTarget.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]');
  const first = e.currentTarget.querySelector<HTMLElement>('[role="treeitem"]');
  (sel || first)?.focus();
}

function TreeChildren({
  node, depth, prefix, now, sprites,
}: { node: TreeNode; depth: number; prefix: string; now: number; sprites: SpriteMap }) {
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
        return <NodeRow key={path} node={child} path={path} depth={depth} now={now} sprites={sprites} />;
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

/**
 * Which agents' file activity the tree follows.
 *
 * ⚠️ RENDERED BY App.tsx, BESIDE "People" - not by the tree. It used to sit in
 * the Files column's own header, which was then a whole `.pane-title` row
 * holding nothing else. Andrew: "move the follow mine/all/off to next to
 * people, so you can move the file tree up." It reads as a People control
 * anyway: mine/all/off is a statement about WHOSE work to watch.
 */
export function FollowControl({ blanked }: { blanked?: boolean }) {
  const followMode = useBoard((s) => s.followMode);
  const setFollowMode = useBoard((s) => s.setFollowMode);
  if (blanked) return null;
  return (
    /* Was a native <select>. On Windows the OS draws that popup in its own
       colours, so in dark mode it opened as a white menu - the one piece of
       the board that never followed the theme. */
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
  );
}

export function TreeFill({ blanked }: { blanked?: boolean }) {
  const needsToken = useBoard((s) => s.needsToken);
  const conn = useBoard((s) => s.conn);
  const localTruncated = useBoard((s) => s.localTruncated);
  const events = useBoard(selectEvents);
  const followMode = useBoard((s) => s.followMode);
  const myActor = useBoard((s) => s.myActor);
  const selectedRepo = useBoard((s) => s.selectedRepo);
  const idleAfterMs = useBoard((s) => s.idleAfterMs);
  const localCheckout = useBoard((s) => s.localCheckout);
  const localRoot = useBoard((s) => s.localRoot);
  /* ⚠️ THE CLOCK, or `now` never moves. `built.now` is read once per render
     and drives both `data-stale` and every "… ago" title, and the only other
     subscription here is to events — so the marks stopped ageing at exactly
     the moment the agents went quiet, which is when you are looking to see
     whether they have. people.tsx keeps its own interval;
     the store already publishes one for everybody. */
  useBoard((s) => s.tick);
  const built = buildTree();
  const any = Object.keys(built.root.children).length > 0;

  /* ⚠️ BUILT ONCE, NOT PER ROW. The tree can run to thousands of rows (4000
     entries measured in this repo — see the tab-stop comment below), so a
     per-row scan of `events` to find "who is on this file right now" would be
     O(rows × events). `spritesByPath` walks `events` a single time; every row
     below just looks its own path up in the result. */
  const sprites = useMemo(
    () => spritesByPath(fileEvents(), { repoName: selectedRepo, followMode, myActor, now: built.now, idleAfterMs }),
    [events, selectedRepo, followMode, myActor, built.now, idleAfterMs, localCheckout, localRoot],
  );

  return (
    <div className="treecol">
      {/* !! NO HEADER ROW, so the tree starts at the top of its column.
          Andrew: "move the follow mine/all/off to next to people, so you can
          move the file tree up." The row held a screen-reader-only title and
          the follow control, and the control now lives beside People - see
          FollowControl above.

          WHAT IS LEFT IS A GRIP, and it has to be. `.pane-title` carries
          `-webkit-app-region: drag`, and the native caption is hidden (see
          the title bar note in masora.css), so these strips are the only
          thing holding this window. Deleting the row outright would leave the
          middle third of the window's top edge ungrabbable - and put a
          clickable file row exactly where someone aims to move the window.
          10px instead of 40. */}
      <div className="pane-title treecol-grip" aria-hidden="true" />
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
                  <h2>{"Disconnected."}</h2>
                  <p>Reconnecting…</p>
                </>
              ) : (
                <>
                  <h2>No activity yet</h2>
                  <p>Open a folder to get started.</p>

                </>
              )}
            </div>
          ) : any ? (
            <div
              className="tree-items"
              role="tree"
              aria-label="Files"
              tabIndex={0}
              onKeyDown={treeKeys}
              onFocus={treeFocus}
            >
              <TreeChildren node={built.root} depth={0} prefix="" now={built.now} sprites={sprites} />
            </div>
          ) : (
            <div className="empty-tree">
              {needsToken ? "Sign in to see what the team is working on." : "No files touched yet."}
            </div>
          )}
          {/* The list is partial, said at the end of the list it is about.
              This used to be written into `localError` and rendered in the
              rail, under the folder picker, styled as a fault - so opening a
              large repo put "showing the first 4000 entries" in the bottom
              corner as if something had gone wrong. It is a fact about THIS
              column. */}
          {!blanked && localTruncated ? (
            <div className="tree-partial">{localTruncated}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
