/**
 * A rendering for each tool the agents actually call.
 *
 * Without these every tool call falls through to ToolFallback, which shows a
 * name and a blob of JSON. That is the difference between watching an agent
 * work and watching it emit `{"file_path":"src/db.ts","old_string":"…"}` —
 * and watching is the entire product.
 *
 * Each one is `makeAssistantToolUI`, which registers a component against a
 * tool NAME. The three CLIs disagree about those names for the same operation
 * (`Bash` / `bash` / `command_execution`), so each rendering is registered
 * under every spelling rather than normalised upstream — a name we have not
 * seen still gets the fallback, which is the correct behaviour for a tool
 * nobody has modelled.
 *
 * The arguments are UNTRUSTED SHAPES. They come from three CLIs across
 * versions, and a renderer that assumes `args.file_path` is a string is a
 * renderer that blanks the transcript on the day one of them ships an array.
 * Everything below goes through the readers at the top, which return a usable
 * default rather than throwing.
 */
import { makeAssistantToolUI } from "@assistant-ui/react";
import type { ReactNode } from "react";
import { useState } from "react";
import { CodeDiff, type DiffLine } from "./assistant-ui/elements/code-diff";
import { FileTree, type FileTreeNode } from "./assistant-ui/elements/file-tree";
import { SubagentList } from "./assistant-ui/elements/subagent-list";
import { TerminalBlock } from "./assistant-ui/elements/terminal-block";
import { TodoList, type TodoItem, type TodoStatus } from "./assistant-ui/elements/todo-list";
import { ToolCall } from "./assistant-ui/elements/tool-call";
import { ToolError } from "./assistant-ui/elements/tool-error";
import { WebSearch, type WebSearchResult } from "./assistant-ui/elements/web-search";

/* ---------------------------------------------------------------------------
 * Readers. Every one answers "what is this, if it is anything".
 * ------------------------------------------------------------------------- */

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function str(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

/** The first of several keys that carries a usable string. The CLIs spell the
 *  same argument differently and have renamed them between versions. */
function pick(args: unknown, ...keys: string[]): string {
  const o = rec(args);
  for (const k of keys) {
    const v = str(o[k]);
    if (v) return v;
  }
  return "";
}

/**
 * A tool result as text.
 *
 * claude sends a string, or an array of content blocks, or an object with a
 * `content` that is either. codex sends `aggregated_output`. opencode sends
 * whatever the tool returned. All of it ends up here.
 */
function resultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map(resultText).filter(Boolean).join("\n");
  const o = rec(result);
  for (const k of ["text", "output", "aggregated_output", "stdout", "content", "result"]) {
    if (o[k] != null) return resultText(o[k]);
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

const lines = (text: string): string[] => (text ? text.replace(/\n+$/, "").split("\n") : []);

/** Paths are long and all begin the same way. The last two segments are what
 *  identifies a file on a line you are skimming. */
function shortPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length <= 2 ? p : parts.slice(-2).join("/");
}

type Status = { type?: string } | undefined;

/** What every rendering below is handed. A superset of the message part. */
type ToolProps = {
  args: unknown;
  result: unknown;
  status: Status;
  /** assistant-ui's own flag, set by transcript.mjs from claude's
   *  tool_result.is_error and opencode's state.status. */
  isError?: boolean;
};

const isRunning = (s: Status) => s?.type === "running";

/** A tool failed if the part says so, if the run did not complete, or if the
 *  result object carries the flag itself — the last for a CLI that reports the
 *  failure in the payload and nowhere else. */
const failed = (p: ToolProps) =>
  p.isError === true ||
  p.status?.type === "incomplete" ||
  (typeof p.result === "object" && p.result !== null && rec(p.result).is_error === true);

/* ---------------------------------------------------------------------------
 * A shared shell, so a failing tool looks the same whatever it was.
 * ------------------------------------------------------------------------- */

function Shell({
  name,
  target,
  tool,
  children,
}: {
  name: string;
  target: string;
  tool: ToolProps;
  children: ReactNode;
}) {
  const { result } = tool;
  if (failed(tool)) {
    return (
      <ToolError
        className="my-1 tool-error-inert"
        name={name}
        target={shortPath(target)}
        message={resultText(result).slice(0, 400) || "The tool reported a failure."}
        attempt={1}
        maxAttempts={1}
        retrying={false}
      />
    );
  }
  return <div className="my-1 w-full">{children}</div>;
}

/* ---------------------------------------------------------------------------
 * Bash — the command and what it printed.
 * ------------------------------------------------------------------------- */

function BashUI(p: ToolProps) {
  const { args, result, status } = p;
  const command = pick(args, "command", "cmd", "script") || "(no command)";
  const out = lines(resultText(result));
  return (
    <Shell name="Bash" target={command} tool={p}>
      <TerminalBlock
        className="max-w-none"
        command={command}
        lines={out}
        visibleCount={out.length}
        done={!isRunning(status)}
      />
    </Shell>
  );
}

/* ---------------------------------------------------------------------------
 * Edit / Write — what changed, as a diff.
 *
 * The CLIs hand over the before and after strings rather than a patch, so the
 * diff is built here. It is NOT a real diff algorithm: every old line reads as
 * removed and every new line as added, which is honest about what we were told
 * and never invents a common subsequence that the agent did not claim.
 * ------------------------------------------------------------------------- */

function diffOf(before: string, after: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const t of lines(before)) out.push({ kind: "removed", text: t });
  for (const t of lines(after)) out.push({ kind: "added", text: t });
  return out;
}

function EditUI(p: ToolProps) {
  const { args } = p;
  const file = pick(args, "file_path", "filePath", "path", "file");
  const before = pick(args, "old_string", "oldString", "old", "search");
  const after = pick(args, "new_string", "newString", "new", "content", "replace");
  const body = diffOf(before, after);
  const additions = body.filter((l) => l.kind === "added").length;
  const deletions = body.filter((l) => l.kind === "removed").length;

  return (
    <Shell name="Edit" target={file} tool={p}>
      <CodeDiff
        className="max-w-none"
        filename={shortPath(file) || "(unnamed file)"}
        additions={additions}
        deletions={deletions}
        lines={body.slice(0, 80)}
        cycle={body.length}
      />
    </Shell>
  );
}

/* ---------------------------------------------------------------------------
 * Read — the file, and how much of it was taken.
 * ------------------------------------------------------------------------- */

function ReadUI(p: ToolProps) {
  const { args, result, status } = p;
  const [open, setOpen] = useState(false);
  const file = pick(args, "file_path", "filePath", "path", "file");
  const text = resultText(result);
  const count = lines(text).length;

  return (
    <Shell name="Read" target={file} tool={p}>
      <ToolCall
        className="max-w-none"
        label={`Read ${shortPath(file)}${count ? ` · ${count} lines` : ""}`}
        activeLabel={`Reading ${shortPath(file)}`}
        query={file}
        request=""
        result={text.slice(0, 4000)}
        running={isRunning(status)}
        open={open}
        onOpenChange={setOpen}
      />
    </Shell>
  );
}

/* ---------------------------------------------------------------------------
 * Glob / Grep / LS — a tree of what matched.
 * ------------------------------------------------------------------------- */

function pathsToNodes(paths: string[]): FileTreeNode[] {
  const seen = new Set<string>();
  const nodes: FileTreeNode[] = [];
  for (const raw of paths) {
    const parts = raw.replace(/\\/g, "/").split("/").filter(Boolean);
    parts.forEach((name, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (seen.has(path)) return;
      seen.add(path);
      nodes.push({ path, name, depth: i, kind: i === parts.length - 1 ? "file" : "folder" });
    });
  }
  return nodes;
}

function MatchesUI({ name, ...p }: ToolProps & { name: string }) {
  const { args, result, status } = p;
  const query = pick(args, "pattern", "query", "glob", "path") || name;
  const found = lines(resultText(result))
    // ripgrep prints `path:line:text`; a bare glob prints the path alone.
    .map((l) => l.split(":")[0].trim())
    .filter((l) => l && !/^\s*$/.test(l));
  const unique = [...new Set(found)].slice(0, 60);
  const nodes = pathsToNodes(unique);

  return (
    <Shell name={name} target={query} tool={p}>
      {nodes.length ? (
        <FileTree
          className="max-w-none"
          nodes={nodes}
          visibleCount={nodes.length}
          totalAdditions={0}
          totalDeletions={0}
        />
      ) : (
        <div className="text-muted-foreground px-1 text-[13px]">
          {isRunning(status) ? `${name} ${query}…` : `${name} ${query} — nothing matched`}
        </div>
      )}
    </Shell>
  );
}

/* ---------------------------------------------------------------------------
 * TodoWrite — the plan, as a checklist.
 * ------------------------------------------------------------------------- */

const TODO_STATUS: Record<string, TodoStatus> = {
  pending: "pending",
  in_progress: "active",
  active: "active",
  completed: "done",
  done: "done",
  cancelled: "failed",
  failed: "failed",
};

function TodoUI(p: ToolProps) {
  const { args } = p;
  const raw = rec(args).todos ?? rec(args).items ?? [];
  const items: TodoItem[] = (Array.isArray(raw) ? raw : []).map((t, i) => {
    const o = rec(t);
    return {
      id: str(o.id, String(i)),
      text: str(o.content) || str(o.activeForm) || str(o.text) || `item ${i + 1}`,
      status: TODO_STATUS[str(o.status, "pending")] ?? "pending",
    };
  });

  return (
    <Shell name="TodoWrite" target={`${items.length} items`} tool={p}>
      {items.length ? (
        <TodoList className="max-w-none" items={items} revision={items.length} />
      ) : (
        <div className="text-muted-foreground px-1 text-[13px]">The plan is empty.</div>
      )}
    </Shell>
  );
}

/* ---------------------------------------------------------------------------
 * Task — a subagent, which is its own agent worth watching.
 * ------------------------------------------------------------------------- */

function TaskUI(p: ToolProps) {
  const { args, status } = p;
  const kind = pick(args, "subagent_type", "agent", "type") || "agent";
  const what = pick(args, "description", "prompt", "task");
  const done = !isRunning(status);
  const agent = { name: kind, model: what.slice(0, 60) || kind };

  return (
    <Shell name="Task" target={what} tool={p}>
      <SubagentList
        className="max-w-none"
        agents={[agent]}
        completedCount={done ? 1 : 0}
        progress={[done ? 1 : 0.5]}
        showSummary={done}
        summaryAgent={agent}
      />
    </Shell>
  );
}

/* ---------------------------------------------------------------------------
 * WebSearch — the query and what came back.
 * ------------------------------------------------------------------------- */

function domainOf(line: string): string {
  const m = /https?:\/\/([^/\s)]+)/.exec(line);
  return m ? m[1].replace(/^www\./, "") : "";
}

function WebSearchUI(p: ToolProps) {
  const { args, result, status } = p;
  const query = pick(args, "query", "q", "search");
  const results: WebSearchResult[] = lines(resultText(result))
    .filter((l) => /https?:\/\//.test(l))
    .slice(0, 8)
    .map((l) => ({ title: l.replace(/https?:\/\/\S+/, "").trim().slice(0, 90) || l, domain: domainOf(l) }));

  return (
    <Shell name="WebSearch" target={query} tool={p}>
      <WebSearch
        className="max-w-none"
        query={query}
        results={results}
        visibleResults={results.length}
        searching={isRunning(status)}
        cycle={results.length}
      />
    </Shell>
  );
}

/* ---------------------------------------------------------------------------
 * Registration.
 *
 * One component per NAME. The three CLIs spell the same operation
 * differently, and codex names its own operations (`command_execution`,
 * `file_change`) rather than the tool behind them — transcript.mjs already
 * maps those two onto Bash and Edit, and the rest are registered here.
 * ------------------------------------------------------------------------- */

type ToolUI = ReturnType<typeof makeAssistantToolUI>;

const ui = (names: string[], render: (p: ToolProps) => ReactNode): ToolUI[] =>
  names.map((toolName) =>
    makeAssistantToolUI<Record<string, unknown>, unknown>({
      toolName,
      render: ({ args, result, status, isError }) => render({ args, result, status, isError }),
    }),
  );

const BASH = ui(["Bash", "bash", "shell", "run_command", "command_execution"], (p) => <BashUI {...p} />);
const EDIT = ui(["Edit", "edit", "Write", "write", "MultiEdit", "patch", "apply_patch", "file_change"], (p) => <EditUI {...p} />);
const READ = ui(["Read", "read", "view", "cat"], (p) => <ReadUI {...p} />);
const GLOB = ui(["Glob", "glob", "LS", "list", "ls"], (p) => <MatchesUI name="Glob" {...p} />);
const GREP = ui(["Grep", "grep", "search", "ripgrep"], (p) => <MatchesUI name="Grep" {...p} />);
const TODO = ui(["TodoWrite", "todowrite", "todo_write", "todo"], (p) => <TodoUI {...p} />);
const TASK = ui(["Task", "task", "agent", "subagent"], (p) => <TaskUI {...p} />);
const WEB = ui(["WebSearch", "web_search", "websearch"], (p) => <WebSearchUI {...p} />);

const ALL: ToolUI[] = [...BASH, ...EDIT, ...READ, ...GLOB, ...GREP, ...TODO, ...TASK, ...WEB];

/**
 * Mounting a component is how assistant-ui registers a tool UI, so they have
 * to be rendered somewhere inside the provider. They draw nothing themselves.
 */
export function ToolUIs() {
  return (
    <>
      {ALL.map((Registered, i) => (
        <Registered key={i} />
      ))}
    </>
  );
}
