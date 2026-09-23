/**
 * Provenance — built on elements/confidence-marker.tsx, but repurposed.
 *
 * That element was refused a release ago on the grounds that no agent
 * reports its own confidence, and that is still true here: do not infer
 * confidence from the model's wording. This panel does not grade the
 * model's certainty at all. What it reports instead is PROVENANCE, which
 * is a fact zevet can check: for every file path the last assistant
 * message names in its prose, is that path checkable against this
 * console's own transcript and workspace? The element's own labels say
 * "from a source" — a reader must not mistake that for the model grading
 * itself. The three confidence levels are re-purposed to mean exactly
 * "grounded in this transcript", "present in the workspace but not opened
 * this run", and "found in neither" — nothing here is the model's opinion
 * of itself.
 *
 * Same spirit as moreviews.tsx / knowledge.tsx: a dashboard card reading
 * `useBoard(selectActiveConsole)` directly, rendering nothing when it has
 * nothing honest to show.
 *
 * Reader helpers (`rec`/`str`/`pick`/`resultText`) are duplicated from
 * moreviews.tsx rather than imported — that file does not export them.
 */
import { useState } from "react";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { selectActiveConsole, useBoard } from "../lib/board";
import {
  ConfidenceMarker,
  type ConfidenceClaim,
} from "./assistant-ui/elements/confidence-marker";

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

function allToolCalls(messages: readonly ThreadMessageLike[]): ToolCallLike[] {
  const out: ToolCallLike[] = [];
  for (const m of messages) out.push(...toolCalls(m.content));
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

/* ---------------------------------------------------------------------------
 * Path extraction — a path-shaped token in prose: a slash, and an
 * extension. Conservative on purpose: no slash, no match; URLs (which
 * knowledge.tsx's Citations already renders) are scrubbed first so
 * "https://x.com/a/b.html" never gets read as a file.
 * ------------------------------------------------------------------------- */

const URL_RE = /https?:\/\/\S+/g;

const PATH_TOKEN = /(?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]{1,8}\b/g;

const slashify = (s: string): string => s.replace(/\\/g, "/");

function normPath(p: string): string {
  return slashify(p.trim()).replace(/\/+$/, "");
}

interface PathMention {
  path: string;
  /** The path plus a little of the sentence around it, so a reader sees
   *  the claim rather than just the bare string. */
  text: string;
}

function pathMentions(message: string): PathMention[] {
  const scrubbed = message.replace(URL_RE, " ");
  const seen = new Set<string>();
  const out: PathMention[] = [];
  for (const m of scrubbed.matchAll(PATH_TOKEN)) {
    const path = m[0];
    const key = normPath(path).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const idx = m.index ?? 0;
    const start = Math.max(0, idx - 30);
    const end = Math.min(scrubbed.length, idx + path.length + 30);
    let snippet = scrubbed.slice(start, end).trim();
    if (start > 0) snippet = "\u2026" + snippet;
    if (end < scrubbed.length) snippet = snippet + "\u2026";
    out.push({ path, text: snippet });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Grounded — the path was the subject of a Read/Write/Edit call's own
 * arguments (catches a file just created, whose result text may not echo
 * the path back), or appears verbatim in some tool's result text (a Grep
 * hit, an `ls`/`find` line, a directory listing).
 * ------------------------------------------------------------------------- */

const isReadTool = (n: string) => n === "read" || n === "read_file" || n === "view";
const isWriteTool = (n: string) =>
  n === "write" ||
  n === "edit" ||
  n === "multiedit" ||
  n === "patch" ||
  n === "apply_patch" ||
  n === "file_change";

/** Bidirectional suffix match, so "board/src/foo.ts" (how an agent names a
 *  file in prose) lines up with "C:/dev/GitHub/zevet/board/src/foo.ts" (how
 *  a Read/Write call's own args spell it) without needing localRoot. */
function pathsMatch(a: string, b: string): boolean {
  const na = normPath(a).toLowerCase();
  const nb = normPath(b).toLowerCase();
  if (!na || !nb) return false;
  return na === nb || na.endsWith("/" + nb) || nb.endsWith("/" + na);
}

/** Absolute paths under localRoot become repo-relative, to compare against
 *  a tool result's text or localEntries (both root-relative, see tree.tsx /
 *  buildTree). Anything outside localRoot, or with no localRoot known,
 *  can't be mapped and returns null — never invented as relative. */
function toRepoRelative(path: string, localRoot: string | null): string | null {
  const p = normPath(path);
  const isAbsolute = /^[A-Za-z]:\//.test(p) || p.startsWith("/");
  if (!isAbsolute) return p.replace(/^\.\//, "");
  if (!localRoot) return null;
  const root = normPath(localRoot);
  if (p.toLowerCase() === root.toLowerCase()) return null;
  if (!p.toLowerCase().startsWith(root.toLowerCase() + "/")) return null;
  return p.slice(root.length + 1);
}

interface Grounding {
  toolName: string;
  via: "call" | "result";
}

function groundedIn(
  path: string,
  calls: readonly ToolCallLike[],
  localRoot: string | null,
): Grounding | null {
  for (const c of calls) {
    if (typeof c.toolName !== "string") continue;
    const n = c.toolName.toLowerCase();
    if (!isReadTool(n) && !isWriteTool(n)) continue;
    const argPath = pick(c.args, "file_path", "filePath", "path", "file");
    if (argPath && pathsMatch(argPath, path)) return { toolName: c.toolName, via: "call" };
  }
  const needle = normPath(path).toLowerCase();
  const rel = toRepoRelative(path, localRoot);
  const relNeedle = rel ? normPath(rel).toLowerCase() : null;
  for (const c of calls) {
    const text = slashify(resultText(c.result)).toLowerCase();
    if (!text) continue;
    if (text.includes(needle) || (relNeedle && text.includes(relNeedle))) {
      return { toolName: c.toolName, via: "result" };
    }
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * Inferred / uncertain — checked against s.localEntries, the file tree the
 * board already holds (see tree.tsx / buildTree). A truncated or unreadable
 * tree (localError set) proves nothing about what's missing from it, and no
 * tree at all (localEntries === null) proves even less — a miss in either
 * case falls back to "inferred" with the reason named, never "uncertain".
 * ------------------------------------------------------------------------- */

function inTree(
  path: string,
  entries: readonly { path: string }[],
  localRoot: string | null,
): boolean {
  const rel = toRepoRelative(path, localRoot);
  if (rel == null) return false;
  const needle = normPath(rel).toLowerCase();
  if (!needle) return false;
  return entries.some((e) => {
    const ep = normPath(e.path).toLowerCase();
    return ep === needle || ep.endsWith("/" + needle) || needle.endsWith("/" + ep);
  });
}

function useTranscriptMessages(): readonly ThreadMessageLike[] {
  return useBoard(selectActiveConsole)?.transcript.messages ?? [];
}

export function Provenance() {
  const messages = useTranscriptMessages();
  const localRoot = useBoard((s) => s.localRoot);
  const localEntries = useBoard((s) => s.localEntries);
  const localError = useBoard((s) => s.localError);
  const localTruncated = useBoard((s) => s.localTruncated);
  const [hoveredId, setHoveredId] = useState("");

  const turn = lastAssistantMessage(messages);
  const text = turn ? textOf(turn.content) : "";
  if (!text) return null;

  const mentions = pathMentions(text);
  if (!mentions.length) return null;

  const calls = allToolCalls(messages);
  const treeUnconfirmedReason =
    localEntries == null
      ? "no local file tree loaded this run"
      // Both: a tree that failed to load and one that was cut short are
      // equally unable to prove a path is absent.
      : localError || localTruncated || "";

  const claims: ConfidenceClaim[] = mentions.map((mention, i) => {
    const id = String(i);
    const grounding = groundedIn(mention.path, calls, localRoot);
    if (grounding) {
      const basis =
        grounding.via === "call"
          ? `${grounding.toolName} ${mention.path}`
          : `${grounding.toolName} result mentions ${mention.path}`;
      return { id, text: mention.text, confidence: "grounded", basis };
    }
    if (localEntries && inTree(mention.path, localEntries, localRoot)) {
      return {
        id,
        text: mention.text,
        confidence: "inferred",
        basis: "in the repo, not opened this run",
      };
    }
    if (treeUnconfirmedReason) {
      return {
        id,
        text: mention.text,
        confidence: "inferred",
        basis: `tree unconfirmed \u2014 ${treeUnconfirmedReason}`,
      };
    }
    return {
      id,
      text: mention.text,
      confidence: "uncertain",
      basis: "not in the file tree",
    };
  });

  return <ConfidenceMarker claims={claims} hoveredId={hoveredId} onHover={setHoveredId} />;
}
