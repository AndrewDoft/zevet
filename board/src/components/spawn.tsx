/**
 * Starting an agent on a teammate's machine (D-060) — the board side:
 *
 *   RunAsPicker      "Run as: me / <teammate>" in the new-agent flow. A
 *                    teammate retargets the composer: Send starts the agent
 *                    on THEIR machine, in their repo, with their account.
 *   SpawnTargetLine  above the composer while a teammate is picked: which
 *                    repo (theirs, as the board has seen them use, or typed)
 *                    and which agent.
 *   RunOnTheirs      "+ agent" on a teammate's row: the same, preselected.
 *   SpawnApproval    the card on the OWNER's side under "ask first", spelling
 *                    out exactly what would run: the agent, the folder, the
 *                    whole prompt. Nothing starts until they say so.
 *
 * Every string a teammate typed is rendered as a text child, never markup.
 * Display names for agents go through lib/steer's `agentLabel`.
 */
"use client";

import { cn } from "@/lib/utils";
import { paper, field, mono } from "./assistant-ui/elements/surfaces";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useBoard } from "../lib/board";
import { usePolicy } from "../lib/policy";
import { agentLabel, answerSteer, canSpawn, reposOf, setSpawnTarget, useSteer, validRepoName, type SpawnTarget, type SteerAsk } from "../lib/steer";

const AGENTS = ["claude", "codex", "opencode"] as const;
/** The Select's value for "me" (a real name never looks like this). */
const ME = "__run_as_me__";

const btn =
  "text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/90 h-8 rounded-full px-3 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96] disabled:opacity-40";

/** Every name the board knows me by, lowercased. */
function useMyNames(): Set<string> {
  const myActor = useBoard((s) => s.myActor);
  const who = useBoard((s) => s.who.state) as { login?: string; me?: { name?: string; aliases?: string[]; identities?: Array<{ login: string }> } | null } | null;
  return new Set(
    [myActor, who?.login, who?.me?.name, ...(who?.me?.aliases || []), ...(who?.me?.identities || []).map((i) => i.login)]
      .map((x) => String(x || "").toLowerCase().replace(/^@/, ""))
      .filter(Boolean),
  );
}

/** Teammates to offer: people on the board, then people on the team list. */
function useTeammates(): string[] {
  const roster = useBoard((s) => s.roster);
  const who = useBoard((s) => s.who.state) as { people?: Array<{ login: string; pending?: boolean }> } | null;
  const mine = useMyNames();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of [...roster.map((r) => r.actor), ...(who?.people || []).filter((p) => !p.pending).map((p) => p.login)]) {
    const k = String(n || "").toLowerCase().replace(/^@/, "");
    if (!k || mine.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

function useReposOf(actor: string): string[] {
  const events = useBoard((s) => s.events);
  const agents = useBoard((s) => s.teamAgents);
  return reposOf(actor, events, agents);
}

function pick(actor: string, repos: string[]): SpawnTarget {
  return { actor, repo: repos[0] || "", agent: "claude", model: "" };
}

/** "Run as" — me, or a teammate's machine. Renders nothing where this app
 *  cannot start agents for teammates. */
export function RunAsPicker() {
  const spawn = useSteer((s) => s.spawn);
  const teammates = useTeammates();
  const events = useBoard((s) => s.events);
  const agents = useBoard((s) => s.teamAgents);
  const policy = usePolicy();
  if (!canSpawn() || !teammates.length) return null;
  const off = policy.steer === "off";
  return (
    <div data-slot="run-as" className="text-foreground/60 flex items-center gap-2 px-4 pt-2 text-xs">
      <span>Run as</span>
      <Select
        value={spawn ? spawn.actor : ME}
        disabled={off}
        onValueChange={(v: string | null) => {
          if (!v) return;
          setSpawnTarget(v === ME ? null : pick(v, reposOf(v, events, agents)));
        }}
      >
        <SelectTrigger
          size="sm"
          className="h-7 shrink-0 rounded-full border-transparent bg-foreground/[0.04] px-2 text-xs"
          aria-label="Run as"
          title={off ? "Starting agents for teammates is turned off for this team" : "Run the new agent on a teammate's machine, under their account"}
        >
          <SelectValue>{() => (spawn ? `${spawn.actor} (their machine)` : "me (this machine)")}</SelectValue>
        </SelectTrigger>
        <SelectContent align="start">
          <SelectItem value={ME}>me (this machine)</SelectItem>
          {teammates.map((t) => (
            <SelectItem key={t} value={t}>
              {t} (their machine)
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** "+ agent" on a teammate's row. */
export function RunOnTheirs({ actor }: { actor: string }) {
  const repos = useReposOf(actor);
  const policy = usePolicy();
  if (!canSpawn()) return null;
  const off = policy.steer === "off";
  return (
    <button
      type="button"
      data-run-on={actor}
      disabled={off}
      className="text-foreground/50 hover:bg-foreground/[0.06] hover:text-foreground/90 ml-6 mt-0.5 self-start rounded-full px-2 py-0.5 font-medium disabled:opacity-40"
      style={{ fontSize: 11 }}
      title={off ? "Starting agents for teammates is turned off for this team" : `Start a new agent on ${actor}'s machine`}
      onClick={() => {
        setSpawnTarget(pick(actor, repos));
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("#chat textarea")?.focus());
      }}
    >
      + agent on {actor}'s machine
    </button>
  );
}

export function SpawnTargetLine({ t }: { t: SpawnTarget }) {
  const repos = useReposOf(t.actor);
  const policy = usePolicy();
  const set = (patch: Partial<SpawnTarget>) => setSpawnTarget({ ...t, ...patch });
  const typed = t.repo && !validRepoName(t.repo);
  return (
    <div data-slot="spawn-target" className={cn(paper, "flex w-full flex-col gap-2 rounded-[16px] px-4 py-3")}>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13.5px] font-medium">New agent on {t.actor}'s machine</span>
          <span className="text-foreground/50 text-xs">
            Your next message is its first prompt. It runs in {t.actor}'s app, in their repo, with their account and their own safe permission mode.{" "}
            {policy.steer === "on" ? "It starts straight away." : policy.steer === "off" ? "This is turned off for this team; it will be refused." : `${t.actor} approves it first.`}
          </span>
        </div>
        <button type="button" className={btn} onClick={() => setSpawnTarget(null)} aria-label="Run as me instead">
          Cancel
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-foreground/50">Repo</span>
        <input
          data-slot="spawn-repo"
          list="spawn-repos"
          value={t.repo}
          placeholder={repos.length ? "pick or type a folder name" : "type their folder name"}
          onChange={(ev) => set({ repo: ev.target.value.trim() })}
          className={cn(field, mono, "w-44 rounded-full px-3 py-1 text-xs", typed && "ring-1 ring-red-500/60")}
          aria-invalid={Boolean(typed)}
        />
        <datalist id="spawn-repos">
          {repos.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <span className="text-foreground/50 ml-2">Agent</span>
        <div role="radiogroup" aria-label="Agent" className={cn(field, "inline-flex gap-0.5 rounded-full p-0.5")}>
          {AGENTS.map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={t.agent === a}
              onClick={() => set({ agent: a, model: "" })}
              className={cn("h-6 rounded-full px-2.5 text-xs", t.agent === a ? "bg-background text-foreground shadow-sm" : "text-foreground/55 hover:text-foreground/90")}
            >
              {agentLabel(a)}
            </button>
          ))}
        </div>
        {typed ? <span className="text-red-600">a folder name only, like zevet</span> : null}
        {!repos.length && !t.repo ? <span className="text-foreground/45">The board has not seen {t.actor} in a repo yet; their app answers if it has no such folder.</span> : null}
      </div>
    </div>
  );
}

/** The owner's card: exactly what would run, and nothing starts without Start. */
export function SpawnApproval({ a, more }: { a: SteerAsk; more: number }) {
  return (
    <div data-slot="spawn-approval" className={cn(paper, "mx-4 mt-2 flex max-w-lg flex-col gap-3 rounded-[20px] p-4")}>
      <div className="flex flex-col">
        <span className="text-[13.5px] font-medium">{a.from || "A teammate"} wants to start an agent on your machine</span>
        <span className="text-foreground/45 text-xs">
          Nothing runs until you start it{more > 0 ? ` · ${more} more waiting` : ""}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-foreground/50">Agent</dt>
        <dd>
          {agentLabel(a.agent)}
          {a.model ? ` · ${a.model}` : ""} — your account
        </dd>
        <dt className="text-foreground/50">Folder</dt>
        <dd className={cn(mono, "break-all")}>{a.dir || a.repo}</dd>
        <dt className="text-foreground/50">Permissions</dt>
        <dd>your default safe mode (plan or ask first) — never auto, never skip</dd>
      </dl>
      <div className="flex flex-col gap-1">
        <span className="text-foreground/50 text-xs">Prompt</span>
        <pre data-slot="spawn-prompt" className={cn(mono, "text-foreground/80 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs")}>{a.text}</pre>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button type="button" className={btn} onClick={() => void answerSteer(a.id, false)}>
          Decline
        </button>
        <button type="button" className={btn} onClick={() => void answerSteer(a.id, true)}>
          Start it
        </button>
      </div>
    </div>
  );
}
