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
import { MULTI_TURN } from "./constants";

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
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "t3",
          name: "Edit",
          input: {
            file_path: "board/src/lib/roster.mjs",
            old_string: "const seen = [];\nfor (const a of actors) seen.push(a);",
            new_string: "const seen = new Set(actors.map((a) => a.actor));",
          },
        },
      ],
    },
  },
  {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "Applied 1 edit." }] },
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "t4",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "Find where collisions are grouped", status: "completed" },
              { content: "Dedupe by actor, not by machine", status: "in_progress" },
              { content: "Re-run the roster suite", status: "pending" },
            ],
          },
        },
      ],
    },
  },
  {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t4", content: "ok" }] },
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t5", name: "Grep", input: { pattern: "liveActorsOf", glob: "**/*.mjs" } },
      ],
    },
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t5",
          content: "board/src/lib/roster.mjs:41:export function liveActorsOf(\nboard/src/lib/board.ts:903:  const live = liveActorsOf(\ntest/roster.test.mjs:18:  liveActorsOf,",
        },
      ],
    },
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "t6",
          name: "Task",
          input: { subagent_type: "code-reviewer", description: "Review the dedupe change for off-by-one" },
        },
      ],
    },
  },
  {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t6", content: "No issues found." }] },
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t7", name: "Bash", input: { command: "npm test" } },
      ],
    },
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t7", content: "943 passing\n0 failing" }],
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

/**
 * A replay of the same script with fresh tool ids.
 *
 * The scripts hard-code t1..t7, and a second prompt replays one into the same
 * transcript — which is how the duplicate-toolCallId crash was found. A real
 * CLI mints new ids per turn; the fixture now does too, so it keeps testing
 * the case rather than re-creating a bug the code already handles.
 */
function freshIds(script: unknown[], run: number): unknown[] {
  if (run <= 1) return script;
  const swap = (v: unknown): unknown => {
    if (typeof v === "string") return /^t\d+$/.test(v) ? `${v}r${run}` : v;
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, swap(x)]));
    }
    return v;
  };
  return script.map(swap);
}

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
  let replay = 0;

  function play(id: string, agent: string) {
    const script = freshIds(SCRIPTS[agent] ?? CLAUDE_SCRIPT, ++replay);
    script.forEach((payload, i) => {
      setTimeout(() => emit({ id, type: "agent", payload }), 220 * (i + 1));
    });
    // ⚠️ ONLY THE ONE-SHOT AGENTS EXIT. claude reads stream-json line by line
    // and stays open for as many prompts as you send it (agent-console.js
    // § send); codex and opencode take one prompt and close stdin. Exiting
    // after every turn made the multi-turn path untestable here — the composer
    // is correctly disabled against a dead process, so a fixture that always
    // died could never show a second prompt being sent.
    if (!MULTI_TURN.has(agent)) {
      setTimeout(() => emit({ id, type: "exit", code: 0 }), 220 * (script.length + 1));
    }
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
    commits: async () => ({
      ok: true,
      commits: [
        { sha: "15550c4a", subject: "docs: record 0.2.14", at: Date.now() - 4 * 60_000, files: 1 },
        { sha: "117248cf", subject: "release: 0.2.14", at: Date.now() - 9 * 60_000, files: 2 },
        { sha: "f60a203a", subject: "feat(board): the agent panels", at: Date.now() - 41 * 60_000, files: 33 },
        { sha: "ac03ffeb", subject: "fix(board): do not label an attachment twice", at: Date.now() - 95 * 60_000, files: 4 },
      ],
    }),
    schedules: async () => ({
      ok: true,
      schedules: [
        {
          id: "s1",
          name: "Nightly gate",
          prompt: "run npm test and summarise any failure",
          agent: "claude",
          model: "",
          mode: "plan",
          root: ROOT,
          cadence: "1d",
          enabled: true,
          nextAt: Date.now() + 7 * 60 * 60_000,
          history: [
            { id: "r1", at: Date.now() - 17 * 60 * 60_000, ok: true },
            { id: "r2", at: Date.now() - 41 * 60 * 60_000, ok: false },
          ],
        },
        {
          id: "s2",
          name: "Bundle watch",
          prompt: "check hub/public/board.js size and report if it grew",
          agent: "opencode",
          model: "",
          mode: "plan",
          root: ROOT,
          cadence: "4h",
          enabled: false,
          nextAt: Date.now() + 60 * 60_000,
          history: [],
        },
      ],
    }),
    scheduleToggle: async () => ({ ok: true, schedules: [] }),
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
