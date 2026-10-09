// What the hub does FOR Masora's Forum: the hub holds the team secret, so it seals a steer or an approval answer on a
// caller's behalf, exactly as that person's desktop would (client/doc-crypto.mjs; desktop/agent-steer.js and
// desktop/agent-approval.js for the AAD). Duplicated rather than imported for the reason accounts.mjs gives for
// deriveAuthToken; test/masora-bridge.test.mjs pins every function here to the client's.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const DOC_SALT = Buffer.from("zevet/doc-key/v1", "utf8");
const DOC_INFO = Buffer.from("zevet-doc", "utf8");
const VERSION = 1;

/** The AES-256-GCM document key for a team's master secret (client/secret.mjs deriveDocKey), or null if unusable. */
export function docKeyOf(secret) {
  const s = String(secret || "").trim().replace(/\s+/g, "").toLowerCase();
  if (!/^[0-9a-f]{48,}$/.test(s) || s.length % 2) return null;
  return Buffer.from(hkdfSync("sha256", Buffer.from(s, "hex"), DOC_SALT, DOC_INFO, 32));
}

export function seal(key, aad, plaintext) {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, "utf8")), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, ct, c.getAuthTag()]).toString("base64");
}

/** Throws when it does not open. */
export function open(key, aad, sealed) {
  const b = Buffer.from(String(sealed || ""), "base64");
  if (b.length < 29 || b[0] !== VERSION) throw new Error("not a sealed frame");
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(1, 13));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(13, b.length - 16)), d.final()]).toString("utf8");
}

export const steerAad = ({ id, to, session }) => `steer\u0000${id}\u0000${String(to || "").toLowerCase().replace(/^@/, "")}\u0000${session}`;
export const cardAad = ({ id, session }) => `approval-card\u0000${id}\u0000${session}`;
export const answerAad = ({ id, session, hash }) => `approval-answer\u0000${id}\u0000${session}\u0000${hash}`;

/** One line for a card: the tool and what it was asked to do. */
export function cardText(card) {
  const args = typeof card.arguments === "string" ? card.arguments : JSON.stringify(card.arguments ?? "");
  return `${card.tool || "tool"} ${args}`.replace(/\s+/g, " ").trim().slice(0, 300);
}
