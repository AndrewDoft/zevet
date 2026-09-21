import type { LaunchMode } from "./types";
import { OPENCODE_FREE_MODELS } from "./models.generated.mjs";
import { CLAUDE_MODELS, CODEX_MODELS } from "./agent-models.generated.mjs";

export const ID: unique symbol = Symbol("id");

export const MODES: { id: LaunchMode; label: string }[] = [
  { id: "plan", label: "Plan only" },
  { id: "ask", label: "Ask first" },
  { id: "auto", label: "Auto" },
  { id: "dangerous", label: "Skip permissions" },
];

/** One line each, for the settings pane. The flags these turn into live in
 *  desktop/agent-console.js MODES; these describe what they MEAN. */
export const MODE_NOTE: Record<string, string> = {
  plan: "Reads and plans. Changes nothing.",
  ask: "Asks before every edit and command.",
  auto: "Edits freely, asks before anything else.",
  dangerous: "Never asks. Full access to this machine.",
};

export const MODE_LABEL: Record<string, string> = Object.fromEntries(
  MODES.map((m) => [m.id, m.label]),
);

/** Model ids each CLI accepts. Free text wins; these are a shortcut.
 *
 *  ⚠️ NONE OF THESE ARE TYPED BY HAND ANY MORE. They were, and all three lists
 *  rotted in place: claude offered "opus/sonnet/haiku" with no Fable, and codex
 *  "gpt-5/gpt-5-codex/o3", none of which that CLI still accepts. Andrew, on the
 *  picker: "the available model names are wrong".
 *
 *  claude and codex are read from the catalogues those CLIs cache on disk
 *  (`node scripts/sync-agent-models.mjs`), which is also where the display
 *  names come from — see lib/models.mjs. opencode has no local catalogue and
 *  its free ids churn weekly, so those come from `node scripts/sync-models.mjs`
 *  and its allowlist rules. */
export const MODELS: Record<string, string[]> = {
  // No "" row here any more. Andrew: "I don't know how CLI choice works as a
  // model selector, but I know that it's not offered by Anthropic... I
  // wouldn't keep it, I would just delete it." `""` still MEANS "pass no
  // --model/-m flag" internally (agent-console.js) — a resumed console
  // legitimately arrives with no model — it is just no longer a row you can
  // pick from this list.
  claude: CLAUDE_MODELS.map((m) => m.id),
  codex: CODEX_MODELS.map((m) => m.id),
  opencode: [...OPENCODE_FREE_MODELS],
};

/** claude reads stream-json line by line and stays open for as many prompts as
 *  you send it. codex and opencode take ONE prompt per run and then close their
 *  stdin (agent-console.js, send, facts 4 and 5). */
export const MULTI_TURN: ReadonlySet<string> = new Set(["claude"]);

export const STATUS_EVERY_MS = 4000;
export const STATS_EVERY_MS = 2500;
export const STATS_MAX_PATHS = 1200;
export const IDLE_FALLBACK = 90000;

/**
 * How recently a session file must have been written to for People to call it
 * one of the agents that is running.
 *
 * ⚠️ THIS IS A WINDOW, NOT A FACT. A session found by scanning
 * ~/.claude/projects and ~/.codex/sessions has no pid attached and neither CLI
 * writes anything when it exits, so there is no way to know a session ended —
 * only that nothing has been appended for a while. Fifteen minutes is wide
 * enough to survive a person reading a diff between turns and narrow enough
 * that yesterday's work is gone from the rail.
 *
 * Deliberately NOT `IDLE_FALLBACK`: that one is the hub's own answer about a
 * live event stream, where silence really does mean idle within 90 seconds. A
 * transcript on disk is a much coarser signal and borrowing the number would
 * quietly claim it is the same kind of evidence.
 */
export const LIVE_SESSION_MS = 15 * 60 * 1000;

export const PANE_LIMITS: Record<string, [number, number]> = {
  rail: [180, 420],
  tree: [200, 560],
};
export const PANE_DEFAULTS: Record<string, number> = { rail: 258, tree: 300 };
export const PANE_KEY = "zevet.panes.v1";

export const HUES = 5;

export const BLOCKS = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";