// Inviting a teammate into one selected session (D-NEXT-W2-17).
//
// The inviter's desktop seals the session key with the document key; the hub
// holds the ciphertext and never opens it. A joiner is let in by `checkJoin`,
// which runs five checks in a fixed order and returns the FIRST failure as the
// one actionable error. The checks are pure so the order is testable.

export const MODES = Object.freeze(["watch", "comment", "edit"]);
const MODE_RANK = { watch: 0, comment: 1, edit: 2 };
/** The role a mode needs, named the way the owner sees it in Settings. */
const MODE_ROLE = { watch: "Viewer", comment: "Commenter", edit: "Editor" };
/** ACTION_ROLE key a mode maps to; watch needs only membership. */
export const MODE_ACTION = Object.freeze({ watch: null, comment: "comment", edit: "steer" });

export const INVITE_TTL_MS = 24 * 3600 * 1000;
export const INVITE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
export const INVITE_SEALED_MAX = 4 * 1024;

/** Seats: no seat limit exists anywhere in Zevet (hub, accounts, desktop; there
 *  is no plan or metering), so the seat check is recorded as skipped rather
 *  than invented. When a limit exists it slots in between role and push. */
export const SEAT_CHECK = "skipped";

/**
 * @param {object} c
 * @param {{mode:string, repo:string, actor:string}} c.invite
 * @param {string|null} c.role        joiner's role on this team, null = not a member
 * @param {(action:string)=>boolean} c.can
 * @param {string} c.mode             what the joiner asks to do
 * @param {boolean|null|undefined} c.pushAccess  joiner's desktop's answer for the repo
 * @param {boolean} c.agentOnBoard    the session is still on the board
 * @param {boolean} c.agentOnline     its owner's desktop is reachable (steer channel)
 * @returns {{ok:true, mode:string, readOnly:boolean, skipped:string[]} | {ok:false, check:string, error:string, status:number}}
 */
export function checkJoin(c) {
  const fail = (check, error, status = 403) => ({ ok: false, check, error, status });
  const { invite, mode } = c;
  // 1. member of the team
  if (!c.role) return fail("member", "Join the team first");
  // 2. role
  if (!MODES.includes(mode)) return fail("role", "Pick watch, comment or edit", 400);
  if (MODE_RANK[mode] > MODE_RANK[invite.mode]) return fail("role", `This invite is ${invite.mode} only`);
  const action = MODE_ACTION[mode];
  if (action && !c.can(action)) return fail("role", `Ask the owner for ${MODE_ROLE[mode]}`);
  // 3. seat: no limit exists, skipped (SEAT_CHECK)
  // 4. push access, only for someone who will edit
  if (mode === "edit" && c.pushAccess !== true) {
    return fail("push", c.pushAccess === false ? `No push access to ${invite.repo}. Ask for it on GitHub` : `Open ${invite.repo} in Zevet to check push access`);
  }
  // 5. the session's agent is still available
  if (!c.agentOnBoard) return fail("agent", "Session ended", 404);
  if (mode === "edit" && !c.agentOnline) return fail("agent", `${invite.actor} is offline. Try when they are back`);
  return { ok: true, mode, readOnly: mode === "watch", skipped: ["seat"] };
}

/** In-memory invites, per team. A restart drops them: re-invite. */
export function createInviteStore({ now = Date.now, max = 200 } = {}) {
  const byTeam = new Map();
  const of = (team) => byTeam.get(team) || byTeam.set(team, new Map()).get(team);
  return {
    add(team, inv) {
      const m = of(team);
      m.set(inv.id, { ...inv, at: now() });
      while (m.size > max) m.delete(m.keys().next().value);
    },
    get(team, id) {
      const inv = of(team).get(id);
      if (!inv) return null;
      if (now() - inv.at > INVITE_TTL_MS) {
        of(team).delete(id);
        return null;
      }
      return inv;
    },
  };
}
