import { useBoard, serverNow } from "../lib/board";
import { latestToolForActor } from "../lib/roster.mjs";
import { LIVE_SESSION_MS } from "../lib/constants";

export function AgentSprite({ actor, repo, size = "rail" }: { actor?: string; repo?: string; size?: "rail" | "header" | "tree" }) {
  const events = useBoard((s) => s.events);
  const myActor = useBoard((s) => s.myActor);
  const now = serverNow();
  const event = repo && (actor || myActor) ? latestToolForActor(events, { repoName: repo, actor: actor || myActor!, now, liveAfterMs: LIVE_SESSION_MS }) : null;
  const spriteFor = window.zevetSprites?.spriteFor;
  if (!spriteFor) return null;
  const dimensions = size === "tree" ? { width: 24, height: 16 } : { width: 44, height: 20 };
  const svg = spriteFor({ tool: event?.tool, kind: event?.kind, ...dimensions });
  return <span className={`agent-sprite agent-sprite-${size}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}
