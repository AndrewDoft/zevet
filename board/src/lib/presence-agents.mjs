import { agentClientId, agentLabel, AGENT_TTL_MS } from "./presence.mjs";

/**
 * Synthetic Yjs awareness states, one per agent, so the editor's ordinary
 * remote-selection layer draws "Mina · Claude Code" over the lines the agent
 * just edited. Each agent gets its own tiny Awareness (own clientID, derived
 * from actor+agent) whose updates are applied to the editor's awareness and
 * sent to the room like any other presence frame.
 *
 * The state is a SELECTION over the located range, never a caret at a guess,
 * and it is removed AGENT_TTL_MS after the last edit that located it.
 *
 * deps: { Y, Awareness, awarenessProtocol, ydoc, awareness, send(bytes),
 *         ttlMs?, setTimeout?, clearTimeout? }   (Y etc. from the editor bundle)
 */
export class AgentPresence {
  constructor(d) {
    this.d = d;
    this.live = new Map(); // clientID -> { aw, timer }
  }

  /** range = { from, to, fromLine, toLine, actor, agent, tool }; color = css colour. */
  show(range, color) {
    const { Y, Awareness, awarenessProtocol: ap, ydoc, awareness, ttlMs = AGENT_TTL_MS } = this.d;
    const st = this.d.setTimeout || setTimeout;
    const ct = this.d.clearTimeout || clearTimeout;
    const id = agentClientId(range.actor, range.agent);
    let e = this.live.get(id);
    if (!e) {
      const proxy = new Y.Doc();
      proxy.clientID = id;
      e = { aw: new Awareness(proxy), timer: null };
      this.live.set(id, e);
    }
    const ytext = ydoc.getText("content");
    const rel = (i) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, i));
    e.aw.setLocalState({
      user: { name: agentLabel(range.actor, range.agent), color, colorLight: color + "33" },
      cursor: { anchor: rel(range.from), head: rel(range.to) },
      agent: { actor: range.actor, agent: range.agent, tool: range.tool, fromLine: range.fromLine, toLine: range.toLine },
    });
    this.push(e.aw, id, ap, awareness);
    if (e.timer) ct(e.timer);
    e.timer = st(() => this.hide(id), ttlMs);
    if (e.timer && e.timer.unref) e.timer.unref();
  }

  hide(id) {
    const e = this.live.get(id);
    if (!e) return;
    this.live.delete(id);
    if (e.timer) (this.d.clearTimeout || clearTimeout)(e.timer);
    e.aw.setLocalState(null);
    this.push(e.aw, id, this.d.awarenessProtocol, this.d.awareness);
    e.aw.destroy();
  }

  clear() {
    for (const id of [...this.live.keys()]) this.hide(id);
  }

  push(aw, id, ap, target) {
    const bytes = ap.encodeAwarenessUpdate(aw, [id]);
    // "remote" so the room's own `awareness.on("update")` does not send it twice.
    ap.applyAwarenessUpdate(target, bytes, "remote");
    this.d.send(bytes);
  }
}
