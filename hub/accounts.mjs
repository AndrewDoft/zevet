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

const EMPTY = () => ({ version: 1, secret: "", owner: null, allowed: [], sessions: {} });

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
  }

  /** The master secret. Handed to a client only after it has proved who it is,
   *  and never logged — every caller is expected to keep it out of a log line. */
  get secret() {
    return this.state.secret;
  }

  /** The login that set this hub up, or null if nobody has yet. */
  get owner() {
    return this.state.owner ? this.state.owner.login : null;
  }

  /** Everyone permitted, owner first. */
  list() {
    const out = this.state.owner ? [{ ...this.state.owner, owner: true }] : [];
    for (const a of this.state.allowed) out.push({ ...a, owner: false });
    return out;
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
  mayEnter(user, { requiredOwner = "" } = {}) {
    const login = String(user.login || "").toLowerCase();
    const id = String(user.id || "");
    if (!login || !id) return { ok: false, error: "GitHub did not say who you are" };

    if (!this.state.owner) {
      const want = String(requiredOwner || "").trim().toLowerCase();
      if (want && want !== login) {
        return { ok: false, error: `this hub is reserved for @${want}` };
      }
      return { ok: true, first: true };
    }

    // The id is what is checked when both sides have one. A login is renameable
    // and, once renamed, claimable by a stranger — an allowlist keyed on the
    // string alone is an allowlist that can be inherited.
    for (const a of this.list()) {
      if (a.id && id && a.id === id) return { ok: true, first: false };
      if (!a.id && a.login === login) return { ok: true, first: false };
    }
    return { ok: false, error: `@${user.login} is not on this hub's list — ask @${this.owner} to add you` };
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
      login: String(user.login).toLowerCase(),
      display: String(user.login),
      id: String(user.id),
      added: new Date(this.now()).toISOString(),
    };

    if (!this.state.owner) this.state.owner = rec;
    else if (!this.list().some((a) => a.id === rec.id)) this.state.allowed.push(rec);

    const token = randomBytes(SESSION_BYTES).toString("hex");
    this.state.sessions[token] = { login: rec.login, id: rec.id, at: this.now() };
    this.#sweep();
    this.#save();
    return { token, login: rec.display, owner: this.state.owner.id === rec.id };
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
    if (!this.list().some((a) => a.id === s.id)) {
      delete this.state.sessions[token];
      this.#save();
      return null;
    }
    return s;
  }

  /** Add a login by hand — the owner inviting somebody who has not signed in
   *  yet. There is no id until they do, so this record is login-keyed and gains
   *  an id on first sign-in. */
  allow(login) {
    const l = String(login || "").trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(l)) {
      return { ok: false, error: "that is not a GitHub username" };
    }
    if (this.list().some((a) => a.login === l)) return { ok: true, already: true };
    this.state.allowed.push({ login: l, display: login.replace(/^@/, ""), id: "", added: new Date(this.now()).toISOString() });
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
    const before = this.state.allowed.length;
    this.state.allowed = this.state.allowed.filter((a) => a.login !== l);
    for (const [tok, s] of Object.entries(this.state.sessions)) {
      if (s.login === l) delete this.state.sessions[tok];
    }
    this.#save();
    return { ok: true, removed: before !== this.state.allowed.length };
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
      return {
        version: 1,
        secret: typeof raw.secret === "string" ? raw.secret : "",
        owner: raw.owner && raw.owner.login ? raw.owner : null,
        allowed: Array.isArray(raw.allowed) ? raw.allowed.filter((a) => a && a.login) : [],
        sessions: raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {},
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
