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
  // "" first, everywhere: letting the CLI choose is a real choice, and the
  // picker labels it "CLI Choice" rather than hiding it.
  claude: ["", ...CLAUDE_MODELS.map((m) => m.id)],
  codex: ["", ...CODEX_MODELS.map((m) => m.id)],
  opencode: ["", ...OPENCODE_FREE_MODELS],
};

/** claude reads stream-json line by line and stays open for as many prompts as
 *  you send it. codex and opencode take ONE prompt per run and then close their
 *  stdin (agent-console.js, send, facts 4 and 5). */
export const MULTI_TURN: ReadonlySet<string> = new Set(["claude"]);

export const STATUS_EVERY_MS = 4000;
export const STATS_EVERY_MS = 2500;
export const STATS_MAX_PATHS = 1200;
export const IDLE_FALLBACK = 90000;

export const PANE_LIMITS: Record<string, [number, number]> = {
  rail: [180, 420],
  tree: [200, 560],
};
export const PANE_DEFAULTS: Record<string, number> = { rail: 258, tree: 300 };
export const PANE_KEY = "zevet.panes.v1";

export const HUES = 5;

export const BLOCKS = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";