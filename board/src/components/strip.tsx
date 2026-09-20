import { Fragment, type ReactNode } from "react";
import { useBoard, selectStrip } from "../lib/board";
import type { Conn } from "../lib/types";

const BLOCKS = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";

function bar(pct: number, width = 8) {
  const w = width;
  const filled = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
  let out = "";
  for (let i = 0; i < w; i += 1) out += i < filled ? BLOCKS[BLOCKS.length - 1] : BLOCKS[0];
  return out;
}

function tokens(n: number | null | undefined) {
  if (n == null) return "";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  return (n / 1000).toFixed(0) + "k";
}

function tint(v: number, warn: number, bad: number) {
  return v >= bad ? "bad" : v >= warn ? "warn" : "ok";
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

  if (live.context != null) {
    const k = live.context / 1000;
    const c = tint(k, 180, 300);
    segs.push(
      <Seg key="ctx">
        <Sp cls="k" text="ctx" />
        <Sp cls={c} text={tokens(live.context)} />
        <Sp cls={"bar " + c} text={bar(Math.min(100, k / 3))} />
      </Seg>,
    );
  }

  if (live.cacheHit != null) {
    const h = live.cacheHit;
    segs.push(
      <Seg key="cache">
        <Sp cls="k" text="cache" />
        <Sp cls={h < 50 ? "bad" : h < 85 ? "warn" : "ok"} text={h.toFixed(0) + "%"} />
      </Seg>,
    );
  }

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