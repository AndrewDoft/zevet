/**
 * A fake desktop bridge, for looking at the board.
 *
 * Almost everything interesting in this UI — consoles, transcripts, tool
 * cards, the file tree, the repo strip — only renders when `bridge.local`
 * exists, which means only inside the Electron app, wired to a real repo, with
 * a real agent burning real quota. That made the interior of the board
 * effectively unreviewable: you could not see a tool card without running an
 * agent to produce one.
 *
 * This installs a scripted `window.zevetLocal` instead, replaying recorded
 * event shapes for all three CLIs at a readable pace. It is how every surface
 * gets looked at, in both themes, while it is being built.
 *
 * IT DOES NOT SHIP. The `import.meta.env.DEV` guard is a build-time constant,
 * so rollup drops this module from the production bundle entirely, and
 * test/board-bundle.test.mjs asserts none of its symbols appear in the
 * committed hub/public/board.js. Activate with `?dev=1`.
 */
import type { LocalBridge } from "./bridge";

export const FIXTURE_MARK = "__zevet_fixture_bridge__";

type AgentEvent = {
  id?: string;
  type: string;
  code?: number | null;
  signal?: string | null;
  text?: string;
  payload?: unknown;
};

/** claude `--output-format stream-json`. A turn with reasoning, a successful
 *  tool call, a failing one, and prose either side. */
const CLAUDE_SCRIPT: unknown[] = [
  { type: "system", subtype: "init", model: "claude-opus-5" },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "The collision check reads roster.mjs, so start there rather than in the store." }],
    },
  },
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Looking at how collisions are detected." }] },
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "board/src/lib/roster.mjs", limit: 120 } }],
    },
    usage: { input_tokens: 18240, cache_read_input_tokens: 44100, output_tokens: 310 },
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "export function liveActorsOf(events, now) {\n  // ...\n}" }],
    },
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "`liveActorsOf` already groups by target. The test will show whether it dedupes." },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "node --test test/roster.test.mjs" } },
      ],
    },
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t2", content: "1 failing\n  ✖ dedupes two machines for one actor", is_error: true }],
    },
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "There it is — two machines under one name count twice.\n\n```js\nconst seen = new Set(actors.map((a) => a.actor));\n```\n\nThat is the fix.",
        },
      ],
    },
  },
  { type: "result", subtype: "success", total_cost_usd: 0.1842 },
];

/** opencode `run --format json`. The two-report tool shape, then a finish. */
const OPENCODE_SCRIPT: unknown[] = [
  { type: "step_start" },
  { type: "text", part: { type: "text", text: "Checking the bundle size." } },
  { type: "tool_use", part: { type: "tool", id: "c1", tool: "bash", state: { status: "running", input: { command: "du -h hub/public/board.js" } } } },
  { type: "tool_use", part: { type: "tool", id: "c1", tool: "bash", state: { status: "completed", output: "1.1M\thub/public/board.js" } } },
  { type: "text", part: { type: "text", text: " 1.1 MB, up from 500 kB." } },
  { type: "step_finish", part: { reason: "done" } },
];

/** codex `exec --json`. UNVERIFIED shapes — see INSUF-005. Present here so the
 *  unrecognised-event path can be looked at too. */
const CODEX_SCRIPT: unknown[] = [
  { type: "thread.started", thread_id: "th_1" },
  { type: "item.completed", item: { type: "reasoning", text: "The hub serves board.js verbatim, so the bundle must be committed." } },
  { type: "item.completed", item: { type: "agent_message", text: "Rebuilding the bundle." } },
  {
    type: "item.completed",
    item: { id: "i1", type: "command_execution", command: "node build.mjs", aggregated_output: "built hub/public\n  board.js 1148210 bytes", status: "completed" },
  },
  { type: "some_future_event", detail: "an event this table does not model" },
  { type: "turn.completed", usage: { input_tokens: 9100 } },
];

const SCRIPTS: Record<string, unknown[]> = {
  claude: CLAUDE_SCRIPT,
  opencode: OPENCODE_SCRIPT,
  codex: CODEX_SCRIPT,
};

const ROOT = "C:/dev/GitHub/zevet";

const TREE = [
  { path: "board", kind: "dir" as const, depth: 0 },
  { path: "board/src", kind: "dir" as const, depth: 1 },
  { path: "board/src/App.tsx", kind: "file" as const, depth: 2 },
  { path: "board/src/lib", kind: "dir" as const, depth: 2 },
  { path: "board/src/lib/board.ts", kind: "file" as const, depth: 3 },
  { path: "board/src/lib/roster.mjs", kind: "file" as const, depth: 3 },
  { path: "board/src/lib/transcript.mjs", kind: "file" as const, depth: 3 },
  { path: "hub", kind: "dir" as const, depth: 0 },
  { path: "hub/server.mjs", kind: "file" as const, depth: 1 },
  { path: "README.md", kind: "file" as const, depth: 0 },
];

const SAMPLE = `export function liveActorsOf(events, now) {
  const seen = new Map();
  for (const e of events) {
    if (now - e.ts > WINDOW) continue;
    seen.set(e.actor, e);
  }
  return [...seen.values()];
}
`;

/** Installs the fake bridge. Returns false if it declined to. */
export function installFixtureBridge(): boolean {
  if (!import.meta.env.DEV) return false;
  if (!new URLSearchParams(location.search).has("dev")) return false;

  const listeners: Array<(e: AgentEvent) => void> = [];
  let seq = 0;

  const emit = (e: AgentEvent) => listeners.forEach((cb) => cb(e));

  /** Replay a script at a pace you can actually read, so streaming, the
   *  running spinner and the scroll anchor are all exercised rather than
   *  arriving in one frame. */
  function play(id: string, agent: string) {
    const script = SCRIPTS[agent] ?? CLAUDE_SCRIPT;
    script.forEach((payload, i) => {
      setTimeout(() => emit({ id, type: "agent", payload }), 220 * (i + 1));
    });
    setTimeout(() => emit({ id, type: "exit", code: 0 }), 220 * (script.length + 1));
  }

  const local: LocalBridge = {
    available: true,
    read: async (_root, rel) => ({ ok: true, text: rel.endsWith(".mjs") ? SAMPLE : `// ${rel}\n`, bytes: SAMPLE.length, eol: "\n" }),
    write: async () => ({ ok: true }),
    agents: async () => [
      { name: "claude", ok: true, signedIn: true, detail: "claude 2.1.0" },
      { name: "codex", ok: true, signedIn: true, detail: "codex 0.155.0" },
      { name: "opencode", ok: true, signedIn: false, detail: "opencode 1.18.31" },
    ],
    startAgent: async (name) => {
      const id = `fixture-${++seq}`;
      play(id, name);
      return { ok: true, id };
    },
    sendToAgent: async (id) => {
      play(id, "claude");
      return { ok: true };
    },
    stopAgent: async () => ({ ok: true }),
    watch: async () => ({ ok: true }),
    unwatch: async () => ({ ok: true }),
    diffHunks: async () => ({ ok: true, hunks: [{ start: 12 }] }),
    onFileChanged: () => () => {},
    onAgentEvent: (cb) => {
      listeners.push(cb);
      return () => listeners.splice(listeners.indexOf(cb), 1);
    },
    stats: async () => ({
      ok: true,
      lines: { "board/src/lib/board.ts": 1742, "board/src/lib/roster.mjs": 107, "hub/server.mjs": 1567 },
      diff: { "board/src/lib/board.ts": { status: "M" }, "board/src/lib/transcript.mjs": { status: "A" } },
    }),
    status: async () => ({ ok: true, repo: { branch: "main", sha: "d316794", ahead: 3, behind: 0 } }),
    chrome: () => {},
    addWorkspace: async () => ({ name: "zevet", dir: ROOT, repo: "zevet" }),
    indexStatus: async () => ({ ok: true, enabled: true, indexed: 412 }),
    indexEnable: async () => ({ ok: true, indexed: 412, skipped: 8 }),
    updateCheck: async () => ({ ok: true }),
    updateStatus: async () => ({ phase: "current", current: "0.2.8" }),
    updateInstall: async () => ({ ok: true }),
    onUpdate: () => {},
    onIndexEvent: () => {},
    workspaces: async () => [{ name: "zevet", dir: ROOT, repo: "zevet" }],
    tree: async () => ({ ok: true, entries: TREE }),
  };

  window.zevetLocal = local;
  (window as unknown as Record<string, unknown>)[FIXTURE_MARK] = true;
  return true;
}
