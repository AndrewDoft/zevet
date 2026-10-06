/**
 * Settings → Team: who is on the team, their role, when they were last seen
 * and which agents they are running, then the invite flow.
 *
 * The member list is read-only and built from the same `whoami` people list
 * the rail uses. Resend / Remove / Invite stay in <TeamInvite /> — one invite
 * flow, shared with the rail's "+" (components/invite.tsx).
 */
import { useEffect } from "react";
import { hueOf, myActorNames, useBoard } from "../../lib/board";
import { agentName } from "../../lib/mentions.mjs";
import { agoLabel } from "../../lib/fmt";
import { TeamInvite, handle } from "../invite";
import { PageSection } from "./parts";
import type { CSSProperties } from "react";

type Person = {
  login: string;
  key?: string;
  owner?: boolean;
  pending?: boolean;
  state?: string;
  lastSeen?: number | null;
  presence?: { eventAt: number | null; boardAt: number | null } | null;
};

export function TeamPanel() {
  const who = useBoard((s) => s.who.state) as unknown as Record<string, unknown> | null;
  const refresh = useBoard((s) => s.refreshWhoami);
  const agents = useBoard((s) => s.teamAgents);
  const myActor = useBoard((s) => s.myActor);
  useEffect(() => {
    if (!who) refresh();
  }, [who, refresh]);

  const people = (Array.isArray(who?.people) ? who!.people : []) as Person[];
  const me = who?.me as { name?: string; identities?: Array<{ login: string }>; aliases?: string[] } | null | undefined;
  const mine = new Set(me ? myActorNames({ name: me.name || "", identities: me.identities, aliases: me.aliases }) : []);
  if (myActor) mine.add(myActor.toLowerCase());
  const now = Date.now();

  return (
    <>
      <PageSection title="Members" summary={people.length ? String(people.length) : undefined}>
        {!who ? <p className="snote">Loading…</p> : null}
        {who && !people.length ? <p className="snote">Nobody yet. Invite someone below.</p> : null}
        {people.length ? (
          <table className="spage-table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last seen</th>
                <th>Agents</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => {
                const names = new Set([p.login, p.key].filter(Boolean).map((n) => String(n).toLowerCase().replace(/^@/, "")));
                const isMe = [...names].some((n) => mine.has(n));
                const theirs = agents.filter((a) => !a.ended && (names.has(a.actor.toLowerCase()) || (isMe && mine.has(a.actor.toLowerCase()))));
                const seen = p.presence?.eventAt || p.presence?.boardAt || p.lastSeen || null;
                return (
                  <tr key={p.key || p.login}>
                    <td>
                      <span className="spage-who">
                        <span className="livedot" style={{ "--who": hueOf(p.login) } as CSSProperties} />
                        {handle(p.login)}
                        {isMe ? <span className="spage-tag">you</span> : null}
                      </span>
                    </td>
                    <td>{p.owner ? "Owner" : "Member"}</td>
                    <td>{p.owner ? "Active" : p.pending ? "Invited" : "Active"}</td>
                    <td>{seen ? agoLabel(seen, now) : p.pending ? "—" : "never"}</td>
                    <td>
                      {theirs.length
                        ? theirs.map((a) => (
                            <div key={a.key} title={a.mission || undefined}>
                              {agentName(a.agent)}
                              <span className="spage-sub"> · {a.state || "running"}{a.repo ? " · " + a.repo : ""}</span>
                            </div>
                          ))
                        : "none running"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </PageSection>
      <PageSection title="Invite and manage">
        <TeamInvite key="team" />
      </PageSection>
    </>
  );
}
