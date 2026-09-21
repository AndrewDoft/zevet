/**
 * Saved prompts live only in localStorage — there's no server for them, and
 * a board that can't be reached (private tab, cleared site data) should
 * still render with the starter set rather than throwing.
 */
import { useEffect, useState } from "react";
import {
  PromptLibrary,
  type SavedPrompt,
} from "./assistant-ui/elements/prompt-library";
import { field, fieldInteractive, mono, paper } from "./assistant-ui/elements/surfaces";
import { cn } from "@/lib/utils";
import { composingState, selectActiveConsole, useBoard } from "../lib/board";

const STORAGE_KEY = "zevet.prompts.v1";

const STARTER_PROMPTS: SavedPrompt[] = [
  {
    id: "starter-explain",
    name: "Explain what changed",
    body: "Explain what changed in {file} and why.",
    variables: ["file"],
  },
  {
    id: "starter-test",
    name: "Write a test for this",
    body: "Write a test for the behavior I just described: {behavior}",
    variables: ["behavior"],
  },
  {
    id: "starter-find",
    name: "Find where X is defined",
    body: "Find where {symbol} is defined and show the surrounding context.",
    variables: ["symbol"],
  },
  {
    id: "starter-review",
    name: "Review the diff",
    body: "Review the current diff for correctness and style issues before committing.",
    variables: [],
  },
];

function isSavedPrompt(x: unknown): x is SavedPrompt {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    typeof p.body === "string" &&
    Array.isArray(p.variables)
  );
}

function loadPrompts(): SavedPrompt[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return STARTER_PROMPTS;
    const parsed = JSON.parse(raw);
    const valid = Array.isArray(parsed) ? parsed.filter(isSavedPrompt) : [];
    return valid.length > 0 ? valid : STARTER_PROMPTS;
  } catch {
    return STARTER_PROMPTS;
  }
}

function savePrompts(prompts: SavedPrompt[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prompts));
  } catch {
    // private mode / storage quota: the session still works, it just won't persist
  }
}

export function PromptLibraryPanel() {
  const [prompts, setPrompts] = useState<SavedPrompt[]>(() => loadPrompts());
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [draftName, setDraftName] = useState("");
  const active = useBoard(selectActiveConsole);
  const noteComposing = useBoard((s) => s.noteComposing);

  useEffect(() => savePrompts(prompts), [prompts]);

  const selected = prompts.find((p) => p.id === selectedId);

  const handleInsert = (id: string) => {
    const prompt = prompts.find((p) => p.id === id);
    if (!prompt || !active) return;
    noteComposing(active.key, prompt.body);
  };

  const handleSaveDraft = () => {
    if (!active) return;
    const body = composingState(active.key).value;
    const name = draftName.trim();
    if (!name || !body.trim()) return;
    // {variable} markers in the draft become the library's variable chips —
    // no separate form for something the text already says.
    const variables = [...new Set([...body.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))];
    setPrompts((prev) => [...prev, { id: `p-${Date.now()}`, name, body, variables }]);
    setDraftName("");
  };

  const handleDelete = (id: string) => {
    setPrompts((prev) => prev.filter((p) => p.id !== id));
    if (selectedId === id) setSelectedId("");
  };

  return (
    <div className="flex w-full max-w-sm flex-col gap-2">
      <PromptLibrary
        prompts={prompts}
        query={query}
        selectedId={selectedId}
        onQueryChange={setQuery}
        onSelect={setSelectedId}
        onInsert={active ? handleInsert : undefined}
      />

      <div className={cn(paper, "flex flex-col gap-2 rounded-2xl p-3")}>
        <div className="flex items-center gap-2">
          <input
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder={active ? "Name the current draft to save it" : "No active console to save from"}
            disabled={!active}
            className={cn(
              field,
              "min-w-0 flex-1 rounded-xl px-2.5 py-1.5 text-[13px] outline-none disabled:opacity-40",
            )}
          />
          <button
            type="button"
            onClick={handleSaveDraft}
            disabled={!active}
            className={cn(fieldInteractive, mono, "shrink-0 rounded-xl px-2.5 py-1.5 disabled:opacity-40")}
          >
            Save draft
          </button>
        </div>
        {selected && (
          <button
            type="button"
            onClick={() => handleDelete(selected.id)}
            className={cn(fieldInteractive, mono, "text-foreground/50 self-start rounded-xl px-2.5 py-1")}
          >
            Delete “{selected.name}”
          </button>
        )}
      </div>
    </div>
  );
}
