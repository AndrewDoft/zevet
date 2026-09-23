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

const EMPTY = () => ({ version: 1, secret: "", owner: null, allowed: [], blocked: [], sessions: {}, createdAt: null });

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
  return provider(rec) === "google" ? l : `@${l}`;
}

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

  /** The login that set this hub up, or null if nobody has yet. */
  get owner() {
    return this.state.owner ? this.state.owner.login : null;
  }

  /** Everyone permitted, owner first. `provider` is normalised on the way out
   *  so no caller has to know about the pre-Google default. */
  list() {
    const out = this.state.owner ? [{ ...this.state.owner, provider: provider(this.state.owner), owner: true }] : [];
    for (const a of this.state.allowed) out.push({ ...a, provider: provider(a), owner: false });
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
  mayEnter(user, { requiredOwner = "", domain = "" } = {}) {
    const me = { provider: provider(user), login: String(user.login || "").toLowerCase(), id: String(user.id || "") };
    if (!me.login || !me.id) return { ok: false, error: `${me.provider === "google" ? "Google" : "GitHub"} did not say who you are` };

    // ⚠️ CHECKED BEFORE EVERYTHING, INCLUDING TRUST-ON-FIRST-USE. A revoked
    // person must not be able to claim an unowned hub, and must not be let back
    // in by the domain rule at the bottom.
    if (this.#blocked(me)) return { ok: false, error: `${display(me)} was removed from this hub` };

    if (!this.state.owner) {
      const want = String(requiredOwner || "").trim().toLowerCase().replace(/^@/, "");
      if (want && want !== me.login) {
        return { ok: false, error: `this hub is reserved for ${display({ ...me, login: want })}` };
      }
      return { ok: true, first: true };
    }

    // The id is what is checked when both sides have one. A login is renameable
    // and, once renamed, claimable by a stranger — an allowlist keyed on the
    // string alone is an allowlist that can be inherited.
    for (const a of this.list()) {
      if (samePerson(a, me)) return { ok: true, first: false };
      // An invitation the owner typed has no id until its first sign-in, so it
      // can only be matched by login — within its own provider, because
      // "andrew" on GitHub and "andrew@…" on Google are different people and a
      // cross-provider login match would be a way to inherit someone's seat.
      if (!a.id && provider(a) === me.provider && a.login === me.login) return { ok: true, first: false };
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

    // `display(this.state.owner)`, not `this.owner` — the latter is the bare
    // login, and printing it raw drops the "@" that every other mention of a
    // GitHub user in this file carries.
    return { ok: false, error: `${display(me)} is not on this hub's list — ask ${display(this.state.owner)} to add you` };
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
    };

    if (!this.state.owner) {
      this.state.owner = rec;
    } else {
      // An invitation the owner typed has no id until now. First sign-in CLAIMS
      // that row rather than adding a second one — otherwise the person appears
      // in People twice, once for ever as "pending", which is what this did
      // before Google arrived and `allow`'s own comment already promised it did
      // not.
      const invited = this.state.allowed.find((a) => !a.id && provider(a) === rec.provider && a.login === rec.login);
      if (invited) {
        invited.id = rec.id;
        invited.display = rec.display;
      } else if (!this.list().some((a) => samePerson(a, rec))) {
        // Somebody the DOMAIN rule admitted lands here, and is recorded exactly
        // like anyone else. That is deliberate: `session()` re-checks the list
        // on every request, so a person admitted by rule and never written down
        // would be signed out again on their very next call.
        this.state.allowed.push(rec);
      }
    }

    const token = randomBytes(SESSION_BYTES).toString("hex");
    this.state.sessions[token] = { provider: rec.provider, login: rec.login, id: rec.id, at: this.now() };
    this.#sweep();
    this.#save();
    return { token, login: rec.display, owner: samePerson(this.state.owner, rec) };
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
    if (!this.list().some((a) => samePerson(a, s))) {
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
   */
  allow(login) {
    const typed = String(login || "").trim().replace(/^@/, "");
    const l = typed.toLowerCase();
    const p = l.includes("@") ? "google" : "github";

    if (p === "google") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l)) return { ok: false, error: "that is not an email address" };
    } else if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(l)) {
      return { ok: false, error: "that is not a GitHub username or an email address" };
    }

    if (this.list().some((a) => provider(a) === p && a.login === l)) return { ok: true, already: true };
    // Inviting somebody UN-BLOCKS them. The owner typing a name is the owner
    // saying yes, and a block left behind would make this button silently do
    // nothing — the worst shape a permission bug can take.
    this.state.blocked = this.state.blocked.filter((b) => !(provider(b) === p && b.login === l));
    this.state.allowed.push({ provider: p, login: l, display: typed, id: "", added: new Date(this.now()).toISOString() });
    this.#save();
    return { ok: true, already: false };
  }

  /** Remove somebody. The owner cannot be removed — a hub with no owner has
   *  nobody who can add anyone, and the only repair is ssh. */
  revoke(login) {
    const l = String(login || "").trim().replace(/^@/, "").toLowerCase();
    if (this.state.owner && this.state.owner.login === l) {
      return { ok: false, error: "the owner cannot be removed" };
    }
    // Matched across providers on the login alone, which is unambiguous because
    // the two namespaces are disjoint: only one of them can contain an "@".
    const going = this.state.allowed.filter((a) => a.login === l);
    this.state.allowed = this.state.allowed.filter((a) => a.login !== l);

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
      if (a.id && !this.state.blocked.some((b) => samePerson(b, a))) {
        this.state.blocked.push({ provider: provider(a), login: a.login, id: a.id, at: new Date(this.now()).toISOString() });
      }
    }

    for (const [tok, s] of Object.entries(this.state.sessions)) {
      if (s.login === l) delete this.state.sessions[tok];
    }
    this.#save();
    return { ok: true, removed: going.length > 0 };
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
        owner: raw.owner && raw.owner.login ? tag(raw.owner) : null,
        allowed: Array.isArray(raw.allowed) ? raw.allowed.filter((a) => a && a.login).map(tag) : [],
        // A block with no id blocks nobody — `samePerson` needs one — so a
        // malformed entry is dropped rather than kept as a row that silently
        // never matches.
        blocked: Array.isArray(raw.blocked) ? raw.blocked.filter((b) => b && b.login && b.id).map(tag) : [],
        sessions,
        createdAt: typeof raw.createdAt === "number" ? raw.createdAt : null,
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
