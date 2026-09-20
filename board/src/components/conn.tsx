/**
 * The hub connection, when it is not fine.
 *
 * The strip has always carried a `live` / `down` word, which is right for the
 * steady state and much too quiet for the one that matters: if the hub has
 * gone, the board is showing you history and nothing says so loudly. The
 * registry's ConnectionState renders nothing at all while online and a real
 * notice otherwise, which is exactly the shape this wants.
 */
import { ConnectionState, type ConnectionPhase } from "./assistant-ui/elements/connection-state";
import { useBoard } from "../lib/board";
import type { Conn } from "../lib/types";

const PHASE: Record<Conn, ConnectionPhase> = {
  live: "online",
  init: "reconnecting",
  down: "dropped",
};

export function ConnBanner() {
  const conn = useBoard((s) => s.conn);
  const phase = PHASE[conn] ?? "reconnecting";
  if (phase === "online") return null;

  return (
    <div className="conn-banner">
      <ConnectionState phase={phase} onRetry={() => location.reload()} />
    </div>
  );
}
