/**
 * The first UI onto zevet's own semantic code index (desktop/code-index.js).
 * A text box plus RetrievalChunks underneath it: type, wait ~250ms, get the
 * k nearest chunks the index actually embedded — nothing here is invented,
 * every score is the real cosine similarity `code-index.js` computed.
 *
 * `query` passed to RetrievalChunks is the query that produced the chunks
 * currently on screen, not whatever is mid-keystroke in the box — while a
 * fresh request is in flight the old query stays paired with the old chunks
 * so the pill is never a mislabel for what's showing.
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { bridge } from "../lib/bridge";
import { useBoard } from "../lib/board";
import {
  RetrievalChunks,
  type RetrievalChunk,
} from "./assistant-ui/elements/retrieval-chunks";
import { field } from "./assistant-ui/elements/surfaces";

const DEBOUNCE_MS = 250;

export function IndexSearch() {
  const localRoot = useBoard((s) => s.localRoot);
  const [typed, setTyped] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [chunks, setChunks] = useState<RetrievalChunk[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every effect run so a response from a superseded keystroke
  // can't land after a newer one and overwrite it with stale results.
  const seq = useRef(0);

  useEffect(() => {
    seq.current += 1;
    const mySeq = seq.current;
    const search = bridge.local?.indexSearch;
    if (!search || !localRoot) return;

    const q = typed.trim();
    if (!q) {
      setSearching(false);
      setError(null);
      setChunks([]);
      setCommittedQuery("");
      return;
    }

    setSearching(true);
    const timer = window.setTimeout(() => {
      search(localRoot, q, { k: 8 })
        .then((res) => {
          if (mySeq !== seq.current) return;
          setSearching(false);
          if (!res.ok) {
            setError(res.error || "search failed");
            setChunks([]);
            return;
          }
          setError(null);
          setCommittedQuery(q);
          setChunks(
            (res.hits ?? []).map((hit) => ({
              id: `${hit.path}:${hit.startLine}`,
              source: hit.path,
              locator: `L${hit.startLine}-${hit.endLine}`,
              score: hit.score,
              text: hit.text ?? "",
            })),
          );
        })
        .catch((err) => {
          if (mySeq !== seq.current) return;
          setSearching(false);
          setError(String((err && err.message) || err));
          setChunks([]);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [typed, localRoot]);

  if (!bridge.local?.indexSearch || !localRoot) return null;

  return (
    <div className="flex w-full flex-col gap-2.5">
      <input
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        // A placeholder is not an accessible name — it is announced as a hint
        // and vanishes the moment there is text in the field.
        aria-label="Search code"
        placeholder="Search code"
        className={cn(
          field,
          "w-full rounded-xl px-3.5 py-2 text-[13px] outline-none",
        )}
      />
      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : null}
      {!error && (searching || committedQuery) ? (
        <RetrievalChunks
          className="max-w-none"
          query={committedQuery}
          chunks={chunks}
          visibleCount={chunks.length}
          searching={searching}
        />
      ) : null}
    </div>
  );
}
