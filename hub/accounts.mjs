// Who is allowed on this hub, what their session is, and the one shared secret.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT REPLACED WHAT
//
// Until now the hub held a single `ZEVET_TOKEN` and compared it byte for byte.
// Everyone shared it, it arrived by being pasted into a setup window, and
// Andrew's verdict on that (2026-09-19) was "people should be able to use the
// app without having to enter some long code."
//
// So: sign in with GitHub, and the hub decides. This file is the decision.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ THE HONEST VERSION OF WHAT THIS COSTS. READ THIS BEFORE TRUSTING THE HUB.
//
// zevet's editor encrypts file contents with a key derived from a master secret
// S (client/secret.mjs). The entire point of that design was that THE HUB NEVER
// HELD S, so a hub operator — or anyone who got into the box, or read its disk,
// or found its backups — could relay the traffic without being able to read it.
//
// This file holds S. It has to: handing S to a teammate who has just proved who
// they are on GitHub is the only way to get them editing without anyone typing
// or approving anything, and "no user friction at all" (Andrew, 2026-09-19,
// overriding his own earlier pick of the device-approval design) is the
// requirement. So the end-to-end property is GONE, deliberately, and every
// place that claimed it has been changed to stop claiming it.
//
// What is still true, and worth keeping straight:
//
//   • The traffic is still encrypted in transit and at rest in the relay — a
//     network observer, and the event log, still see ciphertext.
//   • The hub can now decrypt document traffic. An honest-but-curious operator
//     was previously blocked; now they are not.
//   • That gap was always narrower than it looked. The board's JavaScript is
//     served BY the hub into a window that holds the key, so a COMPROMISED hub
//     could already take plaintext (client/secret.mjs says so at length). What
//     is lost is the defence against a hub that is merely watched, not taken.
//
// The design that keeps the old property is written down and was not built:
// the joiner generates an X25519 keypair, an already-trusted teammate seals S
// to it, and the hub relays two blobs it cannot open. It costs one approval
// click and the joiner waits for somebody to be online. If the tradeoff above
// ever reads worse than that wait, that is the build.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ WHERE THE STATE FILE LIVES, AND WHY IT IS NOT IN THE TREE
//
// `/srv/zevet` on the deployed box is a tarball extracted IN PLACE over the top
// of itself on every release (docs/RELEASING.md). Extraction does not delete
// files the tarball does not mention, so `var/accounts.json` survives a deploy
// — but only as long as `var/` is never IN the tarball. It is in .gitignore for
// exactly that reason, which is load-bearing and not tidiness: shipping a
// var/accounts.json would overwrite every session and the shared secret on the
// next release, signing out the whole team and orphaning every encrypted
// document in one command.

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

/** Sessions are 32 bytes of hex — the SAME WIDTH as a derived auth token, on
 *  purpose. `tokenOk` in server.mjs checks length before it checks anything
 *  else, and a session that was a different shape would take a different code
 *  path through every auth site in the file. One shape, one path. */
const SESSION_BYTES = 32;

/** How long a session lives without being used. Ninety days: long enough that
 *  nobody signs in twice in a quarter, short enough that a laptop that left the
 *  company stops working within one. */
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** How long a minted invite key is redeemable. Fourteen days: long enough that
 *  an invite emailed on a Friday still works the following week, short enough
 *  that a key nobody used stops being a standing way in. */
const INVITE_KEY_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** No 0/O, 1/I/L, or 2/Z — the pairs a person misreads off a phone screen or a
 *  screenshot. 8 characters from this alphabet is ~38 bits, plenty for a
 *  one-time, 14-day, rate-limited code. */
const KEY_ALPHABET = "3456789ABCDEFGHJKMNPQRSTUVWXY";

/** XXXX-XXXX, crypto-random. */
function randomInviteKey() {
  const raw = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += KEY_ALPHABET[raw[i] % KEY_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Only the hash is ever stored — see `inviteKey`/`redeem`. Normalised first so
 *  a key typed lowercase, or without its dash, still hashes to what was minted. */
function hashInviteKey(key) {
  const norm = String(key || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return createHash("sha256").update(norm).digest("hex");
}

/**
 * Every identity carries the provider that vouched for it.
 *
 * ⚠️ AN ID IS ONLY UNIQUE WITHIN ITS PROVIDER. A GitHub numeric id and a Google
 * `sub` are both digit strings out of two unrelated namespaces, so any lookup
 * that compares `id` alone can match the wrong person. Every comparison in this
 * file goes through `samePerson` for that reason, and there is no code path
 * that matches on an id by itself.
 *
 * Records written before Google existed have no `provider` field. They are
 * GitHub's, and `#load` fills it in — which is the entire migration.
 */
const DEFAULT_PROVIDER = "github";

const EMPTY = () => ({ version: 1, secret: "", name: "", domain: "", masoraWorkspace: "", owner: null, allowed: [], blocked: [], sessions: {}, presence: {}, createdAt: null, credentials: [], policy: {}, audit: [] });

/** Team-wide policies an admin (the owner) sets, and every value each may take.
 *  `steer`: may a teammate steer somebody else's agent — `on` always, `ask`
 *  the owner of the agent approves each one (the default), `off` never. The
 *  hub enforces it (server.mjs § steering); the desktop only obeys.
 *  `approve` (D-086): may a teammate answer somebody else's agent's
 *  permission prompt — `on` the answer is applied, `ask` it is shown to the
 *  agent's owner who still clicks, `off` never (the default: it lets a remote
 *  person authorise a tool call on another machine). */
export const POLICY_VALUES = Object.freeze({
  steer: Object.freeze(["on", "ask", "off"]),
  approve: Object.freeze(["on", "ask", "off"]),
  retention: Object.freeze(["forever", "90d", "30d", "7d", "1d"]),
});
export const DEFAULT_POLICY = Object.freeze({ steer: "ask", approve: "off", retention: "forever" });
/** `retention`: how long the hub keeps prompt and command text (`detail`) on
 *  the board and in the event log. Who/tool/file/repo is never trimmed. */
export const RETENTION_MS = Object.freeze({ forever: 0, "90d": 90 * 864e5, "30d": 30 * 864e5, "7d": 7 * 864e5, "1d": 864e5 });
const AUDIT_MAX = 200;

/** Per-person roles, lowest to highest. `owner` is not stored: it is whoever
 *  holds `state.owner`, and cannot be granted or taken away here. Everyone
 *  else carries `role`; a record without a valid one is an Editor, which is
 *  the whole migration — before roles every member could do all of it. */
export const ROLES = Object.freeze(["viewer", "commenter", "editor", "owner"]);
export const ASSIGNABLE_ROLES = Object.freeze(["viewer", "commenter", "editor"]);
const DEFAULT_ROLE = "editor";
const roleRank = (r) => ROLES.indexOf(r);
const validRole = (r) => (ASSIGNABLE_ROLES.includes(r) ? r : DEFAULT_ROLE);

/** The least role each gated action needs. The hub reads this at the route,
 *  never the desktop: a demoted person's next request is refused. */
export const ACTION_ROLE = Object.freeze({
  comment: "commenter",
  claim: "commenter",
  report: "editor",
  steer: "editor",
  approve: "editor",
  spawn: "editor",
  takeover: "editor",
  share: "editor",
  credential: "editor",
  // Writing to a `tasks:` document room. The hub cannot tell a comment from an edit
  // (sealed), so it holds the floor at Commenter; clients enforce the rest.
  tasks: "commenter",
  // Same floor for a `chat:` room: Viewers read, Commenter and above post.
  chat: "commenter",
});

/** A stored credential record, minus its `key` — what everything except
 *  /team/credentials/:id/secret itself is allowed to see. */
function credentialMeta(c) {
  const { key, ...meta } = c;
  return meta;
}

/** Same person? Provider AND id, never id alone. A record with no id yet (an
 *  invitation nobody has accepted) matches nobody — it is matched by login, at
 *  the one call site that needs to. */
function samePerson(a, b) {
  return Boolean(a && b && a.id && b.id && a.id === b.id && provider(a) === provider(b));
}

/** The provider of a record, with the pre-Google default applied. Read through
 *  this rather than the field, so a record that reached memory from somewhere
 *  other than `#load` cannot be compared as `undefined`. */
function provider(rec) {
  return String((rec && rec.provider) || DEFAULT_PROVIDER);
}

/** How to name somebody in a sentence a person reads. A GitHub login wants its
 *  "@"; an email address already has one and gains nothing from a second. */
function display(rec) {
  const l = String((rec && rec.login) || "");
  return provider(rec) === "github" ? `@${l}` : l;
}

/** A record's identities, primary first. A person record is the old allowlist
 *  row plus, optionally, `identities` — every OTHER sign-in that person has
 *  proved they control (or, for a merged pending invite, still has to). Top-level
 *  provider/login/id stay the primary, so every reader written before linking
 *  existed still sees one identity. */
function idents(rec) {
  return [{ provider: provider(rec), login: rec.login, id: rec.id || "", display: rec.display, emails: rec.emails || [] }, ...(rec.identities || []).map((i) => ({ ...i, provider: provider(i) }))];
}

/** Does this identity belong to this person record? Provider AND id. */
function owns(rec, ident) {
  return idents(rec).some((i) => samePerson(i, ident));
}

/** The address an identity is EVIDENCE for. A Google identity's login is an
 *  email Google verified — but an invite-key redemption mints a synthetic
 *  `key-…` id for a TYPED address nobody verified, which proves nothing. */
function emailEvidence(i) {
  return i.provider === "google" && i.id && !String(i.id).startsWith("key-") ? [String(i.login).toLowerCase()] : [];
}

/** Every verified email known to belong to this person. */
function emailsOf(rec) {
  return new Set(idents(rec).flatMap((i) => [...(i.emails || []), ...emailEvidence(i)]).map((e) => String(e).toLowerCase()));
}

/** Store a person's identities, identified ones first (a pending row that has
 *  gained a real identity must stop being "pending"), mirroring the primary
 *  into the top-level fields. */
function setIdents(rec, list) {
  const seen = new Set();
  const uniq = [];
  for (const i of list) {
    const k = i.id ? `${provider(i)}\0${i.id}` : `${provider(i)}\0~${String(i.login).toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const emails = uniqStrings((i.emails || []).map((e) => String(e).toLowerCase()));
    uniq.push({ provider: provider(i), login: String(i.login).toLowerCase(), id: i.id || "", display: i.display || i.login, ...(emails.length ? { emails } : {}) });
  }
  uniq.sort((a, b) => (a.id ? 0 : 1) - (b.id ? 0 : 1));
  const [p, ...rest] = uniq;
  rec.provider = p.provider;
  rec.login = p.login;
  rec.id = p.id;
  if (p.emails) rec.emails = p.emails;
  else delete rec.emails;
  if (!rec.named || !rec.display) rec.display = p.display;
  if (rest.length) rec.identities = rest;
  else delete rec.identities;
}

/** A name a person may take: one line, at most 40 characters (an event's
 *  `actor` is cut to 40, so a longer name could never match its own events). */
const cleanName = (n) => String(n || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);

const uniqStrings = (a) => [...new Set(a.filter(Boolean))];

/** The verified addresses a sign-in carries. Never the public-profile one:
 *  callers put those in `user.email`, and only `user.emails` is proof. */
function verifiedEmails(user) {
  const list = Array.isArray(user.emails) ? user.emails : [];
  return uniqStrings(list.map((e) => String(e || "").trim().toLowerCase()).filter((e) => e.includes("@")));
}

/**
 * What a sign-in may tell Masora (POST /auth/masora/assertion): the addresses THIS provider verified at THIS sign-in,
 * never the person's merged set. Google: `email_verified` (google-auth.mjs). Microsoft: only with `xms_edov`
 * (microsoft-auth.mjs leaves `emails` empty otherwise). GitHub: the verified PRIMARY address only. Nothing for an
 * invite key (`key-`), whose address was typed, or for a sign-in FROM Masora (`masora:`), which would only reflect
 * Masora's own claim back to it.
 */
function proofEmails(user, rec) {
  if (/^(key-|masora:)/.test(rec.id)) return [];
  const verified = verifiedEmails(user);
  if (rec.provider === "github") {
    const primary = String(user.primaryEmail || "").trim().toLowerCase();
    return primary && verified.includes(primary) ? [primary] : [];
  }
  return rec.provider === "google" || rec.provider === "microsoft" ? verified : [];
}

/** A sign-in's proof of email is good for Masora for this long; after it, sign in to the hub again. Bounds what a
 *  provider-side address change (a Workspace admin reassigning a mailbox) can carry over. */
const MASORA_PROOF_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class Accounts {
  /**
   * `file`   — where to persist. Defaults to `<hub>/../var/accounts.json`.
   * `secret` — the master secret to adopt if the file has none, normally
   *            `ZEVET_SECRET`. This is the MIGRATION PATH: the deployed hub
   *            already has an S in the field, held by installs that were set up
   *            by hand, and generating a fresh one here would lock every one of
   *            them out and make their encrypted documents unreadable.
   * `now`    — injectable clock, so session expiry is testable without waiting
   *            ninety days.
   */
  constructor({ file, secret = "", now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.state = this.#load();

    if (!this.state.secret) {
      // An adopted secret is normalised to the same shape newMasterSecret
      // produces. A malformed ZEVET_SECRET is REFUSED rather than replaced:
      // silently generating a different one would hand out a key that decrypts
      // nothing anybody already has, and the symptom would be an editor full of
      // empty documents with no error anywhere.
      const adopted = String(secret || "").trim().toLowerCase();
      if (adopted && !/^[0-9a-f]{48,}$/.test(adopted)) {
        throw new Error("ZEVET_SECRET is set but is not at least 24 bytes of hex");
      }
      this.state.secret = adopted || randomBytes(24).toString("hex");
      this.#save();
    }

    // Same shape as the secret above: set once, on the file's first write, and
    // never touched again. An accounts.json from before this existed has no
    // `createdAt` either — #load defaults it to `now()` on the read that first
    // notices, which reads as "just created" rather than "ancient", the safe
    // direction to be wrong in for something a sweep is about to delete.
    if (!this.state.createdAt) {
      this.state.createdAt = this.now();
      this.#save();
    }
  }

  /** The master secret. Handed to a client only after it has proved who it is,
   *  and never logged — every caller is expected to keep it out of a log line. */
  get secret() {
    return this.state.secret;
  }

  /** When this file was first written — see team-expiry sweeping in
   *  server.mjs, the one caller that reads this today. */
  get createdAt() {
    return this.state.createdAt;
  }

  /** What the team calls itself; "" for a team made before names existed. */
  get name() {
    return this.state.name;
  }

  setName(name) {
    this.state.name = name;
    this.#save();
  }

  /** The Masora workspace this team was opened for ("" when none): the key hub/masora-auth.mjs maps a
   *  sign-in from Masora to a team by. */
  get masoraWorkspace() {
    return this.state.masoraWorkspace || "";
  }

  bindMasoraWorkspace(wid) {
    this.state.masoraWorkspace = String(wid);
    this.#save();
  }

  /**
   * A person Masora vouches for (docs/contracts/cross_app_context.md "Hub sign-in"). Stored as a Google-style
   * record keyed by email, so the same person signing in with Google later auto-links through `#byEmail`
   * instead of becoming a second row. A person removed from THIS team stays removed (`#blocked`), and an
   * ownerless team opens only for a Masora admin, so a member cannot become its owner by arriving first.
   */
  signInMasora({ sub, email, name, admin }) {
    const login = String(email).toLowerCase();
    const user = { provider: "google", login, id: `masora:${sub}`, display: String(name || login), emails: [login] };
    if (this.#blocked(user)) return { ok: false, error: `${login} was removed from this team` };
    if (!this.state.owner && !admin) return { ok: false, error: "a workspace admin has to open this team first" };
    const r = this.signIn(user);
    return { ok: true, token: r.token, owner: r.owner, login };
  }

  /** `{sub, provider, emails}` for a Masora assertion, or null: the session (as `session()` returned it) must carry
   *  a proof under a day old, and the identity that proved it must still be this person's (unlinked = no claim). */
  masoraClaims(sess) {
    const pr = sess && sess.proof;
    if (!pr || !Array.isArray(pr.emails) || !pr.emails.length || !pr.id) return null;
    if (!(this.now() - pr.at <= MASORA_PROOF_MAX_AGE_MS)) return null;
    const person = this.#personOf(sess);
    if (!person || person !== this.#personOf({ provider: pr.provider, id: pr.id })) return null;
    return { sub: `${pr.provider}:${pr.id}`, provider: pr.provider, emails: pr.emails.slice() };
  }

  /** This team's policies, defaults filled in. */
  get policy() {
    return { ...DEFAULT_POLICY, ...(this.state.policy || {}) };
  }

  /** Change one policy. The route decides WHO may (owner only); this decides
   *  WHAT may be stored, and records it in the audit trail either way. */
  setPolicy(key, value, by) {
    if (!Object.hasOwn(POLICY_VALUES, key)) return { ok: false, error: `unknown policy: ${String(key)}` };
    if (typeof value !== "string" || !POLICY_VALUES[key].includes(value)) {
      return { ok: false, error: `${key} must be one of ${POLICY_VALUES[key].join(", ")}` };
    }
    const was = this.policy[key];
    this.state.policy = { ...this.policy, [key]: value };
    this.state.audit = [...(this.state.audit || []), { at: this.now(), by: String(by || ""), what: `policy.${key}`, from: was, to: value }].slice(-AUDIT_MAX);
    this.#save();
    return { ok: true, policy: this.policy, changed: was !== value };
  }

  /** The role of the person behind `ref` (a session or {provider, login, id}),
   *  or null if they are nobody on this team. Read live on every call, so a
   *  demotion bites on the very next request. */
  roleOf(ref) {
    const r = ref ? this.#personOf(ref) : null;
    if (!r) return null;
    return r === this.state.owner ? "owner" : validRole(r.role);
  }

  /** May `ref` do `action` (a key of ACTION_ROLE)? Unknown actions are refused. */
  can(ref, action) {
    const need = ACTION_ROLE[action];
    const have = this.roleOf(ref);
    return Boolean(need && have && roleRank(have) >= roleRank(need));
  }

  /** Give somebody a role. The route decides WHO may (owner only). The owner
   *  cannot be re-roled and nobody is made owner here. Audited either way. */
  setRole(login, role, by) {
    const l = String(login || "").trim().replace(/^@/, "").toLowerCase();
    if (!ASSIGNABLE_ROLES.includes(role)) return { ok: false, error: `role must be one of ${ASSIGNABLE_ROLES.join(", ")}` };
    const rec = this.#people().find((r) => idents(r).some((i) => i.login === l));
    if (!rec) return { ok: false, error: "no such person on this team" };
    if (rec === this.state.owner) return { ok: false, error: "the owner's role cannot be changed" };
    const was = validRole(rec.role);
    rec.role = role;
    this.state.audit = [...(this.state.audit || []), { at: this.now(), by: String(by || ""), what: `role.${rec.login}`, from: was, to: role }].slice(-AUDIT_MAX);
    this.#save();
    return { ok: true, role, changed: was !== role };
  }

  /** Who changed what, oldest first (bounded). */
  get audit() {
    return (this.state.audit || []).slice();
  }

  /** Every name (display, logins, aliases; lowercase, no "@") the person
   *  behind a session goes by — what an event's `actor` may be for them.
   *  [] for a session that belongs to nobody. */
  namesOfSession(sess) {
    const r = sess ? this.#personOf(sess) : null;
    return r ? this.#namesOf(r) : [];
  }

  /** The login that set this hub up, or null if nobody has yet. */
  get owner() {
    return this.state.owner ? this.state.owner.login : null;
  }

  /** The Google Workspace domain this team's owner signed in with, or "" if
   *  they never have (a GitHub owner, or a Google owner on a personal
   *  account). This is the ONE value `setDomain` will ever accept — see its
   *  own comment for why it is not an arbitrary string. */
  get ownerHd() {
    return this.state.owner && this.state.owner.hd ? String(this.state.owner.hd) : "";
  }

  /** This team's own "Anyone at `<domain>`" rule — "" when off. Distinct from
   *  the hub-wide `ZEVET_GOOGLE_DOMAIN` fallback env var (server.mjs's
   *  `domainFor` is what falls back to that, and only for the default team):
   *  this is per-team, stored right here, so a created team's owner can turn
   *  it on for their own Workspace without an operator touching the hub's
   *  environment at all. */
  get domain() {
    return this.state.domain || "";
  }

  /**
   * Turn the domain door on or off for this team.
   *
   * ⚠️ NOT AN ARBITRARY DOMAIN. The only value this will ever set is the
   * owner's OWN `hd` (or "" to turn it off) — never a domain typed in by
   * hand. Accepting any string here would let an owner grant entry to a
   * domain they do not administer and have never proven anything about;
   * `hd` is the one domain Google has already vouched this owner belongs to.
   */
  setDomain(value) {
    const v = String(value || "").trim().toLowerCase();
    if (!v) {
      this.state.domain = "";
      this.#save();
      return { ok: true };
    }
    const hd = this.ownerHd;
    if (!hd) return { ok: false, error: "the owner did not sign in with a Google Workspace account" };
    if (v !== hd.toLowerCase()) return { ok: false, error: `only ${hd} can be set — that is the owner's own Workspace domain` };
    this.state.domain = hd;
    this.#save();
    return { ok: true };
  }

  /** Every team-held model credential, metadata only — never the secret.
   *  Stored like `secret` — plaintext in the 0600 accounts file — because
   *  wrapping one field under `secret` in the SAME file protects it against
   *  nothing that does not already have `secret`. */
  listCredentials() {
    return this.state.credentials.map(credentialMeta);
  }

  /** One credential's metadata (no key), or null. Used both to answer a
   *  single lookup and, in hub/server.mjs, to learn who added it before a
   *  delete is allowed to proceed. */
  credential(id) {
    const c = this.state.credentials.find((c) => c.id === id);
    return c ? credentialMeta(c) : null;
  }

  /** The raw secret for one credential, or null. Never logged — the only
   *  caller is /team/credentials/:id/secret's own response. */
  credentialKey(id) {
    const c = this.state.credentials.find((c) => c.id === id);
    return c ? c.key : null;
  }

  /** Add a team credential. `provider`/`kind`/format validation is
   *  hub/server.mjs's job, before this is called — this layer only persists
   *  what it is handed and mints the id. Returns the new record's metadata
   *  (no key). */
  addCredential({ label, provider, kind, key, addedBy }) {
    const rec = {
      id: randomBytes(8).toString("hex"),
      label: String(label || "").trim() || `${provider} ${kind === "subscription_token" ? "subscription token" : "key"}`,
      provider: String(provider),
      kind: String(kind),
      key: String(key),
      last4: String(key).slice(-4),
      addedBy: String(addedBy || ""),
      createdAt: new Date(this.now()).toISOString(),
    };
    this.state.credentials.push(rec);
    this.#save();
    return credentialMeta(rec);
  }

  /** Remove one credential by id. Returns whether one existed to remove —
   *  the caller decides WHO may do this (owner, or whoever added it) before
   *  calling; this only performs the removal. */
  removeCredential(id) {
    const before = this.state.credentials.length;
    this.state.credentials = this.state.credentials.filter((c) => c.id !== id);
    if (this.state.credentials.length === before) return false;
    this.#save();
    return true;
  }

  /** Everyone permitted, owner first. `provider` is normalised on the way out
   *  so no caller has to know about the pre-Google default. */
  list() {
    const out = this.state.owner ? [{ ...this.state.owner, provider: provider(this.state.owner), owner: true, role: "owner" }] : [];
    for (const a of this.state.allowed) out.push({ ...a, provider: provider(a), owner: false, role: validRole(a.role) });
    return out;
  }

  /** Has this person been thrown out? Checked separately from the allowlist
   *  because a Workspace domain admits by RULE — removing such a person from
   *  `allowed` would let them walk straight back in on their next sign-in, so
   *  revocation has to leave something behind that says no. */
  #blocked(user) {
    return this.state.blocked.some((b) => samePerson(b, user));
  }

  /**
   * May this GitHub user in?
   *
   * ⚠️ TRUST ON FIRST USE. An empty hub admits the FIRST person to sign in and
   * makes them the owner. This is the same bargain as a new phone or a fresh
   * router: whoever reaches it first owns it, and the window is the minutes
   * between deploying a hub and signing into it.
   *
   * It is chosen over a hardcoded login because the alternative is a release
   * that names one person, or an env var that has to be right before the first
   * sign-in will work at all — and getting THAT wrong locks everyone out of a
   * box behind IAP with no way back in but ssh.
   *
   * ⚠️ IT IS NOT SAFE ON A HUB THAT IS PUBLIC AND UNCLAIMED. The window is real.
   * `ZEVET_GITHUB_OWNER` closes it: set it, and only that login can claim the
   * hub, no matter who reaches it first.
   */
  mayEnter(user, { requiredOwner = "", domain = "", domains = [] } = {}) {
    const me = {
      provider: provider(user),
      login: String(user.login || "").toLowerCase(),
      id: String(user.id || ""),
      email: user.email ? String(user.email).toLowerCase() : "",
      // VERIFIED addresses only (GitHub's /user/emails verified rows, or the
      // Google id token's verified email) — the only evidence linking uses.
      emails: verifiedEmails(user),
    };
    if (!me.login || !me.id) return { ok: false, error: `${{ google: "Google", microsoft: "Microsoft" }[me.provider] || "GitHub"} did not say who you are` };

    // ⚠️ CHECKED BEFORE EVERYTHING, INCLUDING TRUST-ON-FIRST-USE. A revoked
    // person must not be able to claim an unowned hub, and must not be let back
    // in by the domain rule at the bottom.
    if (this.#blocked(me)) return { ok: false, error: `${display(me)} was removed from this team` };

    if (!this.state.owner) {
      const want = String(requiredOwner || "").trim().toLowerCase().replace(/^@/, "");
      if (want && want !== me.login) {
        return { ok: false, error: `this team is reserved for ${display({ ...me, login: want })}` };
      }
      return { ok: true, first: true };
    }

    // The id is what is checked when both sides have one. A login is renameable
    // and, once renamed, claimable by a stranger — an allowlist keyed on the
    // string alone is an allowlist that can be inherited.
    // Any identity the person has linked counts, not only the one they first
    // signed in with.
    if (this.#personOf(me)) return { ok: true, first: false };
    // An invitation the owner typed has no id until its first sign-in, so it
    // can only be matched by login — within its own provider, because
    // "andrew" on GitHub and "andrew@…" on Google are different people and a
    // cross-provider login match would be a way to inherit someone's seat.
    if (this.#pendingFor(me.provider, me.login)) return { ok: true, first: false };

    /* A VERIFIED email that is already this team's — a member's proven address,
     * or one a pending invite was typed for — admits and links, from either
     * provider. Never the unverified or merely public-profile kind. */
    for (const e of me.emails) {
      if (this.#byEmail([e]).length || this.#pendingFor("google", e)) return { ok: true, first: false };
    }

    /**
     * ⚠️ THE ONE CROSS-PROVIDER MATCH, AND IT IS EMAIL ONLY. An invite typed
     * as an email address is stored as a "google" record (see `allow`) purely
     * because that is the identity type an "@"-containing login means — it
     * is not a claim that the invited person will sign in with Google. So a
     * GitHub sign-in whose GitHub-verified primary email matches that
     * invited address is admitted too, exactly as a Google sign-in with that
     * email already is by the loop above. `me.email` only ever arrives here
     * already lower-cased (github-auth.mjs), same as every stored login.
     */
    if (me.provider === "github" && me.email) {
      const invited = this.state.allowed.find((a) => !a.id && provider(a) === "google" && a.login === me.email);
      if (invited) return { ok: true, first: false };
    }

    /**
     * ⚠️ THE DOMAIN DOOR. Anyone whose Google account is administered by
     * `domain` gets in without being invited — that is the point of it, and it
     * is a genuinely different bargain from the GitHub allowlist: it delegates
     * "who works here" to the Workspace admin, where that question actually
     * lives. Somebody who leaves loses their account and stops being able to
     * sign in, without anybody remembering to revoke them here.
     *
     * The gate is `hd`, which Google asserts and only Workspace accounts carry.
     * `google-auth.mjs` explains at length why the email suffix is not the same
     * test and must never be substituted for it.
     */
    if (me.provider === "google" && domain && String(user.hd || "").toLowerCase() === String(domain).toLowerCase()) {
      return { ok: true, first: false, byDomain: true };
    }

    /* ⚠️ THE MAPPED-DOMAINS DOOR (ZEVET_TEAM_DOMAINS): the same door for a LIST
     * of domains, and stricter because nothing upstream gated on `hd`. BOTH the
     * `hd` claim (a Workspace Google administers) AND a verified email on that
     * same domain must hold — a personal gmail has no `hd`, and an unverified
     * address is dropped by `verifiedEmails`. */
    if (me.provider === "google" && domains.length) {
      const hd = String(user.hd || "").toLowerCase();
      if (hd && domains.includes(hd) && me.emails.some((e) => e.split("@")[1] === hd)) {
        return { ok: true, first: false, byDomain: true };
      }
    }

    // `display(this.state.owner)`, not `this.owner` — the latter is the bare
    // login, and printing it raw drops the "@" that every other mention of a
    // GitHub user in this file carries.
    return { ok: false, error: `${display(me)} is not on this team's list — ask ${display(this.state.owner)} to add you` };
  }

  /**
   * Record a successful sign-in and mint a session.
   *
   * ⚠️ THE GITHUB ACCESS TOKEN IS NOT STORED, ANYWHERE, EVER. It is used once,
   * to ask GitHub for a login, and then dropped. Keeping it would turn this
   * JSON file from "a list of names" into "a set of live credentials to other
   * people's GitHub accounts", which is a far worse thing to have on a box and
   * buys nothing: zevet never calls GitHub again on anyone's behalf.
   */
  signIn(user) {
    const rec = {
      provider: provider(user),
      login: String(user.login).toLowerCase(),
      display: String(user.display || user.login),
      id: String(user.id),
      added: new Date(this.now()).toISOString(),
      // "" for GitHub, and for a personal Google account — only a Google
      // Workspace sign-in ever carries one. Kept on every record (not only
      // the owner's) because it costs nothing and `ownerHd` is what actually
      // reads it back.
      hd: user.hd ? String(user.hd) : "",
    };
    const emails = verifiedEmails(user);

    let person;
    if (!this.state.owner) {
      person = this.state.owner = rec;
    } else {
      person = this.#personOf(rec);
      if (!person) {
        // ⚠️ THE AUTO-LINK. A person already here whose VERIFIED email is one
        // this sign-in has just proved it holds is the same human: the new
        // identity joins them instead of becoming a second person.
        person = this.#byEmail(emails)[0];
      }
      if (!person) {
        // An invitation the owner typed has no id until now. First sign-in
        // CLAIMS that row rather than adding a second one — otherwise the
        // person appears in People twice, once for ever as "pending". Matched
        // by the login typed, or (the cross-provider case `mayEnter` admits
        // on) an invite typed as an email that this sign-in verifiably holds
        // — or, as before linking existed, whose GitHub public-profile email
        // it is.
        const pubEmail = user.email ? String(user.email).toLowerCase() : "";
        const claim =
          this.#pendingFor(rec.provider, rec.login) ||
          emails.map((e) => this.#pendingFor("google", e)).find(Boolean) ||
          (rec.provider === "github" && pubEmail ? this.#pendingFor("google", pubEmail) : undefined);
        if (claim) {
          person = claim.rec;
          // Invite lifecycle ("accepted"): stamped at the claim, before the
          // typed identity is overwritten by whoever actually signed in.
          if (!person.acceptedAt) person.acceptedAt = new Date(this.now()).toISOString();
        }
      }
      if (!person) {
        // Somebody the DOMAIN rule admitted lands here, and is recorded exactly
        // like anyone else. That is deliberate: `session()` re-checks the list
        // on every request, so a person admitted by rule and never written down
        // would be signed out again on their very next call.
        person = rec;
        this.state.allowed.push(rec);
      }
    }

    // Whichever way we got here, this identity is now one of the person's, the
    // addresses it proved are theirs, and anything else on the team that those
    // addresses prove to be the same human — a pending invite typed for one, a
    // second signed-in row — folds into them.
    person = this.#adopt(person, rec, emails, user.email ? String(user.email).toLowerCase() : "");
    if (rec.hd && !person.hd) person.hd = rec.hd;

    const p = { provider: person.provider, login: person.login, id: person.id };
    const token = randomBytes(SESSION_BYTES).toString("hex");
    const proof = proofEmails(user, rec);
    this.state.sessions[token] = { ...p, at: this.now(), ...(proof.length ? { proof: { provider: rec.provider, id: rec.id, emails: proof, at: this.now() } } : {}) };
    this.#sweep();
    this.#save();
    return { token, login: rec.display, owner: person === this.state.owner };
  }

  /** Every person record, owner first. The live objects, not copies. */
  #people() {
    return [this.state.owner, ...this.state.allowed].filter(Boolean);
  }

  /** The person who owns this identity (provider AND id), or undefined. */
  #personOf(ident) {
    return this.#people().find((r) => owns(r, ident));
  }

  /** A typed, never-claimed identity with this provider and login — on any
   *  person, primary or merged-in — as `{ rec }`. */
  #pendingFor(prov, login) {
    for (const r of this.#people()) {
      if (idents(r).some((i) => !i.id && i.provider === prov && i.login === login)) return { rec: r };
    }
    return undefined;
  }

  /** Signed-in people (they have at least one real identity) whose PROVEN
   *  emails include any of these. A typed invite is not proof of anything. */
  #byEmail(emails) {
    if (!emails.length) return [];
    return this.#people().filter((r) => idents(r).some((i) => i.id) && [...emailsOf(r)].some((e) => emails.includes(e)));
  }

  /**
   * Make `ident` (and the proven `emails`) part of `person`, then fold in
   * everyone else those addresses prove are the same human. Returns the
   * surviving record — the owner's, if the owner was among them.
   */
  #adopt(person, ident, emails, publicEmail = "") {
    const proof = new Set([...emails, ...(publicEmail && ident.provider === "github" ? [publicEmail] : [])]);
    const pending = (i) => !i.id && ((i.provider === ident.provider && i.login === ident.login) || (i.provider === "google" && proof.has(i.login)));
    // A pending identity this sign-in has just proved it holds stops being
    // pending: it is replaced by the real one, and an email address moves into
    // `emails` (that is what it always was).
    const dropped = idents(person).filter(pending);
    const kept = idents(person).filter((i) => !pending(i));
    const proven = uniqStrings([...emails, ...dropped.filter((i) => i.provider === "google" && emails.includes(i.login)).map((i) => i.login)]);
    const at = kept.find((i) => samePerson(i, ident));
    if (at) at.emails = uniqStrings([...(at.emails || []), ...proven]);
    else kept.push({ provider: ident.provider, login: ident.login, id: ident.id, display: ident.display, emails: proven });
    setIdents(person, kept);
    // Somebody whose primary came from a hand-typed invite never had a name of
    // their own worth keeping over the one they just signed in with.
    if (!person.named && dropped.length) person.display = ident.display;

    let keep = person;
    for (const other of this.#people()) {
      if (other === keep) continue;
      const otherPending = idents(other).every((i) => !i.id);
      const sameHuman = otherPending
        ? idents(other).some((i) => pending(i) || (i.provider === "google" && emailsOf(keep).has(i.login)))
        : [...emailsOf(other)].some((e) => emailsOf(keep).has(e));
      if (sameHuman) keep = this.#merge(keep, other);
    }
    return keep;
  }

  /**
   * Fold `gone` into `keep`: every identity, verified email, actor alias,
   * session, credential and pending invite key it had is re-pointed to `keep`
   * and its row disappears. If either was the owner, the survivor is.
   *
   * Events are not rewritten: an event names its actor as a string, and
   * `actorName` resolves every name the absorbed person ever used to the
   * survivor's, so the archive re-points itself without touching the log.
   */
  #merge(keep, gone) {
    if (keep === gone) return keep;
    if (gone === this.state.owner) [keep, gone] = [gone, keep];
    const old = [idents(keep)[0], idents(gone)[0]].map((i) => ({ provider: i.provider, login: i.login, id: i.id }));
    const goneLogins = idents(gone).map((i) => i.login);

    const keepWaiting = !keep.id;
    setIdents(keep, [...idents(keep), ...idents(gone)]);
    const aliases = uniqStrings([...(keep.aliases || []), ...(gone.aliases || []), gone.display, ...goneLogins]);
    if (aliases.length) keep.aliases = aliases;
    if (gone.named && !keep.named) {
      keep.display = gone.display;
      keep.named = true;
    }
    if (gone.hd && !keep.hd) keep.hd = gone.hd;
    // Two rows, one human: the LOWER role wins, so linking cannot be used to
    // climb out of a demotion. (The owner's record has none to change.)
    if (keep !== this.state.owner) keep.role = roleRank(validRole(gone.role)) < roleRank(validRole(keep.role)) ? validRole(gone.role) : validRole(keep.role);
    if (gone.added && (!keep.added || gone.added < keep.added)) keep.added = gone.added;
    // Only a person still waiting on their invite has a key worth keeping.
    if (keepWaiting && !keep.id && !keep.inviteKeyHash && gone.inviteKeyHash) {
      keep.inviteKeyHash = gone.inviteKeyHash;
      keep.inviteKeyExpires = gone.inviteKeyExpires;
    }
    if (keep.id) {
      delete keep.inviteKeyHash;
      delete keep.inviteKeyExpires;
    }

    this.state.allowed = this.state.allowed.filter((a) => a !== gone && a !== keep);
    if (this.state.owner === gone) this.state.owner = keep;
    if (this.state.owner !== keep) this.state.allowed.push(keep);

    this.#repoint(old, keep);
    for (const c of this.state.credentials) {
      if (goneLogins.includes(c.addedBy)) c.addedBy = keep.login;
    }
    return keep;
  }

  /** Sessions signed in under any of these primaries now belong to `rec`'s. */
  #repoint(olds, rec) {
    for (const s of Object.values(this.state.sessions)) {
      if (olds.some((o) => samePerson(o, s))) {
        s.provider = rec.provider;
        s.login = rec.login;
        s.id = rec.id;
      }
    }
  }

  /**
   * Is this a live session? Returns the session record or null.
   *
   * Touching `at` on every check is what makes the TTL an IDLE timeout rather
   * than an absolute one — a machine in daily use never signs itself out. The
   * write is throttled to once an hour per session because this runs on every
   * request, and persisting a timestamp on each one would rewrite the file
   * several times a second under a board that is polling.
   */
  session(token) {
    if (typeof token !== "string" || token.length !== SESSION_BYTES * 2) return null;
    // Constant-time lookup is not attempted and is not needed: the token is a
    // 32-byte random value with no structure to learn, and the map lookup
    // reveals only whether it exists, which the response reveals anyway.
    const s = this.state.sessions[token];
    if (!s) return null;

    const now = this.now();
    if (now - s.at > SESSION_TTL_MS) {
      delete this.state.sessions[token];
      this.#save();
      return null;
    }
    if (now - s.at > 60 * 60 * 1000) {
      s.at = now;
      this.#save();
    }
    // Revoking a login has to kill its live sessions, and the cheapest correct
    // place to enforce that is here rather than by hunting the session map.
    if (!this.#personOf(s)) {
      delete this.state.sessions[token];
      this.#save();
      return null;
    }
    return s;
  }

  /**
   * Add a login by hand — the owner inviting somebody who has not signed in
   * yet. There is no id until they do, so this record is login-keyed and gains
   * an id on first sign-in (in `signIn`, which claims it).
   *
   * Which provider it is for is decided by the "@": an email is a Google
   * identity, a bare name is a GitHub one. That is a judgement made from the
   * string rather than from a second argument or a dropdown, because the two
   * namespaces cannot overlap — GitHub usernames may not contain "@" — and one
   * text box is a better invite form than two.
   *
   * `email` is the recipient hub/server.mjs has resolved (or is about to try)
   * for this invite — passed in so a second invite that resolves to the SAME
   * address as an already-pending one is recognised as the one invitation,
   * not a second. Andrew: "i invited michael twice" — typing a bare GitHub
   * login one day and that person's email the next are two different
   * (provider, login) pairs and, without this, two separate pending rows for
   * one person. Matching on the resolved email is the one cross-identifier
   * check this file makes for a still-pending invite; it does not attempt to
   * merge an already-CLAIMED member with a new identifier — that is the
   * multi-identity/persons work elsewhere on this file, not this.
   */
  allow(login, { email = "" } = {}) {
    const v = invitableLogin(login);
    if (!v.ok) return v;
    const { typed, login: l, provider: p } = v;
    // A bare email invite IS its own recipient — no caller has to pass
    // `email` separately for the common case of inviting an address directly.
    const mail = String(email || (p === "google" ? l : "") || "").trim().toLowerCase();

    const existing = this.list().find((a) => provider(a) === p && a.login === l);
    if (existing) {
      // Already an active member (owner, or claimed by a real sign-in): there
      // is nothing pending to key, and re-typing their name is a no-op.
      if (existing.id) return { ok: true, already: true, login: l };
      // Still pending: re-inviting ROTATES the key rather than handing back
      // the one already emailed, in case that email never arrived. Also
      // learns the recipient if this resend is the first time one was
      // resolved, so a LATER invite typed under a different identifier can
      // still find this row by email.
      if (mail && !existing.email) {
        existing.email = mail;
        this.#save();
      }
      return { ok: true, already: true, key: this.inviteKey(l), login: l };
    }

    if (mail) {
      const byEmail = this.state.allowed.find((a) => !a.id && a.email === mail);
      if (byEmail) return { ok: true, already: true, key: this.inviteKey(byEmail.login), login: byEmail.login };
    }

    // Inviting somebody UN-BLOCKS them. The owner typing a name is the owner
    // saying yes, and a block left behind would make this button silently do
    // nothing — the worst shape a permission bug can take.
    this.state.blocked = this.state.blocked.filter((b) => !(provider(b) === p && b.login === l));
    this.state.allowed.push({ provider: p, login: l, display: typed, id: "", email: mail, added: new Date(this.now()).toISOString() });
    this.#save();
    return { ok: true, already: false, key: this.inviteKey(l), login: l };
  }

  /**
   * Record what happened when hub/server.mjs tried to email a still-pending
   * invite — persisted on the row so every later `/auth/whoami` poll shows it,
   * not only the one HTTP response right after Invite/Resend was clicked. A
   * no-op for a login with no pending row (already claimed, revoked, or never
   * invited): there is nothing left to attach this to.
   */
  recordInviteEmail(login, { sent, error = "" } = {}) {
    const l = String(login || "").trim().replace(/^@/, "").toLowerCase();
    const entry = this.state.allowed.find((a) => a.login === l && !a.id);
    if (!entry) return;
    entry.emailSent = Boolean(sent);
    entry.emailSentAt = new Date(this.now()).toISOString();
    entry.emailError = sent ? "" : String(error || "");
    this.#save();
  }

  /**
   * The most recent activity timestamp (epoch ms) across every session this
   * login holds, or 0 if it holds none — never signed in from a device, or
   * its session aged out (`#sweep`/`session()`'s own TTL). This is the hub's
   * existing per-device signal for "actually connected", reused rather than
   * added to: `session()` bumps a session's `at` on every authenticated
   * request that device makes, so it is a live heartbeat, not just the
   * moment an invite was claimed.
   */
  lastSeen(login) {
    const l = String(login || "").trim().replace(/^@/, "").toLowerCase();
    let latest = 0;
    for (const s of Object.values(this.state.sessions)) {
      if (s.login === l && s.at > latest) latest = s.at;
    }
    return latest;
  }

  /**
   * Remember that this person's machine just reported an event (`kind` "event":
   * a hook POST was accepted) or their board just read the hub (`kind` "board").
   * Diagnosis for the owner: a teammate whose events never arrive is otherwise
   * indistinguishable from one who is not working. Kept in memory and written
   * at most every 30s — a request-rate write would rewrite accounts.json
   * several times a second; a crash loses seconds of a timestamp, not an account.
   */
  noteSeen(session, kind, info = {}) {
    const r = this.#personOf(session);
    if (!r) return;
    const now = this.now();
    const p = (this.state.presence[r.login] ||= {});
    p[kind === "event" ? "eventAt" : "boardAt"] = now;
    if (kind === "event") {
      if (info.machine) p.machine = info.machine;
      if (info.build) p.build = info.build;
    }
    if (!this.savedPresenceAt || now - this.savedPresenceAt > 30000) {
      this.savedPresenceAt = now;
      this.#save();
    }
  }

  /** `{ eventAt, boardAt, machine, build }` — each null/"" when never seen. */
  presenceOf(login) {
    const p = this.state.presence[String(login || "").toLowerCase()] || {};
    return { eventAt: p.eventAt || null, boardAt: p.boardAt || null, machine: p.machine || "", build: p.build || "" };
  }

  /**
   * Mint (or rotate) a one-time invite key for a still-pending allowlist
   * entry. Returns the plaintext key — the ONLY moment it ever exists outside
   * the inviter's clipboard/inbox — or null if `login` names no pending
   * invite (unknown, already claimed, or the owner).
   *
   * Only the hash and an expiry are persisted; see `redeem` for the other
   * half of that contract.
   */
  inviteKey(login) {
    const l = String(login || "").trim().replace(/^@/, "").toLowerCase();
    const entry = this.state.allowed.find((a) => a.login === l && !a.id);
    if (!entry) return null;
    const key = randomInviteKey();
    entry.inviteKeyHash = hashInviteKey(key);
    entry.inviteKeyExpires = this.now() + INVITE_KEY_TTL_MS;
    this.#save();
    return key;
  }

  /**
   * Redeem an invite key: mints a session exactly as a successful sign-in
   * does (via `signIn`, below), marks the invitee active, and consumes the
   * key — one-time use, whether or not it was expired.
   *
   * The key is deleted from the entry BEFORE `signIn` is called, so a key can
   * be redeemed at most once even if something below it ever throws.
   */
  redeem(key) {
    const norm = String(key || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (norm.length !== 8) return { ok: false, error: "bad key" };
    const hash = hashInviteKey(norm);
    const entry = this.state.allowed.find((a) => a.inviteKeyHash === hash);
    if (!entry) return { ok: false, error: "bad key" };

    const expired = !entry.inviteKeyExpires || entry.inviteKeyExpires < this.now();
    delete entry.inviteKeyHash;
    delete entry.inviteKeyExpires;
    if (expired) {
      this.#save();
      return { ok: false, error: "bad key" };
    }

    // `entry.id` is "" (still pending) — signIn claims this exact row, exactly
    // as a GitHub/Google sign-in claiming a typed invite would, except the
    // identity it claims it under is synthetic: nobody proved who they are to
    // a provider, only that they held the key.
    // ponytail: a real OAuth sign-in later, under the SAME login, will not
    // re-claim this row (its id no longer matches) and lands as a second
    // entry instead of merging — same edge case `signIn`'s own comment
    // already flags for the cross-provider email case; upgrade if it bites.
    const rec = this.signIn({
      provider: provider(entry),
      login: entry.login,
      id: `key-${randomBytes(6).toString("hex")}`,
      display: entry.display,
    });
    return { ok: true, token: rec.token, login: rec.login, owner: rec.owner };
  }

  /** Remove somebody. The owner cannot be removed — a hub with no owner has
   *  nobody who can add anyone, and the only repair is ssh. */
  revoke(login) {
    const l = String(login || "").trim().replace(/^@/, "").toLowerCase();
    if (this.state.owner && idents(this.state.owner).some((i) => i.login === l)) {
      return { ok: false, error: "the owner cannot be removed" };
    }
    // Matched across providers on the login alone, which is unambiguous because
    // the two namespaces are disjoint: only one of them can contain an "@". Any
    // identity a person has linked names them, and removing one removes ALL.
    const named = (a) => idents(a).some((i) => i.login === l);
    const going = this.state.allowed.filter(named);
    this.state.allowed = this.state.allowed.filter((a) => !named(a));

    /* ⚠️ DELETION ALONE DOES NOT REVOKE ANYBODY ON THE WORKSPACE DOMAIN. They
     * were admitted by a RULE, not by this list, so removing their row just
     * means the rule re-adds it the next time they sign in — a revoke button
     * that reports success and changes nothing. The block list is what says no,
     * and `mayEnter` consults it before the domain door.
     *
     * For somebody who should be gone for good the real revocation is still in
     * Google Workspace — suspend the account and every hub stops trusting them.
     * This is for the case where they should keep the Google account and lose
     * zevet. */
    for (const a of going) {
      for (const i of idents(a)) {
        if (i.id && !this.state.blocked.some((b) => samePerson(b, i))) {
          this.state.blocked.push({ provider: i.provider, login: i.login, id: i.id, at: new Date(this.now()).toISOString() });
        }
      }
    }

    for (const [tok, s] of Object.entries(this.state.sessions)) {
      if (going.some((a) => owns(a, s))) delete this.state.sessions[tok];
    }
    this.#save();
    return { ok: true, removed: going.length > 0 };
  }

  /** The person a session (or any {provider, login, id}) belongs to, as a
   *  read-only view for a response: every identity they have linked and the
   *  names events may use for them. Never their email addresses. */
  profile(ref) {
    const r = ref && ref.id ? this.#personOf(ref) : this.#people().find((x) => idents(x).some((i) => i.login === String((ref && ref.login) || "").toLowerCase()));
    if (!r) return null;
    return {
      name: r.display || r.login,
      login: r.login,
      owner: r === this.state.owner,
      identities: idents(r).filter((i) => i.id).map((i) => ({ provider: i.provider, login: i.login })),
      aliases: r.aliases || [],
    };
  }

  /**
   * Prove-and-add: `session` is who is signed in, `ident` is a SECOND identity
   * that has just signed in through its own provider (the caller has already
   * verified that with the provider — a typed address never reaches here).
   * The identity joins the caller's person. If it was already somebody else's
   * row, the caller has proved they control both, so the two become one.
   */
  link(session, ident, emails = []) {
    const me = this.#personOf(session);
    if (!me) return { ok: false, error: "not signed in" };
    const id = { provider: provider(ident), login: String(ident.login || "").toLowerCase(), id: String(ident.id || ""), display: String(ident.display || ident.login) };
    if (!id.login || !id.id) return { ok: false, error: "that account did not say who it is" };
    if (this.#blocked(id)) return { ok: false, error: `${display(id)} was removed from this team` };
    if (owns(me, id)) return { ok: true, already: true };
    const other = this.#personOf(id);
    let keep = me;
    if (other) keep = this.#merge(me, other);
    keep = this.#adopt(keep, id, verifiedEmails({ emails }));
    this.#save();
    return { ok: true, merged: Boolean(other), person: this.profile(keep) };
  }

  /** Take one identity off a person. Never their last real one — that would
   *  be signing yourself out of the team. Returns `{ ok }`. */
  unlink(session, target) {
    const me = this.#personOf(session);
    if (!me) return { ok: false, error: "not signed in" };
    const want = { provider: provider(target), login: String((target && target.login) || "").toLowerCase() };
    const all = idents(me);
    const real = all.filter((i) => i.id);
    const gone = real.find((i) => i.provider === want.provider && i.login === want.login);
    if (!gone) return { ok: false, error: "that account is not linked to you" };
    if (real.length < 2) return { ok: false, error: "that is your only sign-in — link another one first" };
    const old = { provider: me.provider, login: me.login, id: me.id };
    setIdents(me, all.filter((i) => i !== gone && !(i.provider === gone.provider && i.id === gone.id)));
    if (me.login !== old.login) this.#repoint([old], me);
    // The address it was known by stays a name events can use, not a proof.
    me.aliases = uniqStrings([...(me.aliases || []), gone.login]);
    this.#save();
    return { ok: true, person: this.profile(me) };
  }

  /**
   * Change somebody's display name. WHO MAY is the caller's decision (yourself,
   * or the owner for anyone); this only refuses a name that would make two
   * people indistinguishable. The old name and the actor string the caller's
   * machine reports become aliases, so the events already on the board follow
   * the new name instead of being orphaned under the old one.
   */
  rename(login, name, { actor = "" } = {}) {
    const r = this.#people().find((x) => idents(x).some((i) => i.login === String(login || "").toLowerCase().replace(/^@/, "")));
    if (!r) return { ok: false, error: "no such person" };
    const next = cleanName(name);
    if (!next) return { ok: false, error: "a name cannot be empty" };
    const clash = this.#claimedBy(next);
    if (clash && clash !== r) return { ok: false, error: `${next} is already somebody else's name` };
    const was = r.display;
    r.display = next;
    r.named = true;
    const a = cleanName(actor);
    const keep = [...(r.aliases || []), was, ...(a && !(this.#claimedBy(a) && this.#claimedBy(a) !== r) ? [a] : [])].filter((x) => x && x.toLowerCase() !== next.toLowerCase());
    r.aliases = uniqStrings(keep);
    if (!r.aliases.length) delete r.aliases;
    this.#save();
    return { ok: true, person: this.profile(r) };
  }

  /** The signed-in person whose PROVEN emails include `email`, as a session-shaped ref ({provider, login, id}) that
   *  `can`, `profile` and `namesOfSession` accept, or null. Creates and stores nothing (Masora's Forum acts as a person
   *  without opening a session for every request). */
  refByEmail(email) {
    const r = this.#byEmail([String(email || "").trim().toLowerCase()])[0];
    const i = r && idents(r).find((x) => x.id);
    return i ? { provider: i.provider, login: i.login, id: i.id } : null;
  }

  /** `{emails, logins}` of the ONE person a board actor name belongs to; null when nobody, or more than one, goes by it. */
  identityOfName(name) {
    const n = String(name || "").toLowerCase().replace(/^@/, "");
    const hits = this.#people().filter((r) => this.#namesOf(r).includes(n));
    return hits.length === 1 ? { emails: [...emailsOf(hits[0])], logins: idents(hits[0]).map((i) => i.login) } : null;
  }

  /** The one person a name (display, any login, any alias) belongs to. */
  #claimedBy(name) {
    const n = String(name).toLowerCase().replace(/^@/, "");
    return this.#people().find((r) => this.#namesOf(r).includes(n));
  }

  #namesOf(r) {
    return [r.display, ...idents(r).map((i) => i.login), ...(r.aliases || [])].filter(Boolean).map((x) => String(x).toLowerCase().replace(/^@/, ""));
  }

  /**
   * OWNER-ONLY at the route: fold one person into another when the evidence
   * rule cannot prove it (`andrew` and `@AndrewDoft`). `from` is a login or
   * display name of a person — or, failing that, an actor name that only
   * appears on events, which is then simply claimed as an alias.
   */
  combine(intoLogin, from) {
    const find = (x) => {
      const n = String(x || "").trim().toLowerCase().replace(/^@/, "");
      return n ? this.#people().find((r) => idents(r).some((i) => i.login === n) || (r.display || "").toLowerCase() === n) : undefined;
    };
    const into = find(intoLogin);
    if (!into) return { ok: false, error: "no such person to combine into" };
    const src = find(from);
    if (src === into) return { ok: true, already: true };
    if (src) {
      this.#merge(into, src);
      this.#save();
      return { ok: true, merged: true };
    }
    const actor = cleanName(from);
    if (!actor) return { ok: false, error: "nothing to combine" };
    const clash = this.#claimedBy(actor);
    if (clash && clash !== into) return { ok: false, error: `${actor} already belongs to somebody else` };
    into.aliases = uniqStrings([...(into.aliases || []), actor]);
    this.#save();
    return { ok: true, merged: false, alias: actor };
  }

  /**
   * Merge every pair of people the STORED evidence proves are one human, and
   * say what was merged and why. The evidence is exactly what sign-in uses:
   * two signed-in people who share a verified email; a typed invite whose
   * address is a signed-in person's verified one, or whose login is one of
   * their own. Typing a name is never proof, so "andrew" + "@AndrewDoft" is not
   * found here — that is `combine`, the owner's call. Idempotent: a second run
   * finds nothing.
   */
  mergeProvable() {
    const done = [];
    for (let again = true; again; ) {
      again = false;
      const people = this.#people();
      for (const a of people) {
        for (const b of people) {
          const why = a === b ? "" : this.#provablySame(a, b);
          if (!why) continue;
          const keep = this.#merge(a, b);
          done.push({ kept: keep.login, absorbed: (keep === a ? b : a).login, why });
          again = true;
          break;
        }
        if (again) break;
      }
    }
    if (done.length) this.#save();
    return done;
  }

  #provablySame(a, b) {
    const real = (r) => idents(r).some((i) => i.id);
    const ea = emailsOf(a);
    if (real(a) && real(b)) {
      const shared = [...emailsOf(b)].find((e) => ea.has(e));
      return shared ? `both hold the verified email ${shared}` : "";
    }
    if (real(a) && !real(b)) {
      for (const i of idents(b)) {
        if (idents(a).some((x) => x.id && x.provider === i.provider && x.login === i.login)) return `a pending invite for ${i.login}, who has signed in`;
        if (i.provider === "google" && ea.has(i.login)) return `a pending invite for ${i.login}, a verified email of a signed-in person`;
      }
    }
    return "";
  }

  /**
   * Operator-declared proof (ZEVET_IDENTITY_LINKS): `who` (any login, name or
   * alias of a member) holds the verified `email` — typically a GitHub-owner row
   * that never carried one, so Masora's sign-in of the same human could not
   * bind to it. Records the email, folds whoever it now provably duplicates
   * (`mergeProvable`), and optionally sets the display name. Idempotent: a
   * second run changes nothing and returns [].
   */
  linkEmail(who, email, display = "") {
    const n = String(who || "").trim().toLowerCase().replace(/^@/, "");
    const e = String(email || "").trim().toLowerCase();
    const r = this.#people().find((x) => idents(x).some((i) => i.id) && this.#namesOf(x).includes(n));
    if (!r || !e) return [];
    const done = [];
    if (!emailsOf(r).has(e)) {
      const list = idents(r);
      const i = list.find((x) => x.id);
      i.emails = uniqStrings([...(i.emails || []), e]);
      setIdents(r, list);
      this.#save();
      done.push(`${r.login} now holds ${e}`);
    }
    for (const m of this.mergeProvable()) done.push(`${m.absorbed} merged into ${m.kept} (${m.why})`);
    const keep = this.#people().find((x) => emailsOf(x).has(e));
    if (keep && display && keep.display !== display && [undefined, keep].includes(this.#claimedBy(display))) {
      this.rename(keep.login, display);
      done.push(`${keep.login} is shown as ${display}`);
    }
    return done;
  }

  /**
   * Resolve the name an event was recorded under (a machine's `actor` string)
   * to the person's CURRENT display name — so a rename, a linked identity and
   * a merge all show up on events already in the log, without rewriting it.
   * A name two people both claim is left alone rather than guessed.
   */
  actorResolver() {
    const by = new Map();
    for (const r of this.#people()) {
      for (const n of new Set(this.#namesOf(r))) by.set(n, by.has(n) && by.get(n) !== r ? null : r);
    }
    return (actor) => {
      const r = by.get(String(actor || "").toLowerCase().replace(/^@/, ""));
      return r && r.display ? r.display : actor;
    };
  }

  /**
   * End one session — somebody signing THEMSELVES out. No owner check, on
   * purpose: leaving must never require permission, and it removes nothing
   * but this session. Ownership, the allowlist and everyone else's sessions
   * are untouched, so an owner who disconnects stays the owner and can sign
   * straight back in. Returns whether there was a session to end.
   */
  logout(token) {
    if (typeof token !== "string" || !this.state.sessions[token]) return { ok: true, loggedOut: false };
    delete this.state.sessions[token];
    this.#save();
    return { ok: true, loggedOut: true };
  }

  #sweep() {
    const now = this.now();
    for (const [tok, s] of Object.entries(this.state.sessions)) {
      if (now - s.at > SESSION_TTL_MS) delete this.state.sessions[tok];
    }
  }

  #load() {
    if (!this.file) return EMPTY();
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      // ⚠️ THE WHOLE GOOGLE MIGRATION IS THIS ONE LINE APPLIED EVERYWHERE. A
      // file written before Google existed holds untagged records; they are
      // GitHub's, and tagging them on the way in means no comparison further
      // down ever has to cope with an absent provider.
      const tag = (r) => ({ ...r, provider: provider(r) });

      const sessions = {};
      const rawSessions = raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {};
      for (const [tok, s] of Object.entries(rawSessions)) if (s && typeof s === "object") sessions[tok] = tag(s);

      return {
        version: 1,
        secret: typeof raw.secret === "string" ? raw.secret : "",
        name: typeof raw.name === "string" ? raw.name : "",
        domain: typeof raw.domain === "string" ? raw.domain : "",
        masoraWorkspace: typeof raw.masoraWorkspace === "string" ? raw.masoraWorkspace : "",
        owner: raw.owner && raw.owner.login ? tag(raw.owner) : null,
        // Pre-roles members have no `role`: they load as Editor (the owner needs none).
        allowed: Array.isArray(raw.allowed) ? raw.allowed.filter((a) => a && a.login).map((a) => ({ ...tag(a), role: validRole(a.role) })) : [],
        // A block with no id blocks nobody — `samePerson` needs one — so a
        // malformed entry is dropped rather than kept as a row that silently
        // never matches.
        blocked: Array.isArray(raw.blocked) ? raw.blocked.filter((b) => b && b.login && b.id).map(tag) : [],
        sessions,
        presence: raw.presence && typeof raw.presence === "object" && !Array.isArray(raw.presence) ? raw.presence : {},
        createdAt: typeof raw.createdAt === "number" ? raw.createdAt : null,
        // A malformed entry (no id or no key) is dropped rather than kept as
        // a row that can never be fetched or deleted by id.
        credentials: Array.isArray(raw.credentials)
          ? raw.credentials.filter((c) => c && c.id && c.key).map((c) => ({ ...c }))
          : [],
        // Only known keys with allowed values survive a load: a hand-edited
        // file cannot smuggle in a policy value the route would have refused.
        policy: Object.fromEntries(
          Object.entries(raw.policy && typeof raw.policy === "object" ? raw.policy : {}).filter(([k, v]) => Object.hasOwn(POLICY_VALUES, k) && POLICY_VALUES[k].includes(v)),
        ),
        audit: Array.isArray(raw.audit) ? raw.audit.filter((a) => a && typeof a === "object").slice(-AUDIT_MAX) : [],
      };
    } catch (err) {
      // ⚠️ A CORRUPT FILE IS NOT SILENTLY REPLACED. Starting empty would mean
      // a new master secret, which orphans every encrypted document the team
      // has, and a vacant owner slot on a hub anyone can then claim. Refusing
      // to start is the loud failure; a human restores the file.
      if (err.code !== "ENOENT") {
        throw new Error(`zevet: ${this.file} exists but could not be read (${err.message}). Refusing to start rather than issue a new secret and orphan every encrypted document.`);
      }
      return EMPTY();
    }
  }

  #save() {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    // Write-then-rename. A hub killed mid-write would otherwise leave truncated
    // JSON, which by the rule above is a hub that refuses to start.
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/**
 * Validate and normalise a typed invite identifier, without touching any
 * state. Exported (not just inlined in `allow`) because hub/server.mjs needs
 * to know the (provider, login) it resolved to BEFORE deciding whether an
 * async lookup — a GitHub public-email fetch, to find somewhere to mail the
 * invite — is even worth making; `allow` itself calls this too, so the two
 * can never validate a login differently.
 */
export function invitableLogin(login) {
  const typed = String(login || "").trim().replace(/^@/, "");
  const l = typed.toLowerCase();
  const p = l.includes("@") ? "google" : "github";
  if (p === "google") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l)) return { ok: false, error: "that is not an email address" };
  } else if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(l)) {
    return { ok: false, error: "that is not a GitHub username or an email address" };
  }
  return { ok: true, typed, login: l, provider: p };
}

/** The default location, exported so server.mjs and the tests agree on it. */
export function defaultAccountsFile(hubDir) {
  return process.env.ZEVET_ACCOUNTS || path.join(hubDir, "..", "var", "accounts.json");
}

/** Whether a stored hub file exists yet — used only to decide whether the
 *  startup banner should say "nobody has claimed this hub". */
export function accountsFileExists(file) {
  try {
    return existsSync(file);
  } catch {
    return false;
  }
}

/** Re-exported so server.mjs does not import crypto twice for one comparison. */
export function sameSecret(a, b) {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** The auth token a client derives from the master secret. Duplicated from
 *  client/secret.mjs's `deriveAuthToken` ON PURPOSE: the hub is a separate
 *  deployable that must not import out of `client/`, which is a directory it
 *  SERVES to other machines over the update channel. Both are eleven lines and
 *  test/secret.test.mjs asserts they agree. */
export function deriveAuthToken(masterSecret) {
  return createHash("sha256")
    .update(Buffer.from("zevet-auth\0", "utf8"))
    .update(Buffer.from(String(masterSecret), "hex"))
    .digest("hex");
}
