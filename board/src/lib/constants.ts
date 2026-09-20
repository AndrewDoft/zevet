import type { LaunchMode } from "./types";
import { OPENCODE_FREE_MODELS } from "./models.generated.mjs";

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

/** Model aliases each CLI accepts. Free text wins; these are a shortcut.
 *
 *  claude and codex take short aliases their own CLI resolves, so they stay
 *  written out here. opencode takes a full provider-qualified id, and the free
 *  ids churn weekly — those are generated rather than typed, by
 *  `node scripts/sync-models.mjs`. See models.generated.mjs for the rules. */
export const MODELS: Record<string, string[]> = {
  claude: ["", "opus", "sonnet", "haiku"],
  codex: ["", "gpt-5", "gpt-5-codex", "o3"],
  // "" first: "whatever the CLI defaults to" is a real choice and the launcher
  // labels it as one.
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