import type { LaunchMode } from "./types";

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

/** Model aliases each CLI accepts. Free text wins; these are a shortcut. */
export const MODELS: Record<string, string[]> = {
  claude: ["", "opus", "sonnet", "haiku"],
  codex: ["", "gpt-5", "gpt-5-codex", "o3"],
  opencode: [
    "",
    "openrouter/cohere/north-mini-code:free",
    "openrouter/poolside/laguna-s-2.1:free",
    "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
  ],
};

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