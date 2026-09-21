import { Fragment, type ReactNode } from "react";
import { useBoard, selectStrip } from "../lib/board";
import type { Conn } from "../lib/types";

/* `bar` and `tint` went with ctx and cache. They drew the sparkline and the
   ok/warn/bad colour for exactly those two segments, and both moved to the
   composer's row - where the numbers belong to one console rather than to
   whichever agent spoke last. Nothing else on this strip is a proportion, so
   a bar helper with no caller is the kind of thing that gets re-used badly
   later. Deleted rather than left behind. */

/** Same rounding as lib/fmt.ts § tokens, and for the same reason — see the
 *  warning there. This copy takes a nullable, which that one does not. */
function tokens(n: number | null | undefined) {
  if (n == null) return "";
  if (n >= 999500) return (n / 1000000).toFixed(1) + "M";
  if (n < 1000) return String(Math.round(n));
  return (n / 1000).toFixed(0) + "k";
}

export function connLabel(c: Conn) {
  if (c === "live") return "live";
  if (c === "down") return "down";
  return "connecting";
}

function Seg({ children }: { children: ReactNode }) {
  return <span className="seg">{children}</span>;
}

function Sp({ cls, text }: { cls?: string; text: string | number }) {
  return <span className={cls}>{text}</span>;
}

export function Strip() {
  const { live, machine } = useBoard(selectStrip);
  const conn = useBoard((s) => s.conn);
  const segs: ReactNode[] = [];

  if (live.model) segs.push(<Seg key="model"><Sp cls="dim" text={live.model} /></Seg>);

  const repo = machine && machine.repo;
  if (repo && repo.branch) {
    const r: ReactNode[] = [<Sp key="br" cls="v" text={repo.branch} />];
    if (repo.sha) r.push(<Sp key="sh" cls="dim" text={"@" + repo.sha} />);
    if (repo.ahead) r.push(<Sp key="a" cls="warn" text={"\u2191" + repo.ahead} />);
    if (repo.behind) r.push(<Sp key="be" cls="warn" text={"\u2193" + repo.behind} />);
    segs.push(<Seg key="repo">{r}</Seg>);
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

  const burn = machine && (machine.burn as { "5h"?: { tokens?: number }; "7d"?: { tokens?: number }; cost?: number } | undefined);
  if (burn) {
    const b: ReactNode[] = [<Sp key="k" cls="k" text="spent" />];
    (["5h", "7d"] as const).forEach((w) => {
      if (burn[w] && burn[w].tokens) {
        b.push(<Sp key={w} cls="dim" text={w} />);
        b.push(<Sp key={w + "v"} cls="v" text={tokens(burn[w].tokens)} />);
      }
    });
    if (b.length > 1) segs.push(<Seg key="spent">{b}</Seg>);
  }

  const cost = burn && typeof burn.cost === "number" && burn.cost > 0 ? burn.cost : live.cost;
  if (typeof cost === "number" && cost > 0) {
    segs.push(<Seg key="cost"><Sp cls="dim" text={"$" + cost.toFixed(2)} /></Seg>);
  }

  if (conn) {
    const cls = conn === "live" ? "ok" : conn === "down" ? "bad" : "warn";
    segs.push(
      <Seg key="conn">
        <Sp cls={cls} text={connLabel(conn)} />
      </Seg>,
    );
  }

  if (machine && typeof machine.cindex === "boolean") {
    segs.push(
      <Seg key="cindex">
        <Sp cls="k" text="cindex" />
        <Sp cls={machine.cindex ? "ok" : "warn"} text={machine.cindex ? "on" : "off"} />
      </Seg>,
    );
  }

  const g = machine && (machine.graph as { state?: string; count?: number | null; head?: string; detail?: string } | undefined);
  if (g && g.state !== "missing") {
    const cls = g.state === "errors" ? "bad" : g.state === "ok" ? "ok" : "warn";
    const gs: ReactNode[] = [<Sp key="k" cls="k" text="graph" />];
    if (g.state === "ok") {
      gs.push(<Sp key="c" cls="ok" text={g.count == null ? "" : g.count} />);
      if (g.head) gs.push(<Sp key="h" cls="dim" text={g.head + (g.detail ? " " + g.detail : "")} />);
    } else {
      gs.push(<Sp key="d" cls={cls} text={(g.count == null ? "" : g.count + " ") + (g.detail || "")} />);
    }
    segs.push(<Seg key="graph">{gs}</Seg>);
  }

  const hook = machine && (machine.hook as { failedAgo?: number } | undefined);
  if (hook && hook.failedAgo != null) {
    segs.push(
      <Seg key="hook">
        <Sp cls="bad" text="hook fail" />
        <Sp cls="dim" text={hook.failedAgo} />
      </Seg>,
    );
  }

  return (
    <div className="strip" id="strip">
      {segs.map((s, i) => (
        <Fragment key={i}>
          {i ? <span className="sep">|</span> : null}
          {s}
        </Fragment>
      ))}
    </div>
  );
}