import { HUES, MODES } from "./constants";
import type { HubEvent, RosterEntry } from "./types";

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m";
  return Math.round(m / 60) + "h";
}

export function agoLabel(ts: number, now: number): string {
  return ago(now - ts) + " ago";
}

export function hhmm(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

export function hueOf(actor: string | undefined | null, roster: RosterEntry[]): string {
  const i = roster.findIndex((r) => r.actor === actor);
  return "var(--who-" + ((i < 0 ? 0 : i) % HUES) + ")";
}

export function verbFor(e: HubEvent): string {
  if (e.kind === "prompt") return "asked";
  if (e.kind === "turn_end") return "finished";
  return e.tool || "working";
}

export function modeLabel(id: string): string {
  return (MODES.find((m) => m.id === id) || {}).label || id;
}

/** The launch-mode selector's `dangerous` tells the style and the hint text. */
export function isDangerMode(id: unknown): boolean {
  return id === "dangerous";
}

/**
 * What a tool call is about, said the way the rest of the board says it:
 * absolute paths are relativised against the open local root, capped length.
 */
export function shortInput(input: unknown, localRoot: string | null): string {
  if (!input || typeof input !== "object") return "";
  const v =
    (input as Record<string, unknown>).file_path ||
    (input as Record<string, unknown>).path ||
    (input as Record<string, unknown>).notebook_path ||
    (input as Record<string, unknown>).command ||
    (input as Record<string, unknown>).pattern ||
    "";
  let text = String(v);
  if (localRoot) {
    const norm = text.split("\\").join("/");
    const root = localRoot.split("\\").join("/").replace(/\/+$/, "");
    if (norm.toLowerCase().indexOf(root.toLowerCase() + "/") === 0) {
      text = norm.slice(root.length + 1);
    }
  }
  return text.slice(0, 90);
}

/**
 * A token count, short enough for a status line.
 *
 * ⚠️ IT USED TO ROUND EVERYTHING UNDER A MILLION TO WHOLE THOUSANDS, which got
 * both ends wrong: 400 tokens printed "0k" and 500 printed "1k", so a run that
 * had just started read as having spent nothing or twice what it had; and
 * 999,500 printed "1000k" rather than "1.0M", which is both wrong-looking and
 * four characters wider than the 258px strip budgets for.
 */
export function tokens(n: number): string {
  if (n >= 999_500) return (n / 1_000_000).toFixed(1) + "M";
  if (n < 1_000) return String(Math.round(n));
  return (n / 1_000).toFixed(0) + "k";
}

export function tint(v: number, warn: number, bad: number): string {
  return v >= bad ? "bad" : v >= warn ? "warn" : "ok";
}

/** Eight steps of block, the same device statusline.py uses. */
export function bar(pct: number, width: number): string {
  const w = width || 8;
  const filled = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
  const B = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
  let out = "";
  for (let i = 0; i < w; i++) out += i < filled ? B[B.length - 1] : B[0];
  return out;
}

/** An agent's Alt-text (a.k.a. the console head) noun. */
export function agentNoun(agent: string): string {
  return agent.replace(/[-_]/g, " ");
}

export function launchNoun(n: number): string {
  return n ? "Another " : "Start ";
}

export function classifyAgentPayloadLine(
  payload: {
    type?: string;
    message?: { content?: unknown[] };
    part?: { type?: string; text?: string; tool?: string; state?: { title?: string; input?: unknown }; reason?: string; tokens?: unknown };
    error?: { message?: string; name?: string };
    text?: string;
    terminal_reason?: string;
    subtype?: string;
  },
  localRoot: string | null,
): Array<[ConsoleLinePartKind, string]> {
  const out: Array<[ConsoleLinePartKind, string]> = [];
  const p = payload || {};
  if (p.type === "assistant" && p.message && Array.isArray(p.message.content)) {
    for (const part of p.message.content as Array<Record<string, unknown>>) {
      if (part.type === "text" && part.text) out.push(["out", String(part.text)]);
      if (part.type === "tool_use") {
        out.push(["tool", String(part.name) + "  " + shortInput(part.input, localRoot)]);
      }
    }
  } else if (p.type === "result") {
    out.push(["meta", "turn finished (" + (p.terminal_reason || p.subtype || "done") + ")"]);
  } else if (p.type === "text" && p.part && p.part.type === "text" && p.part.text) {
    out.push(["out", p.part.text]);
  } else if (p.type === "tool_use" && p.part && p.part.type === "tool") {
    const ost = p.part.state || {};
    const about = ost.title || shortInput(ost.input, localRoot);
    out.push(["tool", (p.part.tool || "tool") + (about ? "  " + about : "")]);
  } else if (p.type === "step_finish") {
    out.push(["meta", "turn finished (" + ((p.part && p.part.reason) || "done") + ")"]);
  } else if (p.type === "error") {
    const e = p.error;
    out.push(["err", (e && (e.message || e.name)) || "agent error"]);
  }
  return out;
}

export type ConsoleLinePartKind = "out" | "tool" | "err" | "meta";