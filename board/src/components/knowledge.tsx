/**
 * Panels that turn specific, citable moments in the active console's
 * transcript into cards — web searches, file reads, and displayed math — in
 * the same spirit as moreviews.tsx: dashboard cards, not thread children,
 * each reading `useBoard(selectActiveConsole)` directly and rendering
 * nothing when it has nothing honest to show.
 *
 * Reader helpers (`rec`/`str`/`pick`/`resultText`) are duplicated from
 * moreviews.tsx rather than imported — that file does not export them,
 * same as tools.tsx.
 */
import { useState } from "react";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { selectActiveConsole, toggleSelection, useBoard } from "../lib/board";
import {
  DocumentReference,
  type DocumentAnchor,
} from "./assistant-ui/elements/document-reference";
import { InlineCitation, type Source } from "./assistant-ui/elements/inline-citation";
import { MathBlock, type MathStep } from "./assistant-ui/elements/math-block";

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function str(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

function pick(args: unknown, ...keys: string[]): string {
  const o = rec(args);
  for (const k of keys) {
    const v = str(o[k]);
    if (v) return v;
  }
  return "";
}

/** A tool result flattened to text — same collapsing rule as tools.tsx's
 *  `resultText`, duplicated because it is not exported. */
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

interface ToolCallLike {
  type: "tool-call";
  toolCallId?: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  startedAt?: number;
  endedAt?: number;
}

function toolCalls(content: ThreadMessageLike["content"]): ToolCallLike[] {
  if (!Array.isArray(content)) return [];
  return content.filter((p) => p.type === "tool-call") as unknown as ToolCallLike[];
}

function allToolCalls(
  messages: readonly ThreadMessageLike[],
  match: (toolNameLower: string) => boolean,
): ToolCallLike[] {
  const out: ToolCallLike[] = [];
  for (const m of messages) {
    for (const c of toolCalls(m.content)) {
      if (match(c.toolName.toLowerCase())) out.push(c);
    }
  }
  return out;
}

function lastAssistantMessage(
  messages: readonly ThreadMessageLike[],
): ThreadMessageLike | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") return messages[i];
  }
  return undefined;
}

/** The text parts of a message, concatenated — content may be a plain
 *  string or an array, per the same guard every reader here uses. */
function textOf(content: ThreadMessageLike["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ");
}

function useTranscriptMessages(): readonly ThreadMessageLike[] {
  return useBoard(selectActiveConsole)?.transcript.messages ?? [];
}

/* ---------------------------------------------------------------------------
 * 1. Citations — one InlineCitation per WebSearch call.
 * ------------------------------------------------------------------------- */

const isWebSearch = (n: string) => n === "websearch" || n === "web_search";

/** Same URL-line reading tools.tsx's WebSearchUI uses: the tool's result is
 *  flattened text, one result per line, each line carrying its url. There is
 *  no structured snippet in that shape, so `snippet` is honestly always "". */
function domainOf(line: string): string {
  const m = /https?:\/\/([^/\s)]+)/.exec(line);
  return m ? m[1].replace(/^www\./, "") : "";
}

interface SearchCall {
  idx: number;
  query: string;
  sources: Source[];
}

function searchCalls(messages: readonly ThreadMessageLike[]): SearchCall[] {
  const calls = allToolCalls(messages, isWebSearch);
  const out: SearchCall[] = [];
  calls.forEach((c, idx) => {
    const query = pick(c.args, "query", "q", "search");
    if (!query) return;
    const sources: Source[] = lines(resultText(c.result))
      .filter((l) => /https?:\/\//.test(l))
      .slice(0, 8)
      .map((l) => ({
        domain: domainOf(l),
        title: l.replace(/https?:\/\/\S+/, "").trim().slice(0, 90) || l,
        snippet: "",
      }));
    if (sources.length) out.push({ idx, query, sources });
  });
  return out;
}

/** One InlineCitation per search, each owning its own open-chip state —
 *  `useState` has to live in a component invoked once per call, not in the
 *  loop that maps over them. */
function SearchCitation({ query, sources }: { query: string; sources: Source[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  return (
    <InlineCitation
      className="max-w-none"
      sources={sources}
      openIndex={openIndex}
      onOpenIndexChange={setOpenIndex}
    >
      {/* zevet's own statement that it ran this search — not a claim that
       *  this sentence was drawn from any of the sources below it. The
       *  numbered chips cite the individual results, not this sentence. */}
      {`Searched the web for "${query}" — ${sources.length} result${sources.length === 1 ? "" : "s"}.`}
    </InlineCitation>
  );
}

export function Citations() {
  const messages = useTranscriptMessages();
  const calls = searchCalls(messages);
  if (!calls.length) return null;

  return (
    <div className="flex w-full flex-col gap-2">
      {calls.map((c) => (
        <SearchCitation key={c.idx} query={c.query} sources={c.sources} />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * 2. Reads — one DocumentReference per file read, most recently read first.
 * ------------------------------------------------------------------------- */

const isRead = (n: string) => n === "read" || n === "read_file" || n === "view";

/** cat -n prefixes every line the Read tool returns, e.g. "   12\tconst x". */
const CATN_PREFIX = /^\s*(\d+)\t/;

const stripLineNumber = (line: string): string => line.replace(CATN_PREFIX, "");

/** The highest cat -n line number actually printed in a read's result, or
 *  undefined when the result carries no numbered lines (e.g. still running). */
function maxLineNumberIn(text: string): number | undefined {
  let max: number | undefined;
  for (const line of lines(text)) {
    const m = CATN_PREFIX.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    if (max === undefined || n > max) max = n;
  }
  return max;
}

function firstQuote(text: string): string {
  for (const line of lines(text)) {
    const stripped = stripLineNumber(line).trim();
    if (stripped) return stripped.slice(0, 120);
  }
  return "";
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** This tool's own documented default when no `limit` arg is sent — used
 *  only as a last resort, when a read's result also carries no cat -n
 *  prefixes to count from directly. */
const DEFAULT_READ_LIMIT = 2000;

interface ReadCall {
  idx: number;
  path: string;
  offset: number;
  limit: number;
  text: string;
}

function readCalls(messages: readonly ThreadMessageLike[]): ReadCall[] {
  const calls = allToolCalls(messages, isRead);
  const out: ReadCall[] = [];
  calls.forEach((c, idx) => {
    const path = pick(c.args, "file_path", "filePath", "path", "file");
    if (!path) return;
    const a = rec(c.args);
    out.push({
      idx,
      path,
      offset: num(a.offset) ?? 1,
      limit: num(a.limit) ?? DEFAULT_READ_LIMIT,
      text: resultText(c.result),
    });
  });
  return out;
}

/** The Read tool's path is absolute; the board's `toggleSelection` wants a
 *  repo-relative one. Converts via `localRoot`, or returns null when the
 *  path isn't under it (already-relative paths pass through unchanged). */
function relPathForJump(filePath: string, localRoot: string | null): string | null {
  if (!filePath) return null;
  const norm = (p: string) => p.replace(/\\/g, "/");
  const p = norm(filePath);
  const isAbsolute = /^[a-zA-Z]:\//.test(p) || p.startsWith("/");
  if (!isAbsolute) return p;
  if (!localRoot) return null;
  const root = norm(localRoot).replace(/\/+$/, "");
  if (p.toLowerCase() === root.toLowerCase()) return null;
  if (!p.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null;
  return p.slice(root.length + 1);
}

export function Reads() {
  const messages = useTranscriptMessages();
  const localRoot = useBoard((s) => s.localRoot);
  const calls = readCalls(messages);
  if (!calls.length) return null;

  const groups = new Map<string, ReadCall[]>();
  for (const c of calls) {
    const g = groups.get(c.path);
    if (g) g.push(c);
    else groups.set(c.path, [c]);
  }

  const cards = [...groups.values()]
    .sort((a, b) => b[b.length - 1]!.idx - a[a.length - 1]!.idx)
    .slice(0, 5);

  return (
    <div className="flex w-full flex-col gap-2">
      {cards.map((reads) => {
        const path = reads[0]!.path;
        const anchors: DocumentAnchor[] = reads.map((r) => ({
          page: r.offset,
          quote: firstQuote(r.text),
        }));
        const pages = Math.max(...reads.map((r) => maxLineNumberIn(r.text) ?? r.offset + r.limit));
        const activePage = reads[reads.length - 1]!.offset;
        const relPath = relPathForJump(path, localRoot);

        return (
          <DocumentReference
            key={path}
            className="max-w-none"
            title={path}
            pages={pages}
            anchors={anchors}
            activePage={activePage}
            // onJump only opens the file — the board has no line-level jump,
            // so every anchor's click does the same honest thing: select it.
            onJump={relPath ? () => toggleSelection(relPath) : undefined}
          />
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * 3. MathBlocks — display-math blocks from the latest assistant message.
 * ------------------------------------------------------------------------- */

const DISPLAY_MATH = /\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]/g;

export function MathBlocks() {
  const messages = useTranscriptMessages();
  const turn = lastAssistantMessage(messages);
  const text = turn ? textOf(turn.content) : "";
  if (!text) return null;

  const blocks = [...text.matchAll(DISPLAY_MATH)]
    .map((m) => m[1] ?? m[2] ?? "")
    .map((block) =>
      lines(block)
        .map((l) => l.trim())
        .filter(Boolean),
    )
    .filter((stepLines) => stepLines.length > 0);
  if (!blocks.length) return null;

  return (
    <div className="flex w-full flex-col gap-2">
      {blocks.map((stepLines, i) => {
        const steps: MathStep[] = stepLines.map((expression) => ({ expression }));
        return (
          <MathBlock key={i} className="max-w-none" steps={steps} visibleSteps={steps.length} />
        );
      })}
    </div>
  );
}
