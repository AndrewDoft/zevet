/**
 * Steering a teammate's agent (D-058) — the three places it shows:
 *
 *   SteerButton    on a teammate's agent row: retargets my composer at it.
 *   SteerBanner    above the composer: whose agent Send now goes to, and
 *                  every steer I sent with where it stands.
 *   SteerApprovals the cards for steers aimed at MY agents when the team
 *                  policy is "ask first" — the steer is injected only after
 *                  Approve. Same shape as permits.tsx's ToolApproval.
 *
 * Every string a teammate typed is rendered as a text child, never markup.
 */
"use client";

import { cn } from "@/lib/utils";
import { paper, field, mono } from "./assistant-ui/elements/surfaces";
import {
  agentLabel,
  answerSteer,
  canSteer,
  clearSteerTarget,
  dismissSent,
  steerAgent,
  steerSettled,
  statusText,
  useSteer,
  type SteerTarget,
} from "../lib/steer";
import { usePolicy } from "../lib/policy";
import { SpawnApproval, SpawnTargetLine } from "./spawn";
import { PayerNote, useTeammatePayer } from "./payer";

const btn =
  "text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/90 h-8 rounded-full px-3 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96] disabled:opacity-40";

/** "Steer" on a teammate's agent row. Hidden for an agent with no session id
 *  (an old hook: there is nothing to address) and where this app cannot steer. */
export function SteerButton({ a }: { a: { actor: string; session?: string; agent: string; repo: string } }) {
  const policy = usePolicy();
  const current = useSteer((s) => s.target);
  if (!a.session || !canSteer()) return null;
  const off = policy.steer === "off";
  const on = current?.session === a.session && current?.actor === a.actor;
  return (
    <button
      type="button"
      className="agent-row-steer text-foreground/50 hover:bg-foreground/[0.06] hover:text-foreground/90 aria-pressed:text-foreground aria-pressed:bg-foreground/[0.08] mr-1 shrink-0 self-center rounded-full px-2 py-0.5 text-[11px] font-medium disabled:opacity-40"
      data-steer-for={a.session}
      aria-pressed={on}
      disabled={off}
      title={off ? "Steering is turned off for this team" : `Steer ${a.actor}'s ${agentLabel(a.agent)} agent from your composer`}
      onClick={(ev) => {
        ev.stopPropagation();
        if (on) clearSteerTarget();
        else steerAgent({ actor: a.actor, session: a.session!, agent: a.agent, repo: a.repo });
        // Straight to the composer: the next thing to do is type.
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("#chat textarea")?.focus());
      }}
    >
      {on ? "Steering" : "Steer"}
    </button>
  );
}

function policyLine(steer: string, who: string): string {
  if (steer === "on") return `It goes straight into ${who}'s agent.`;
  if (steer === "off") return "Steering is turned off for this team; it will be refused.";
  return `${who} approves it before their agent sees it.`;
}

function TargetLine({ t }: { t: SteerTarget }) {
  const policy = usePolicy();
  const payer = useTeammatePayer(t.actor, t.session);
  return (
    <div data-slot="steer-target" className={cn(paper, "flex w-full items-start gap-3 rounded-[16px] px-4 py-3")}>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13.5px] font-medium">
          {t.actor} is using {agentLabel(t.agent)}
          {t.repo ? ` in ${t.repo}` : ""}. Steer their agent…
        </span>
        <span className="text-foreground/50 text-xs">Your next message goes to {t.actor}'s agent, not yours. {policyLine(policy.steer, t.actor)}</span>
        <PayerNote who={t.actor} label={payer} />
      </div>
      <button type="button" className={btn} onClick={clearSteerTarget} aria-label="Stop steering">
        Done
      </button>
    </div>
  );
}

export function SteerBanner() {
  const target = useSteer((s) => s.target);
  const spawn = useSteer((s) => s.spawn);
  const sent = useSteer((s) => s.sent);
  if (!target && !spawn && !sent.length) return null;
  return (
    <div data-slot="steer-banner" className="flex w-full flex-col gap-1.5 px-4 pt-2">
      {target ? <TargetLine t={target} /> : null}
      {spawn ? <SpawnTargetLine t={spawn} /> : null}
      {sent.map((s) => (
        <div
          key={s.id}
          data-steer-status={s.status}
          data-steer-kind={s.kind}
          className={cn(field, "text-foreground/70 flex w-full items-center gap-2 rounded-full px-3 py-1 text-xs")}
        >
          <span className="shrink-0 font-medium">{s.kind === "spawn" ? `new agent for ${s.to || "teammate"}` : `to ${s.to || "teammate"}`}</span>
          {s.text ? <span className={cn(mono, "min-w-0 flex-1 truncate")}>{s.text}</span> : <span className="flex-1" />}
          {s.payer ? <PayerNote who={s.to} label={s.payer} /> : null}
          <span className={cn("shrink-0", s.status === "accepted" || s.status === "started" ? "text-foreground/80" : steerSettled(s.status, s.kind) ? "text-foreground/90" : "text-foreground/45")}>
            {statusText(s)}
            {s.reason && s.status !== "start-failed" ? ` (${s.reason})` : ""}
          </span>
          {steerSettled(s.status, s.kind) ? (
            <button type="button" className="text-foreground/40 hover:text-foreground/80 shrink-0" aria-label="Dismiss" onClick={() => dismissSent(s.id)}>
              ×
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function SteerApprovals() {
  const asks = useSteer((s) => s.asks);
  if (!asks.length) return null;
  const a = asks[0];
  if (a.kind === "spawn") return <SpawnApproval a={a} more={asks.length - 1} />;
  return (
    <div data-slot="steer-approval" className={cn(paper, "mx-4 mt-2 flex max-w-md flex-col gap-3 rounded-[20px] p-4")}>
      <div className="flex flex-col">
        <span className="truncate text-[13.5px] font-medium">{a.from || "A teammate"} wants to steer your agent</span>
        <span className="text-foreground/45 text-xs">
          {agentLabel(a.agent)}
          {a.repo ? ` · ${a.repo}` : ""} — nothing reaches it until you approve
          {asks.length > 1 ? ` · ${asks.length - 1} more waiting` : ""}
        </span>
        <PayerNote label={a.payer} />
      </div>
      <pre className={cn(mono, "text-foreground/70 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs")}>{a.text}</pre>
      <div className="flex items-center justify-end gap-2">
        <button type="button" className={btn} onClick={() => void answerSteer(a.id, false)}>
          Decline
        </button>
        <button type="button" className={btn} onClick={() => void answerSteer(a.id, true)}>
          Approve
        </button>
      </div>
    </div>
  );
}
