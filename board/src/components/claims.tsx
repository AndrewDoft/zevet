import { type CSSProperties } from "react";
import { type OverlapHit, chipText, hitLine } from "../lib/claims.mjs";

/** On an agent's card: what its session has claimed. Nothing when nothing. */
export function ClaimChip({ paths }: { paths: string[] }) {
  if (!paths.length) return null;
  return (
    <span className="claim-chip" title={paths.join("\n")}>
      {"claimed: " + chipText(paths)}
    </span>
  );
}

/** In the file tree: a dot in the claimer's colour; their name on hover. */
export function ClaimMark({ actor, colour }: { actor: string; colour: string }) {
  return <span className="claim-mark" style={{ "--who": colour } as CSSProperties} title={actor + " · claimed"} />;
}

/** Above the composer: who the task overlaps, and the one decision. */
export function OverlapNoticeView({ hits, onSend, onCancel }: { hits: OverlapHit[]; onSend: () => void; onCancel: () => void }) {
  return (
    <div className="overlap-notice" role="alert">
      <span className="overlap-hits">
        {hits.slice(0, 3).map((h, i) => (
          <span key={i} className="overlap-hit" data-label={h.label}>{hitLine(h)}</span>
        ))}
        {hits.length > 3 ? <span className="overlap-hit">{"+" + (hits.length - 3)}</span> : null}
      </span>
      <button type="button" onClick={onSend}>Send anyway</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  );
}

/** Right-click on a file: Claim, or Release when it is mine. */
export function ClaimMenu({ x, y, mine, onPick, onClose }: { x: number; y: number; mine: boolean; onPick: () => void; onClose: () => void }) {
  return (
    <div className="claim-menu-scrim" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div className="claim-menu" role="menu" style={{ left: x, top: y }}>
        <button type="button" role="menuitem" autoFocus onClick={onPick} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
          {mine ? "Release" : "Claim"}
        </button>
      </div>
    </div>
  );
}
