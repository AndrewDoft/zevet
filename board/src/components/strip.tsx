import { Fragment, type ReactNode } from "react";
import { useBoard, selectStrip } from "../lib/board";
import { bridge } from "../lib/bridge";
import { WorkspacePicker } from "./workspaces";
import { ago } from "../lib/fmt";
import { windowParts } from "../lib/when.mjs";
import type { Conn } from "../lib/types";

/* `bar` and `tint` went with ctx and cache. They drew the sparkline and the
   ok/warn/bad colour for exactly those two segments, and both moved to the
   composer's row - where the numbers belong to one console rather than to
   whichever agent spoke last. Nothing else on this strip is a proportion, so
   a bar helper with no caller is the kind of thing that gets re-used badly
   later. Deleted rather than left behind. */

export function connLabel(c: Conn) {
  if (c === "live") return "live";
  if (c === "down") return "down";
  return "connecting";
}

function Seg({ children }: { children: ReactNode }) {
  return <span className="seg">{children}</span>;
}

function Sp({ cls, text, title }: { cls?: string; text: string | number; title?: string }) {
  return <span className={cls} title={title}>{text}</span>;
}

export function Strip() {
  const { live, machine, limits } = useBoard(selectStrip);
  const conn = useBoard((s) => s.conn);
  const localError = useBoard((s) => s.localError);
  const treeHidden = useBoard((s) => s.treeHidden);
  const setTreeHidden = useBoard((s) => s.setTreeHidden);
  /* ⚠️ THREE LINES, NOT ONE SEGMENT PER LINE. `.strip` is a column, so every
     segment used to take a row of its own and the rail's corner was four
     stacked words. The grouping is by what a glance is actually asking:
     `where` is the repo you are on and whether the hub can hear you;
     `health` is the two local services and their numbers; `rest` is spend and
     anything shouting. Andrew: "put the branch (main) the commit number, and
     live (or not live) on one line. and put cindex and it's number and graph
     and it's number on one line." */
  const where: ReactNode[] = [];
  const health: ReactNode[] = [];
  const rest: ReactNode[] = [];

  /* ⚠️ THE FOLDER PICKER LIVES HERE NOW, at the head of the line that is about
     the repo. It had a row of its own in the rails bottom corner, which named
     the repo a second time a few pixels under the branch that belongs to it.
     Andrew: "just put it to the left of main in that block above with a little
     dropdown next to it ... it is much cleaner and it will take up a lot less
     space."
     Desktop only: with no bridge there is no folder to open, and
     WorkspacesPane still renders the browser repo filter in the rail. */
  if (bridge.local) where.push(<Seg key="repo-pick"><WorkspacePicker /></Seg>);

  /* Beside the repo picker, and only while the tree is actually shut:
     dragging it closed (or Ctrl/Cmd+B) leaves no control on screen that
     opens it again otherwise. Label only, zevet style — no caption under it. */
  if (bridge.local && treeHidden) {
    where.push(
      <Seg key="open-tree">
        <button type="button" className="follow" onClick={() => setTreeHidden(false)}>
          Open tree
        </button>
      </Seg>,
    );
  }

  if (live.model) rest.push(<Seg key="model"><Sp cls="dim" text={live.model} /></Seg>);

  const repo = machine && machine.repo;
  if (repo && repo.branch) {
    const r: ReactNode[] = [<Sp key="br" cls="v" text={repo.branch} />];
    if (repo.sha) r.push(<Sp key="sh" cls="dim" text={"@" + repo.sha} />);
    if (repo.ahead) r.push(<Sp key="a" cls="warn" text={"\u2191" + repo.ahead} />);
    if (repo.behind) r.push(<Sp key="be" cls="warn" text={"\u2193" + repo.behind} />);
    where.push(<Seg key="repo">{r}</Seg>);
  }

  /* ⚠️ ctx AND cache ARE GONE FROM HERE. Both are now on the composer's own
     row, where the run they describe is — context against the model's real
     window, and the cache share of it. Andrew: "now that context (x/1M) is in
     the chatbox, you can remove it from the side bar. same with cache if you
     can add it to the chatbox."
     They were also the two segments that were WRONG here whenever more than
     one console was running: `live` is one global set of numbers, whichever
     agent spoke last, so in a 258px rail they silently described a different
     run from the one you were reading. The composer's copy is attributed to
     its own console (ConsoleEntry.usage) and cannot do that.
     What stays on the strip is what belongs to the machine or the repo rather
     than to one run: branch, ahead/behind, spend windows. */

  /* The account's real 5h/7d windows: percent used and time to reset, off
     claude's own `rate_limit_event`. This used to show zevet's token tally
     for each window ("spent 5h 73k · 7d 73k"), which is not the limit and
     reads identical until the app has been open five hours. */
  const lim: ReactNode[] = [];
  for (const w of limits) {
    const [label, pct, left] = windowParts(w);
    if (lim.length) lim.push(<Sp key={w.key + "sep"} cls="dim" text="·" />);
    lim.push(<Sp key={w.key} cls="dim" text={label} />);
    lim.push(<Sp key={w.key + "v"} cls={w.utilization >= 0.8 ? "warn" : "v"} text={pct} />);
    if (left) lim.push(<Sp key={w.key + "t"} cls="dim" text={left} />);
  }
  if (lim.length) rest.push(<Seg key="limits">{lim}</Seg>);

  const burn = machine && (machine.burn as { cost?: number } | undefined);
  const cost = burn && typeof burn.cost === "number" && burn.cost > 0 ? burn.cost : live.cost;
  if (typeof cost === "number" && cost > 0) {
    rest.push(<Seg key="cost"><Sp cls="dim" text={"$" + cost.toFixed(2)} /></Seg>);
  }

  if (conn) {
    const cls = conn === "live" ? "ok" : conn === "down" ? "bad" : "warn";
    where.push(
      <Seg key="conn">
        <Sp cls={cls} text={connLabel(conn)} />
      </Seg>,
    );
  }

  if (machine && typeof machine.cindex === "boolean") {
    health.push(
      <Seg key="cindex">
        <Sp cls="k" text="cindex" />
        <Sp cls={machine.cindex ? "ok" : "warn"} text={machine.cindex ? "on" : "off"} />
      </Seg>,
    );
  }

  const g = machine && (machine.graph as { state?: string; count?: number | null; head?: string; detail?: string } | undefined);
  // "missing" also covers a corrupt health file (status-sources.js's
  // vaultHealth returns detail "unreadable" for one) — only the true
  // no-file case, which carries no detail, should stay silent.
  if (g && (g.state !== "missing" || g.detail)) {
    const cls = g.state === "errors" ? "bad" : g.state === "ok" ? "ok" : "warn";
    const gs: ReactNode[] = [<Sp key="k" cls="k" text="graph" />];
    if (g.state === "ok") {
      gs.push(<Sp key="c" cls="ok" text={g.count == null ? "" : g.count} />);
      if (g.head) gs.push(<Sp key="h" cls="dim" text={g.head + (g.detail ? " " + g.detail : "")} />);
    } else {
      gs.push(<Sp key="d" cls={cls} text={(g.count == null ? "" : g.count + " ") + (g.detail || "")} />);
    }
    health.push(<Seg key="graph">{gs}</Seg>);
  }

  /* The folder error came here with the picker. It used to sit directly under
     it as a "ws-note" row, and that row went with the block. */
  if (localError) rest.push(<Seg key="wserr"><Sp cls="bad" text={localError} title={localError} /></Seg>);

  const hook = machine && (machine.hook as { failedAgo?: number } | undefined);
  if (hook && hook.failedAgo != null) {
    rest.push(
      <Seg key="hook">
        <Sp cls="bad" text="hook fail" />
        <Sp cls="dim" text={ago(hook.failedAgo * 1000)} />
      </Seg>,
    );
  }

  const line = (key: string, segs: ReactNode[]) =>
    segs.length ? (
      <div className="strip-line" key={key}>
        {segs.map((s, i) => (
          <Fragment key={i}>
            {i ? <span className="sep">|</span> : null}
            {s}
          </Fragment>
        ))}
      </div>
    ) : null;

  return (
    <div className="strip" id="strip">
      {line("where", where)}
      {line("health", health)}
      {line("rest", rest)}
    </div>
  );
}