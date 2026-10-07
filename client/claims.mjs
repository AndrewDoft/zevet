const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export function claimEnvelope(claim, seal) {
  return { type: "claim", sealed: seal({ path: claim.path, session: claim.session, actor: claim.actor, expiresAt: claim.expiresAt }) };
}

export function claimActivity(claim, seal) {
  const envelope = claimEnvelope(claim, seal);
  return { kind: "claim", claim: envelope.sealed, session: String(claim.session || ""), actor: String(claim.actor || "") };
}

export class ClaimStore {
  #claims = new Map();
  constructor({ now = () => Date.now(), broadcast = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) { this.now = now; this.broadcast = broadcast; this.timeoutMs = timeoutMs; }
  claim({ path, session, actor, timeoutMs = this.timeoutMs }) {
    const value = { path: String(path), session: String(session), actor: String(actor || ""), expiresAt: this.now() + timeoutMs };
    this.#claims.set(value.path, value); this.broadcast(value); return value;
  }
  endSession(session) { for (const [path, value] of this.#claims) if (value.session === session) this.#claims.delete(path); }
  expire() { for (const [path, value] of this.#claims) if (value.expiresAt <= this.now()) this.#claims.delete(path); }
  isClaimed(path) { this.expire(); return this.#claims.has(String(path)); }
  claims() { this.expire(); return [...this.#claims.values()]; }
}

export { DEFAULT_TIMEOUT_MS };
