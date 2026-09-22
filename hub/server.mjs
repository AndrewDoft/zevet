// zevet hub — the one process the three of us point at.
//
// Zero dependencies on purpose. Every teammate has to run or reach this, on
// Windows and macOS alike, and "npm install failed on my machine" is exactly
// the class of problem this tool exists to make visible rather than to cause.
// Server-Sent Events carry the live feed: the dashboard only ever listens, so
// a full duplex socket would buy nothing and cost a dependency. Editors sharing
// a document are the other case — that traffic really is duplex, so there is a
// WebSocket at /ws, written out by hand at the bottom of this file rather than
// installed. The same rule bought the same way twice.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Accounts, defaultAccountsFile, deriveAuthToken } from "./accounts.mjs";
import { deviceStart, devicePoll, githubUser } from "./github-auth.mjs";
import { authorizeUrl, exchangeCode, readIdToken } from "./google-auth.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);

/* ── Who this hub lets in ────────────────────────────────────────────────────
 *
 * Two credentials are accepted, and that is a migration, not a design:
 *
 *   • A GITHUB SESSION. Sign in, the hub checks its list, it mints a session.
 *     This is how everybody should arrive.
 *   • THE SHARED TOKEN, derived from the master secret. Every install in the
 *     field today presents this, and the hooks (`client/hook.mjs`) have no
 *     browser to sign in with and may never get one.
 *
 * The second is not deprecated — a headless hook is a real case — but it is no
 * longer how a PERSON is expected to get in.
 *
 * ⚠️ `ZEVET_GITHUB_CLIENT_ID` is the OAuth app's client id, and it is NOT a
 * secret: device flow has no client secret at all, which is exactly why it is
 * the flow a desktop app may use (hub/github-auth.mjs). Leaving it unset does
 * not break the hub; it turns GitHub sign-in off and leaves the shared token as
 * the only way in. */
const GITHUB_CLIENT_ID = process.env.ZEVET_GITHUB_CLIENT_ID || "";
const GITHUB_OWNER = process.env.ZEVET_GITHUB_OWNER || "";

/* ── Google Workspace sign-in ────────────────────────────────────────────────
 *
 * The other door, and it is shaped differently on purpose: GitHub admits people
 * from a LIST this hub keeps, Google admits anyone whose account is
 * administered by `ZEVET_GOOGLE_DOMAIN`. That hands "who works here" to the
 * Workspace admin, which is where that question is actually answered and kept
 * up to date — somebody who leaves loses their Google account and stops being
 * able to sign in, with nobody here having to remember anything.
 *
 * ⚠️ `ZEVET_GOOGLE_CLIENT_SECRET` IS A REAL SECRET, unlike its GitHub
 * counterpart. It lives in `/srv/zevet/.env` at mode 600 and nowhere else; it
 * is never served, never logged and never sent to a client.
 *
 * ⚠️ `ZEVET_GOOGLE_REDIRECT` MUST BE BYTE-IDENTICAL to the Authorised redirect
 * URI on the OAuth client. Google compares the strings — a trailing slash, http
 * for https, or a different host is `redirect_uri_mismatch` and nothing else.
 * There is no default, because a wrong guess here fails at the END of the flow,
 * after the person has already picked an account.
 */
const GOOGLE_CLIENT_ID = process.env.ZEVET_GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.ZEVET_GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT = process.env.ZEVET_GOOGLE_REDIRECT || "";
const GOOGLE_DOMAIN = process.env.ZEVET_GOOGLE_DOMAIN || "";
const GOOGLE_OWNER = process.env.ZEVET_GOOGLE_OWNER || "";
const GOOGLE_ON = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT);

/**
 * ⚠️ A HUB WITH NO GITHUB APP KEEPS NO STATE ON DISK, exactly as before this
 * existed. `defaultAccountsFile` is only reached when there is something to
 * persist — sessions and the shared secret — and a hub that cannot issue
 * sessions has neither. Without this the test suite, which starts dozens of
 * hubs with a plain `ZEVET_TOKEN`, would each write an account store into the
 * tree and then share it with the next run.
 */
const ACCOUNTS_FILE = process.env.ZEVET_ACCOUNTS || (GITHUB_CLIENT_ID || GOOGLE_CLIENT_ID ? defaultAccountsFile(HERE) : null);

const accounts = new Accounts({ file: ACCOUNTS_FILE, secret: process.env.ZEVET_SECRET || "" });

/**
 * The shared token — the credential that is NOT a GitHub session.
 *
 * ⚠️ `ZEVET_TOKEN` STILL WINS WHEN IT IS SET, and that is not legacy
 * politeness: it is what every install in the field presents, what every hook
 * presents, and what the test suite starts a hub with. Deriving over the top of
 * it would have silently changed the credential of a running deployment.
 *
 * What is NOT tolerated is the two disagreeing. Setting `ZEVET_SECRET` and a
 * `ZEVET_TOKEN` that is not its derivative is the exact shape of the cutover
 * bug in docs/RELEASING.md — two values, one of them stale, and a plain 401
 * that said nothing about which. That is now a refusal to start, because a hub
 * that boots into that state looks perfectly healthy while rejecting the whole
 * team.
 */
const ENV_TOKEN = process.env.ZEVET_TOKEN || "";
const DERIVED = accounts.secret ? deriveAuthToken(accounts.secret) : "";

if (ENV_TOKEN && DERIVED && ENV_TOKEN !== DERIVED && process.env.ZEVET_SECRET) {
  console.error("zevet: ZEVET_TOKEN is set, and it is not the token ZEVET_SECRET derives to.");
  console.error("      Clients derive from the secret, so one of these is stale and every teammate would get a 401.");
  console.error(`      Either drop ZEVET_TOKEN, or set it to ${DERIVED}`);
  process.exit(1);
}

const TOKEN = ENV_TOKEN || DERIVED;
const MAX_EVENTS = Number(process.env.ZEVET_MAX_EVENTS || 2000);
// Prompt bodies and shell commands older than this are served blank and
// compacted out of the log at boot (see snapshot() and the replay below). 0
// keeps everything — the default, because history is the feature and
// retention is the operator's call, not ours to make silently.
const DETAIL_TTL_MS = Number(process.env.ZEVET_DETAIL_TTL_MS || 0);
// Two agents touching one file inside this window is worth a warning. Ten
// minutes is a guess we can move; it is deliberately longer than a turn.
const COLLISION_WINDOW_MS = Number(process.env.ZEVET_COLLISION_WINDOW_MS || 10 * 60 * 1000);
const IDLE_AFTER_MS = 90 * 1000;

/**
 * Tools that change a file. Reading the same file as a teammate is not a
 * collision — it is two people doing their jobs.
 */
const WRITING_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "Update", "Create"]);

/* This used to refuse to start without ZEVET_TOKEN, and the refusal is kept,
 * because it is the only thing between an unauthenticated hub and the internet.
 *
 * ⚠️ THE CONDITION IS "NOTHING WAS CONFIGURED", NOT "TOKEN IS EMPTY". `Accounts`
 * mints a master secret when it has none, so TOKEN is now never empty — and a
 * hub that started on a freshly invented secret would be a hub with a perfectly
 * good credential that NOBODY ON EARTH KNOWS, listening on a public port,
 * reporting itself healthy. That is worse than not starting, and it is
 * indistinguishable from working until the first teammate tries to connect. */
if (!ENV_TOKEN && !process.env.ZEVET_SECRET && !GITHUB_CLIENT_ID && !GOOGLE_CLIENT_ID) {
  console.error("zevet: refusing to start with no way for anyone to authenticate.");
  console.error("      Set ZEVET_GITHUB_CLIENT_ID or ZEVET_GOOGLE_CLIENT_ID for sign-in, or ZEVET_SECRET (or ZEVET_TOKEN) for the shared credential.");
  process.exit(1);
}

if (!TOKEN) {
  console.error("zevet: no credential of any kind could be established. Refusing to start.");
  process.exit(1);
}

/* ⚠️ A HALF-CONFIGURED GOOGLE CLIENT IS A REFUSAL, NOT A WARNING. The missing
 * piece does not surface until the very end of the flow — after the person has
 * opened a browser, picked an account and consented — and it surfaces there as
 * `redirect_uri_mismatch` or a blank 503, neither of which names the env var
 * that is absent. Saying so at boot is the only place it can be said usefully. */
if (GOOGLE_CLIENT_ID && !GOOGLE_ON) {
  const missing = [
    !GOOGLE_CLIENT_SECRET && "ZEVET_GOOGLE_CLIENT_SECRET",
    !GOOGLE_REDIRECT && "ZEVET_GOOGLE_REDIRECT",
  ].filter(Boolean);
  console.error(`zevet: ZEVET_GOOGLE_CLIENT_ID is set but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not.`);
  console.error("      Google's web flow needs all three. Refusing to start rather than fail at the end of somebody's sign-in.");
  process.exit(1);
}

if (GOOGLE_ON && !GOOGLE_DOMAIN) {
  // Not fatal — a hub CAN run Google sign-in off the allowlist alone — but it
  // is almost never what was meant, and the symptom is a teammate being
  // refused with "not on this hub's list" after a flawless sign-in.
  console.warn("zevet: ZEVET_GOOGLE_DOMAIN is not set — Google sign-in admits only people already on the list, not a whole Workspace.");
}

if (!GITHUB_CLIENT_ID && !GOOGLE_ON) {
  console.warn("zevet: no sign-in provider is configured — the shared secret is the only way in.");
} else if (!accounts.owner) {
  console.warn("zevet: nobody has claimed this hub yet. The FIRST sign-in becomes the owner.");
}

const CLIENT_DIR = path.join(HERE, "..", "client");
/** Exactly what the update channel will serve. An allowlist, not a directory listing. */
const CLIENT_FILES = [
  "hook.mjs",
  "install.mjs",
  "updater.mjs",
  "detect.mjs",
  "install-codex.mjs",
  // codex-trust.mjs is imported BY install-codex.mjs and uninstall.mjs. Leaving
  // it out shipped a client whose installer crashed on a missing import, and
  // nothing would have caught it -- test/client.test.mjs now asserts that this
  // list is closed under the imports of the files in it.
  "codex-trust.mjs",
  // install-opencode.mjs is imported BY install.mjs and uninstall.mjs, and
  // opencode-plugin.mjs is the template it copies into each wired repo's
  // .opencode/plugins/. Both must ship or a teammate's installer writes nothing.
  "install-opencode.mjs",
  "opencode-plugin.mjs",
  "uninstall.mjs",
  "doctor.mjs",
  // secret.mjs is imported BY hook.mjs, updater.mjs and doctor.mjs. It has to
  // be here BEFORE those three start importing it, not after: the updater
  // replaces client files with exactly what this list names, so a hook.mjs that
  // imports a file the hub does not serve is a hook that dies on `ERR_MODULE_
  // NOT_FOUND` before it has read a byte of stdin -- on every teammate's
  // machine, silently, because the hook writes nothing to stdout and exits 0
  // (see client/hook.mjs, rules 1 and 2). The closure test in
  // test/codex-trust.test.mjs is what makes that ordering enforceable rather
  // than remembered.
  "secret.mjs",
  // doc-crypto.mjs is NOT yet imported by anything in this list -- the editor
  // is what will use it. It is shipped anyway, deliberately: the alternative is
  // that the file arrives on teammates' machines in the same update as the code
  // that first imports it, which is the exact race the entry above exists to
  // avoid. Shipping an unused 5 KB file early costs nothing.
  "doc-crypto.mjs",
];

/** The self-hosted faces. All SIL OFL-1.1; see hub/public/fonts/LICENSE. */
const FONT_FILES = [
  "space-grotesk-variable.woff2",
  "jost-variable.woff2",
  "ibm-plex-mono-400.woff2",
  // Kept so an older cached board does not 404 its own type mid-session.
  "hanken-grotesk-variable.woff2",
  "frank-ruhl-libre-variable.woff2",
];

/**
 * The remaining static assets the board pulls in, name -> content type.
 *
 * An exact-name map, checked with Object.hasOwn: a bare `name in PUBLIC_FILES`
 * would answer true for "constructor" and "toString" and send the handler off
 * to read a file named after a prototype member. Same allowlist discipline as
 * FONT_FILES and CLIENT_FILES, one route each, no directory listing anywhere.
 */
const PUBLIC_FILES = {
  "editor.js": "text/javascript",
  // Source maps are JSON. Serving one as text/javascript happens to work in
  // Chrome and is refused by stricter tooling, and "it worked in the browser I
  // tried" is not a content type.
  "editor.js.map": "application/json",
  "agent-sprites.js": "text/javascript",
  // The React board, built by board/build.mjs into hub/public. Same committed-
  // bundle contract as editor.js: build here, commit the output.
  "board.js": "text/javascript",
  "board.js.map": "application/json",
  "board.css": "text/css",
};

/**
 * What this hub is currently shipping: a version, and a sha256 per file.
 *
 * Built per request rather than cached at boot, so editing a client file and
 * reloading is the whole publish step — which is the point of hosting updates
 * here. Three small files; hashing them costs nothing next to the round trip.
 */
async function buildManifest() {
  const pkg = JSON.parse(await readFile(path.join(HERE, "..", "package.json"), "utf8"));
  const files = [];
  for (const name of CLIENT_FILES) {
    const buf = await readFile(path.join(CLIENT_DIR, name));
    files.push({ name, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") });
  }
  return { version: pkg.version, files };
}

/** @type {Array<object>} newest last */
const events = [];
/** @type {Set<import("node:http").ServerResponse>} */
const listeners = new Set();

/**
 * The board, surviving a restart.
 *
 * A hub that kept its events in memory alone forgot the whole board every
 * deploy and every crash — and deploys are routine here. So every recorded
 * event is appended to `var/events.jsonl` (next to the account store, and
 * gitignored for the same reason: a tracked copy would overwrite the live one
 * on deploy), and at boot the tail is replayed into memory. The replay is
 * capped at MAX_EVENTS, so a log that grew for a year still boots in
 * milliseconds; the in-memory window stays the board's working set, not an
 * archive. `ZEVET_EVENTS` overrides the path exactly like `ZEVET_ACCOUNTS`
 * does for the account store, and the test suite points every hub at a temp
 * file so runs cannot see each other.
 */
const EVENTS_FILE = process.env.ZEVET_EVENTS || path.join(HERE, "..", "var", "events.jsonl");
try {
  mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
  if (existsSync(EVENTS_FILE)) {
    const lines = readFileSync(EVENTS_FILE, "utf8").split("\n").filter((l) => l.trim());
    for (const line of lines.slice(-MAX_EVENTS)) {
      try {
        const evt = JSON.parse(line);
        if (evt && typeof evt === "object") events.push(evt);
      } catch {
        // One corrupt line is not a corrupt log. Skip it and keep the rest.
      }
    }
    // Retention compaction: details older than the TTL are blanked in place,
    // so the archive keeps the structure (who/tool/file/repo) and forgets the
    // words. Best effort; a failure here costs nothing at runtime.
    if (DETAIL_TTL_MS > 0) {
      try {
        const now = Date.now();
        const compacted = lines.map((line) => {
          try {
            const evt = JSON.parse(line);
            if (evt && typeof evt === "object" && now - evt.ts > DETAIL_TTL_MS) {
              return JSON.stringify({ ...evt, detail: "" });
            }
          } catch {
            // Keep the line as-is; the replay above already skipped it.
          }
          return line;
        });
        writeFileSync(EVENTS_FILE, `${compacted.join("\n")}\n`);
      } catch {
        // The uncompacted log still replays fine above.
      }
    }
  }
} catch (err) {
  // A hub that cannot read its log still serves the board; it just starts
  // empty. Say so once, on stderr, where the operator looks.
  console.error(`zevet: event log unreadable (${err.message}) — starting with an empty board`);
}

/**
 * Is this credential good?
 *
 * ⚠️ THE SHARED TOKEN IS CHECKED FIRST AND IN CONSTANT TIME; the session lookup
 * is a plain map hit. That asymmetry is deliberate and not an oversight. The
 * shared token is ONE long-lived value used by everybody, so a timing oracle
 * against it is worth mounting. A session is 32 fresh random bytes belonging to
 * one person, with no structure to learn a byte at a time and a ninety-day
 * life; comparing it in constant time would protect against an attack that
 * cannot be run.
 *
 * Both are the same length, so the length check that precedes everything does
 * not distinguish them and cannot be used to tell which kind a hub is holding.
 */
function tokenOk(given) {
  if (typeof given !== "string" || given.length !== TOKEN.length) return false;
  try {
    if (timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN))) return true;
  } catch {
    /* fall through to the session check */
  }
  return accounts.session(given) !== null;
}

const COOKIE = "zevet_session";

/**
 * The token, from wherever it legitimately arrives.
 *
 * Header for the hooks and the updater, cookie for a browser, query string
 * only as the one-shot that gets exchanged for a cookie immediately (see the
 * `/` route). The query string is last on purpose: it is the leakiest of the
 * three, and the only reason it is accepted at all is that a link is how a
 * teammate is told where the board is.
 */
function tokenFrom(req, url) {
  const header = req.headers["x-zevet-token"];
  if (typeof header === "string" && tokenOk(header)) return header;

  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== COOKIE) continue;
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    if (tokenOk(value)) return value;
  }

  const q = url.searchParams.get("token");
  return typeof q === "string" && tokenOk(q) ? q : null;
}

function clientIp(req) {
  // Behind Caddy the real address is in x-forwarded-for. Trusting that header
  // blindly would let anyone forge it, so it is used for LOGGING and rate
  // limiting only — never for authorisation, which is the token's job alone.
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

/**
 * Failed auth: counted, logged, and eventually refused.
 *
 * The hub used to answer 401 and say nothing at all. No log line, no counter,
 * no limit — so a stolen or brute-forced token was undetectable by
 * construction, and there was no record that anyone had even tried. For a
 * board that carries what three people are typing all day, "we would never
 * know" is not an acceptable answer.
 */
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const AUTH_MAX_FAILURES = 20;
const authFailures = new Map(); // ip -> { count, first, loggedAt }

function authFailed(req, url) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = authFailures.get(ip);
  if (!rec || now - rec.first > AUTH_WINDOW_MS) {
    authFailures.set(ip, { count: 1, first: now });
    console.error(`zevet: rejected token from ${ip} on ${url.pathname}`);
    return;
  }
  rec.count += 1;
  // One line per failure would be a gift to anyone wanting to fill the disk.
  if (rec.count <= 5 || rec.count % 25 === 0) {
    console.error(`zevet: rejected token from ${ip} on ${url.pathname} (${rec.count} in the last 5 min)`);
  }
  if (rec.count === AUTH_MAX_FAILURES) {
    console.error(`zevet: ${ip} is now rate limited — ${rec.count} failures in 5 minutes`);
  }
}

/**
 * Answer a request that did not authenticate.
 *
 * The rate limit is applied HERE and nowhere else, which is the whole point.
 * An earlier version gated every request at the top of the handler, so twenty
 * fat-fingered tokens locked the IP out — INCLUDING requests carrying the
 * CORRECT token. Behind one office NAT that is three people locked out by one
 * person's typo, and the lockout would have looked exactly like the hub being
 * down. A brute-force attempt only ever presents invalid tokens, so limiting
 * the failure path costs an attacker everything and a teammate nothing.
 */
function refuse(req, res, url) {
  authFailed(req, url);
  if (rateLimited(req)) {
    return json(res, 429, { error: "too many failed attempts from this address; try again in a few minutes" });
  }
  return json(res, 401, { error: "bad token" });
}

function rateLimited(req) {
  const rec = authFailures.get(clientIp(req));
  if (!rec) return false;
  if (Date.now() - rec.first > AUTH_WINDOW_MS) return false;
  return rec.count >= AUTH_MAX_FAILURES;
}

/** Periodically forget old entries, so this cannot grow without bound. */
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of authFailures) {
    if (now - rec.first > AUTH_WINDOW_MS) authFailures.delete(ip);
  }
}, AUTH_WINDOW_MS).unref();

function sessionCookie(req, token) {
  // `Secure` only when the connection really is HTTPS — setting it on plain
  // http makes the browser drop the cookie and the board silently never
  // authenticates, which looks like a broken hub.
  const https = req.headers["x-forwarded-proto"] === "https";
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${60 * 60 * 24 * 30}`,
  ];
  if (https) parts.push("Secure");
  return parts.join("; ");
}

function record(evt) {
  events.push(evt);
  while (events.length > MAX_EVENTS) events.shift();
  // Best effort, and deliberately synchronous: one small append per event, no
  // queue to drain and no background writer to lose on crash. A hub that
  // cannot write its log keeps serving — the board is live either way — but
  // the first failure is said once on stderr, because a log that silently
  // never lands is a restart away from an empty board nobody expected.
  try {
    appendFileSync(EVENTS_FILE, `${JSON.stringify(evt)}\n`);
  } catch (err) {
    if (!record.warned) {
      record.warned = true;
      console.error(`zevet: event log unwritable (${err.message}) — board will not survive a restart`);
    }
  }
  const frame = `event: activity\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of listeners) {
    // MEASURED: `res.write()` on a reset socket returns false, it does NOT
    // throw. The try/catch that used to be here — and the comment claiming it
    // dropped dead listeners and warned about them — could never once have
    // run. Listeners are actually removed by the "close" handler on the
    // request, which does work, so nothing leaked; but the stated safety net
    // was imaginary, and a comforting comment about a branch that cannot
    // execute is worse than no comment.
    if (res.destroyed || res.writableEnded) {
      listeners.delete(res);
      continue;
    }
    // A socket that is open but not draining — a sleeping laptop, a tab behind
    // a stalled proxy — buffers in this process with no backpressure and no
    // cap. Cut it loose rather than growing the hub's memory on its behalf.
    if (!res.write(frame) && res.writableLength > 1_000_000) {
      console.error("zevet: dropping a listener that stopped draining (>1MB buffered)");
      listeners.delete(res);
      res.destroy();
    }
  }
}

/** Presence, collisions and recent files, derived fresh — nothing cached to drift. */
function snapshot() {
  const now = Date.now();
  // Prompt bodies and shell commands age out of the served board after
  // ZEVET_DETAIL_TTL_MS (0, the default, keeps everything). Structure —
  // who, what tool, what file, what repo — is the board's long memory and is
  // never trimmed; `detail` is the sensitive half and the only thing with a
  // TTL. The log file is compacted the same way at boot (see above), so this
  // is retention, not a view filter.
  const show = (e) =>
    DETAIL_TTL_MS > 0 && now - e.ts > DETAIL_TTL_MS ? { ...e, detail: "" } : e;
  const actors = new Map();
  for (const e of events) {
    const a = actors.get(e.actor) || { actor: e.actor, hue: null, lastTs: 0, lastEvent: null, turns: 0, tools: 0 };
    a.lastTs = Math.max(a.lastTs, e.ts);
    if (!a.lastEvent || e.ts >= a.lastEvent.ts) a.lastEvent = show(e);
    if (e.kind === "prompt") a.turns += 1;
    if (e.kind === "tool") a.tools += 1;
    actors.set(e.actor, a);
  }
  const roster = [...actors.values()]
    .sort((x, y) => x.actor.localeCompare(y.actor))
    .map((a, i) => ({ ...a, hue: i, idle: now - a.lastTs > IDLE_AFTER_MS, agoMs: now - a.lastTs }));

  // Collisions: one file, two people, both writing, both inside the window.
  //
  // Four defects lived in the first version of this, all found by driving it
  // rather than reading it, and all of them made the headline feature lie:
  //
  //   1. READS COUNTED. Every Claude Code session opens by reading CLAUDE.md,
  //      README.md and package.json, so the alert panel lit up within seconds
  //      of two people starting work, on files neither was changing. `e.tool`
  //      was already on the event and simply never consulted. Alert fatigue
  //      kills a warning nobody can act on.
  //   2. THE TRUE POSITIVE DISAPPEARED. Participants were keyed by display
  //      name, and the name defaults to the OS username. Two machines both
  //      reporting `Administrator` or `User` — routine on Windows — collapsed
  //      to one participant, so `size < 2` skipped exactly the case where two
  //      real people were about to clobber one file. Keyed by name AND machine
  //      now, which is why the hook reports a machine at all.
  //   3. CROSS-REPO FALSE POSITIVES. The key was the repo-relative path alone,
  //      so `src/index.ts` in two different repos collided permanently.
  //   4. CASE. `src/DB.ts` and `src/db.ts` are one file on the case-insensitive
  //      filesystems Windows and macOS both ship by default, and were two keys.
  const byTarget = new Map();
  for (const e of events) {
    if (!e.target || e.kind !== "tool") continue;
    if (!WRITING_TOOLS.has(e.tool)) continue;
    if (now - e.ts > COLLISION_WINDOW_MS) continue;

    const key = `${(e.repo || "").toLowerCase()}\u0000${e.target.toLowerCase()}`;
    const bucket = byTarget.get(key) || { target: e.target, repo: e.repo, who: new Map() };
    const participant = `${e.actor}\u0000${e.machine || ""}`;
    const prev = bucket.who.get(participant);
    if (!prev || e.ts > prev.ts) {
      bucket.who.set(participant, { actor: e.actor, machine: e.machine || "", ts: e.ts });
    }
    byTarget.set(key, bucket);
  }

  const collisions = [];
  for (const bucket of byTarget.values()) {
    if (bucket.who.size < 2) continue;
    const actors = [...bucket.who.values()].sort((x, y) => y.ts - x.ts);
    // When two participants share a display name, say which machine is which —
    // otherwise the card reads "andrew and andrew" and looks like a bug.
    const nameCount = new Map();
    for (const a of actors) nameCount.set(a.actor, (nameCount.get(a.actor) || 0) + 1);
    for (const a of actors) {
      a.label = nameCount.get(a.actor) > 1 && a.machine ? `${a.actor} (${a.machine})` : a.actor;
    }
    collisions.push({ target: bucket.target, repo: bucket.repo, actors, lastTs: actors[0].ts });
  }
  collisions.sort((x, y) => y.lastTs - x.lastTs);

  return { now, roster, collisions, events: events.slice(-300).map(show), windowMs: COLLISION_WINDOW_MS, idleAfterMs: IDLE_AFTER_MS };
}

/**
 * decodeURIComponent, without the landmine.
 *
 * MEASURED: `curl http://hub/dist/%` took the whole hub down for everyone.
 * `decodeURIComponent("%")` throws URIError, and the call sat one line ABOVE
 * the try block that was meant to contain it. `npm run hub` is a bare node
 * process with no supervisor, so the board stayed dark until somebody noticed.
 * One request, no log line, three people blind.
 */
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  const headers = { "content-type": "application/json", "cache-control": "no-store" };

  // MEASURED BUG: every early answer here — a 401 for a bad token, a 400 for an
  // oversized body — was sent WITHOUT consuming the request body, so the rest
  // of it was still arriving on a socket we had already finished with. Node
  // then tore that socket down, and because keep-alive had already handed it
  // back to the pool, the reset surfaced on a LATER, innocent request:
  //
  //   OVERSIZE:             HTTP 400 in 16ms
  //   small after oversize: HTTP 200 in 14ms
  //   small after that:     FAILED in 5988ms -> ECONNRESET
  //
  // A different event paid for it, six seconds later, with nothing connecting
  // the two. Telling the client not to reuse the socket is the whole fix; the
  // in-flight remainder is discarded with the connection.
  //
  // Narrow on purpose: a GET has no body to leave unread, and closing its
  // connection would throw away keep-alive for the dashboard's own polling.
  const req = res.req;
  const unreadBody =
    req &&
    !req.readableEnded &&
    (Number(req.headers["content-length"]) > 0 || Boolean(req.headers["transfer-encoding"]));
  if (unreadBody) headers.connection = "close";

  res.writeHead(code, headers);
  res.end(s);
}

async function readBody(req, limit = 256 * 1024) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/* ── Google sign-ins in flight ───────────────────────────────────────────────
 *
 * Google's flow lands in a BROWSER, and the thing that needs the session is the
 * desktop app. Something has to carry it across, and this map is it: `start`
 * mints a pairing code, the browser comes back to `callback` carrying that code
 * as the OAuth `state`, and the app claims the result from `finish`.
 *
 * The pairing code doing double duty as `state` is what makes this flow
 * CSRF-proof without a cookie: it is 32 bytes this process minted for one
 * attempt, so a callback carrying a state the hub does not hold is a callback
 * the hub never started, and it is refused before anything is exchanged.
 *
 * ⚠️ IN MEMORY, NEVER ON DISK. A claimed-but-unwritten result holds the master
 * secret for the few seconds between the browser landing and the app polling.
 * Persisting it would put that secret in a second file for no reason, and a hub
 * restart losing a sign-in in flight costs one button press.
 *
 * ⚠️ SINGLE USE, AND THAT MEANS TWICE OVER. `finish` deletes the entry it
 * answers, so a leaked pairing code is worth nothing once the app has claimed
 * it — and `callback` marks the entry `tried` the first time it attempts an
 * exchange, so a code cannot be redeemed twice either.
 *
 * The second half is not symmetry for its own sake. Without it, anyone holding
 * one valid state could hit `/auth/google/callback?state=…&code=garbage` over
 * and over, and every call made this process open a real TLS connection to
 * oauth2.googleapis.com and wait up to ten seconds for it. That is an
 * unauthenticated caller spending OUR outbound requests, amplified once per
 * pair code they hold.
 */
const GOOGLE_PAIR_TTL_MS = 10 * 60 * 1000;
/** A ceiling, so an open endpoint that allocates cannot be made to allocate
 *  forever. 200 concurrent sign-ins is far past any real team. */
const GOOGLE_PAIRS_MAX = 200;
const googlePairs = new Map(); // pairCode -> { at, result, error, tried }

/**
 * How many sign-ins one address may have in flight.
 *
 * ⚠️ THE FAILURE LIMITER DOES NOT COVER THIS ROUTE, ON PURPOSE. `rateLimited`
 * counts AUTH FAILURES and nothing else — see `refuse` above for why that is
 * right, and why gating every request on it would lock a whole office out over
 * one typo. But `/auth/google/start` never fails authentication: it succeeds,
 * and each success ALLOCATES A ROW IN A SHARED TABLE. So a clean address was
 * never throttled there, and one anonymous caller could mint 200 pair codes in
 * a burst, fill `googlePairs`, and hand every real teammate
 * "too many sign-ins in flight" for the next ten minutes — refillable
 * indefinitely as entries expire. A global ceiling is not a defence when one
 * caller can occupy all of it.
 *
 * This is a COST budget rather than a failure budget, which is why it is a
 * separate counter: eight concurrent sign-ins is far past anything a person
 * does and nowhere near what filling the table needs.
 */
const GOOGLE_STARTS_PER_IP = 8;

/** How many live pairs this address is currently holding. Counted rather than
 *  tracked, so an expired or claimed pair frees the budget with no bookkeeping
 *  that could itself drift. */
function googleStartsBy(ip) {
  let n = 0;
  for (const p of googlePairs.values()) if (p.ip === ip) n += 1;
  return n;
}

function sweepGooglePairs() {
  const now = Date.now();
  for (const [code, p] of googlePairs) if (now - p.at > GOOGLE_PAIR_TTL_MS) googlePairs.delete(code);
}
setInterval(sweepGooglePairs, 60 * 1000).unref();

/** The one page on this hub a person reads with their eyes. Deliberately plain
 *  text in a minimal document: it is shown in whatever browser Google redirected
 *  to, it must never be cached, and it carries NOTHING — no token, no secret,
 *  no name that was not already typed by the person reading it. */
function googlePage(res, status, message) {
  const body = `<!doctype html><meta charset="utf-8"><title>zevet</title>` +
    `<style>body{font:16px/1.5 system-ui,sans-serif;margin:12vh auto;max-width:34rem;padding:0 1.5rem;color:#111}` +
    `p{margin:0}</style><p>${escapeHtml(message)}</p>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

/** One row of the People list. Shared by `/auth/whoami` and `/auth/allow` so
 *  the two cannot drift into describing the same person differently. */
function person(a) {
  return { login: a.display || a.login, provider: a.provider, owner: a.owner, pending: !a.id };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");


  /* ── Signing in ────────────────────────────────────────────────────────────
   *
   * ⚠️ THE TWO /auth/github ROUTES ARE UNAUTHENTICATED, AND MUST BE.
   *
   * They are what somebody with NO credential uses to get one — the same
   * reasoning that leaves `/setup.ps1` open. What stops them being a way in is
   * that neither one decides anything: `start` asks GitHub for a code and
   * hands it back, and `finish` only ever returns a session when GITHUB has
   * confirmed the person AND accounts.mjs has found them on the list. Nothing
   * a caller sends is trusted; the answer comes from GitHub.
   *
   * They are rate limited by the same counter as a bad token, so hammering
   * `finish` with guessed device codes is throttled exactly like guessed
   * tokens. A device code is 40-odd random characters that GitHub expires in
   * fifteen minutes, so there is nothing here to guess at anyway.
   */
  if (url.pathname === "/auth/github/start" && req.method === "POST") {
    if (!GITHUB_CLIENT_ID) return json(res, 503, { error: "this hub has no GitHub sign-in configured" });
    if (rateLimited(req)) return json(res, 429, { error: "too many attempts" });

    const r = await deviceStart({ clientId: GITHUB_CLIENT_ID });
    if (!r.ok) return json(res, 502, { error: r.error });
    return json(res, 200, {
      ok: true,
      deviceCode: r.deviceCode,
      userCode: r.userCode,
      verificationUri: r.verificationUri,
      verificationUriComplete: r.verificationUriComplete,
      interval: r.interval,
      expiresIn: r.expiresIn,
    });
  }

  if (url.pathname === "/auth/github/finish" && req.method === "POST") {
    if (!GITHUB_CLIENT_ID) return json(res, 503, { error: "this hub has no GitHub sign-in configured" });
    if (rateLimited(req)) return json(res, 429, { error: "too many attempts" });

    let body = null;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "expected JSON" });
    }

    const polled = await devicePoll({ clientId: GITHUB_CLIENT_ID, deviceCode: body && body.deviceCode });
    if (!polled.ok) return json(res, 400, { error: polled.error });
    // Still waiting on the browser. A 200 with `pending` rather than a 202 or a
    // 4xx, because the desktop app polls this every few seconds for up to
    // fifteen minutes and a non-2xx would light up every error path it has.
    if (polled.pending) return json(res, 200, { ok: true, pending: true, slowDown: Boolean(polled.slowDown) });

    const who = await githubUser({ accessToken: polled.accessToken });
    if (!who.ok) return json(res, 502, { error: who.error });

    const may = accounts.mayEnter(who, { requiredOwner: GITHUB_OWNER });
    if (!may.ok) {
      // Counted as an auth failure: this is somebody who authenticated to
      // GitHub successfully and is still not allowed here, which is precisely
      // the event worth noticing.
      authFailed(req, url);
      return json(res, 403, { error: may.error });
    }

    const sess = accounts.signIn(who);
    console.log(`zevet: ${sess.owner ? "OWNER " : ""}sign-in by @${sess.login}`);

    /* ⚠️ THIS RESPONSE CARRIES THE MASTER SECRET. It is the only route that
     * does, it is over TLS, and it is the whole of the tradeoff documented at
     * the top of accounts.mjs — the hub knows the key and gives it to anyone it
     * believes. Do not add it to any other response, do not log it, and do not
     * put it in a query string. */
    return json(res, 200, {
      ok: true,
      token: sess.token,
      secret: accounts.secret,
      login: sess.login,
      owner: sess.owner,
    });
  }

  /* ── Signing in with Google ────────────────────────────────────────────────
   *
   * Three routes rather than GitHub's two, because the browser leaves and comes
   * back: `start` (app asks where to send the browser), `callback` (Google
   * sends the browser here), `finish` (app collects the session).
   *
   * ⚠️ ALL THREE ARE UNAUTHENTICATED, AND MUST BE — same reasoning as the
   * GitHub pair above, and the same protection: none of them decides anything.
   * `start` hands out a random code, `callback` believes nothing a caller sends
   * (the identity comes from an id token this process fetched from Google
   * itself), and `finish` returns only what `callback` already established.
   */
  if (url.pathname === "/auth/google/start" && req.method === "POST") {
    if (!GOOGLE_ON) return json(res, 503, { error: "this hub has no Google sign-in configured" });
    if (rateLimited(req)) return json(res, 429, { error: "too many attempts" });

    sweepGooglePairs();
    if (googlePairs.size >= GOOGLE_PAIRS_MAX) return json(res, 429, { error: "too many sign-ins in flight — try again in a minute" });
    /* The per-address budget, checked BEFORE the global ceiling is reached, so
       one caller cannot be the reason everyone else is refused. */
    const ip = clientIp(req);
    if (googleStartsBy(ip) >= GOOGLE_STARTS_PER_IP) {
      return json(res, 429, { error: "too many sign-ins in flight from this address — finish one or wait" });
    }

    const pairCode = randomBytes(32).toString("hex");
    googlePairs.set(pairCode, { at: Date.now(), ip, result: null, error: null, tried: false });
    return json(res, 200, {
      ok: true,
      pairCode,
      authUrl: authorizeUrl({ clientId: GOOGLE_CLIENT_ID, redirectUri: GOOGLE_REDIRECT, state: pairCode, domain: GOOGLE_DOMAIN }),
      // Google has nothing to say about how fast to poll, unlike GitHub's
      // device flow. Two seconds is the app waiting on a human in a browser.
      interval: 2,
      expiresIn: Math.floor(GOOGLE_PAIR_TTL_MS / 1000),
      domain: GOOGLE_DOMAIN,
    });
  }

  if (url.pathname === "/auth/google/callback" && req.method === "GET") {
    if (!GOOGLE_ON) return googlePage(res, 503, "Google sign-in is not configured on this hub.");

    const state = url.searchParams.get("state") || "";
    const pair = googlePairs.get(state);
    if (!pair) {
      // Either expired, already used, or never minted here. All three read the
      // same to the person and none of them is worth distinguishing for whoever
      // is guessing.
      authFailed(req, url);
      return googlePage(res, 400, "That sign-in link has expired or was already used. Start again in zevet.");
    }

    /* ⚠️ ONE ATTEMPT. Marked before the exchange, not after, because the
       point is to bound the OUTBOUND call — setting it afterwards would leave
       the whole window between two concurrent requests unprotected. A person
       whose exchange genuinely failed starts again from the app, which mints a
       fresh code; that is one extra click for them and the end of the
       amplification for everyone else. */
    if (pair.tried) {
      authFailed(req, url);
      return googlePage(res, 400, "That sign-in link has already been used. Start again in zevet.");
    }

    const denied = url.searchParams.get("error");
    if (denied) {
      pair.error = denied === "access_denied" ? "the request was declined on Google" : `Google said: ${denied}`;
      return googlePage(res, 200, "Sign-in was cancelled. You can close this tab.");
    }

    pair.tried = true;
    const ex = await exchangeCode({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      code: url.searchParams.get("code"),
      redirectUri: GOOGLE_REDIRECT,
    });
    if (!ex.ok) {
      pair.error = ex.error;
      return googlePage(res, 502, ex.error);
    }

    /* ⚠️ THE IDENTITY COMES FROM HERE AND NOWHERE ELSE. Not from the query
     * string, not from anything the browser carried — from an id token this
     * process just fetched from Google over TLS. See google-auth.mjs for why
     * that is also the reason its signature is not separately verified. */
    const who = readIdToken(ex.idToken, { clientId: GOOGLE_CLIENT_ID, domain: GOOGLE_DOMAIN });
    if (!who.ok) {
      pair.error = who.error;
      authFailed(req, url);
      return googlePage(res, 403, who.error);
    }

    const may = accounts.mayEnter(who, { requiredOwner: GOOGLE_OWNER, domain: GOOGLE_DOMAIN });
    if (!may.ok) {
      pair.error = may.error;
      authFailed(req, url);
      return googlePage(res, 403, may.error);
    }

    const sess = accounts.signIn(who);
    console.log(`zevet: ${sess.owner ? "OWNER " : ""}sign-in by ${sess.login}${may.byDomain ? ` (${GOOGLE_DOMAIN} Workspace)` : ""}`);

    /* ⚠️ THIS HOLDS THE MASTER SECRET, in memory, until the app claims it or it
     * expires. Same tradeoff as the GitHub finish route documents; the
     * difference is only that it waits here for a few seconds first. It is not
     * written to disk, not logged, and NOT PUT IN THIS PAGE — the browser that
     * completes the sign-in never sees a credential. */
    pair.result = { token: sess.token, secret: accounts.secret, login: sess.login, owner: sess.owner };
    return googlePage(res, 200, `Signed in as ${sess.login}. You can close this tab and go back to zevet.`);
  }

  if (url.pathname === "/auth/google/finish" && req.method === "POST") {
    if (!GOOGLE_ON) return json(res, 503, { error: "this hub has no Google sign-in configured" });
    if (rateLimited(req)) return json(res, 429, { error: "too many attempts" });

    let body = null;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "expected JSON" });
    }

    const code = String((body && body.pairCode) || "");
    const pair = googlePairs.get(code);
    if (!pair || Date.now() - pair.at > GOOGLE_PAIR_TTL_MS) {
      googlePairs.delete(code);
      authFailed(req, url);
      return json(res, 400, { error: "that sign-in expired — start again" });
    }
    if (pair.error) {
      googlePairs.delete(code);
      return json(res, 403, { error: pair.error });
    }
    // Still in the browser. A 200 with `pending`, for the same reason the
    // GitHub route does it: the app polls this for minutes and a non-2xx would
    // light up every error path it has.
    if (!pair.result) return json(res, 200, { ok: true, pending: true });

    // Single use. The result carries the master secret, so it is handed over
    // exactly once and then is not in this process any more.
    googlePairs.delete(code);
    return json(res, 200, { ok: true, ...pair.result });
  }

  /* Who am I, and who else is allowed? Session-gated like everything else. */
  if (url.pathname === "/auth/whoami") {
    const tok = tokenFrom(req, url);
    if (!tok) return refuse(req, res, url);
    const sess = accounts.session(tok);
    return json(res, 200, {
      ok: true,
      // A shared-token caller is authenticated but anonymous. Saying so is
      // better than inventing a name for it, and it is what the settings pane
      // shows a hook-only machine.
      login: sess ? sess.login : null,
      shared: !sess,
      owner: Boolean(sess && accounts.owner === sess.login),
      githubSignIn: Boolean(GITHUB_CLIENT_ID),
      // Kept alongside `githubSignIn` rather than replacing it with a single
      // `providers` list: a board cached before Google existed reads that exact
      // field to decide whether to show its connect button, and it is served by
      // this same hub on a slower refresh cycle than the hub itself.
      googleSignIn: GOOGLE_ON,
      googleDomain: GOOGLE_DOMAIN,
      people: accounts.list().map(person),
    });
  }

  /* Signing yourself out. NOT owner-gated, unlike allow/revoke below: ending
   * your own session removes nothing but that session, and requiring the
   * owner's say-so to leave would make every departure hostage to somebody
   * else being around. A shared token is not a session, so presenting one
   * logs out nothing — which is also why this cannot be used to end anybody
   * else's session: the only session it can name is the caller's own. */
  if (url.pathname === "/auth/logout" && req.method === "POST") {
    const tok = tokenFrom(req, url);
    if (!tok) return refuse(req, res, url);
    const r = accounts.logout(tok);
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      // Drop the browser cookie too: its session is gone, and a stale cookie
      // otherwise reads as signed-in until it expires on its own.
      "set-cookie": "zevet_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
    });
    return res.end(JSON.stringify({ ok: true, loggedOut: r.loggedOut }));
  }

  /* Adding and removing teammates. OWNER ONLY — a shared token is deliberately
   * not enough, because the shared token is the thing being replaced and
   * anybody holding it could otherwise add themselves permanently. */
  if ((url.pathname === "/auth/allow" || url.pathname === "/auth/revoke") && req.method === "POST") {
    const tok = tokenFrom(req, url);
    if (!tok) return refuse(req, res, url);
    const sess = accounts.session(tok);
    if (!sess || accounts.owner !== sess.login) {
      // "only @the owner" was the first wording, and it is what an UNCLAIMED
      // hub printed -- a sentence that reads like a bug. An unclaimed hub has
      // nobody who can do this, and saying that is more use than naming a
      // person who does not exist.
      return json(res, 403, {
        error: accounts.owner
          ? `only @${accounts.owner} can change this list`
          : "nobody has claimed this hub yet — the first sign-in becomes its owner",
      });
    }
    let body = null;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "expected JSON" });
    }
    const r = url.pathname === "/auth/allow" ? accounts.allow(body && body.login) : accounts.revoke(body && body.login);
    if (!r.ok) return json(res, 400, { error: r.error });
    return json(res, 200, { ok: true, people: accounts.list().map(person) });
  }

  if (url.pathname === "/healthz") {
    // `events` and `listeners` are load-bearing for anything already watching
    // this endpoint; the two ws counters are added beside them, never in place
    // of them.
    return json(res, 200, {
      ok: true,
      events: events.length,
      listeners: listeners.size,
      rooms: rooms.size,
      wsListeners: wsClients.size,
    });
  }

  if (url.pathname === "/ingest" && req.method === "POST") {
    if (!tokenFrom(req, url)) return refuse(req, res, url);
    let parsed;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (err) {
      return json(res, 400, { error: `unreadable body: ${err.message}` });
    }
    // `null` is valid JSON and `null.actor` throws, outside any try, inside an
    // async handler — one authenticated request ended the hub process.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json(res, 400, { error: "expected a JSON object" });
    }
    const evt = {
      id: randomUUID(),
      ts: Date.now(),
      actor: String(parsed.actor || "unknown").slice(0, 40),
      repo: String(parsed.repo || "").slice(0, 120),
      branch: String(parsed.branch || "").slice(0, 120),
      checkout: typeof parsed.checkout === "string" && /^[a-f0-9]{64}$/.test(parsed.checkout) ? parsed.checkout : "",
      kind: ["prompt", "tool", "turn_end"].includes(parsed.kind) ? parsed.kind : "tool",
      tool: String(parsed.tool || "").slice(0, 60),
      target: parsed.target ? String(parsed.target).slice(0, 300) : null,
      detail: String(parsed.detail || "").slice(0, 400),
      agent: String(parsed.agent || "claude-code").slice(0, 40),
      // Which machine said it. Two teammates whose OS username is the same
      // are two participants, and without this they were one.
      machine: String(parsed.machine || "").slice(0, 60),
    };
    record(evt);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/state") {
    if (!tokenFrom(req, url)) return refuse(req, res, url);
    return json(res, 200, snapshot());
  }

  if (url.pathname === "/events") {
    if (!tokenFrom(req, url)) return refuse(req, res, url);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`event: hello\ndata: ${JSON.stringify(snapshot())}\n\n`);
    listeners.add(res);
    // A proxy that sees nothing for a minute will close the stream. Ping.
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(ping);
      }
    }, 25000);
    req.on("close", () => {
      clearInterval(ping);
      listeners.delete(res);
    });
    return;
  }

  // ---- the update channel ------------------------------------------------
  // The hub is the update server (see client/updater.mjs for why). "Newer" is
  // decided by comparing sha256 per file, never by an HTTP status code.
  if (url.pathname === "/dist/manifest.json") {
    if (!tokenFrom(req, url)) return refuse(req, res, url);
    try {
      return json(res, 200, await buildManifest());
    } catch (err) {
      return json(res, 500, { error: `cannot build manifest: ${err.message}` });
    }
  }

  if (url.pathname.startsWith("/dist/")) {
    if (!tokenFrom(req, url)) return refuse(req, res, url);
    // Allowlist, not a path join against user input: "/dist/../../.env" is a
    // request somebody will eventually make.
    const name = safeDecode(url.pathname.slice("/dist/".length));
    if (name === null) return json(res, 400, { error: "unreadable path" });
    if (!CLIENT_FILES.includes(name)) return json(res, 404, { error: "no such build file" });
    try {
      const buf = await readFile(path.join(CLIENT_DIR, name));
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      return res.end(buf);
    } catch (err) {
      return json(res, 500, { error: `cannot read ${name}: ${err.message}` });
    }
  }

  // Bootstrap scripts are served without a token on purpose: they are what a
  // new teammate opens before they have one, and they carry no secret. The
  // token still gates everything the installed client goes on to do.
  if (url.pathname === "/setup.ps1" || url.pathname === "/setup.sh") {
    try {
      const buf = await readFile(path.join(HERE, "..", "dist", url.pathname.slice(1)));
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return res.end(buf);
    } catch (err) {
      return json(res, 500, { error: `cannot read ${url.pathname}: ${err.message}` });
    }
  }

  // Self-hosted type. Masora's system bans external font loading outright
  // (its lint check 5), and a board that blanks its own labels because
  // fonts.googleapis.com is slow or blocked is a monitoring surface that
  // stops monitoring. Allowlisted, like every other file route here.
  if (url.pathname.startsWith("/fonts/")) {
    const name = safeDecode(url.pathname.slice("/fonts/".length));
    if (name === null) return json(res, 400, { error: "unreadable path" });
    if (!FONT_FILES.includes(name)) return json(res, 404, { error: "no such font" });
    try {
      const buf = await readFile(path.join(HERE, "public", "fonts", name));
      res.writeHead(200, {
        "content-type": "font/woff2",
        "cache-control": "public, max-age=31536000, immutable",
      });
      return res.end(buf);
    } catch (err) {
      return json(res, 500, { error: `cannot read ${name}: ${err.message}` });
    }
  }

  // One more static file, allowlisted by exact name like the rest.
  if (url.pathname === "/highlight.js") {
    try {
      const buf = await readFile(path.join(HERE, "public", "highlight.js"));
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      return res.end(buf);
    } catch (err) {
      return json(res, 500, { error: `cannot read highlight.js: ${err.message}` });
    }
  }

  // The rest of the board's static assets, allowlisted by exact name exactly as
  // /highlight.js above is. An exact-name map rather than a prefix match, so
  // "/editor.js/../../.env" and "/editor.js.bak" are not routes at all and fall
  // through to the 404 at the bottom of this handler: there is no directory to
  // list and no path to join against user input.
  //
  // ⚠️ NO CACHING, AND editor.js IS 834 KB. This follows /highlight.js, which
  // answers `cache-control: no-store` with no ETag and no Last-Modified, so
  // every board load reads the whole bundle off disk and sends it again. That
  // is a real cost here in a way it is not for a 35 KB file, and it has NOT
  // been measured against the deployed hub. It is left alone on purpose:
  // inventing a caching layer for one route would be a second, divergent way of
  // serving a static file in a server that currently has one. If this needs
  // fixing, fix it for every static route at once -- an ETag off the file's
  // mtime and size, honoured for /fonts, /highlight.js and these three
  // together.
  if (Object.hasOwn(PUBLIC_FILES, url.pathname.slice(1))) {
    const name = url.pathname.slice(1);
    try {
      const buf = await readFile(path.join(HERE, "public", name));
      res.writeHead(200, { "content-type": PUBLIC_FILES[name], "cache-control": "no-store" });
      return res.end(buf);
    } catch (err) {
      return json(res, 500, { error: `cannot read ${name}: ${err.message}` });
    }
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    // A link is how somebody is told where the board is, so `?token=` has to
    // work — but it should not SURVIVE. Exchange it for an HttpOnly cookie and
    // redirect to a clean URL: after this the token is not in the address bar,
    // not in history, not in a bookmark, and not in the screenshot someone
    // pastes into chat. Anything already holding a valid cookie or header
    // falls straight through.
    const supplied = url.searchParams.get("token");
    if (supplied !== null) {
      if (!tokenOk(supplied)) {
        authFailed(req, url);
      } else {
        const keep = new URLSearchParams(url.searchParams);
        keep.delete("token");
        const rest = keep.toString();
        res.writeHead(302, {
          "set-cookie": sessionCookie(req, supplied),
          location: rest ? `/?${rest}` : "/",
          "cache-control": "no-store",
        });
        return res.end();
      }
    }

    try {
      const html = await readFile(path.join(HERE, "public", "index.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    } catch (err) {
      return json(res, 500, { error: `dashboard missing: ${err.message}` });
    }
  }

  json(res, 404, { error: "no such route" });
});

// ---- the sync transport: RFC 6455, by hand ---------------------------------
//
// WHY THIS IS A FEW HUNDRED LINES INSTEAD OF `npm i ws`.
// The header of this file is not decoration. The hub deploys by `git pull &&
// docker restart` — there is no install step to fail, and no lockfile that can
// resolve differently on the machine that matters. `ws` is a good library; it
// is also a supply chain, a version to track, and a thing that can be missing
// at the wrong moment on somebody else's laptop. This repo already hand-rolls a
// syntax highlighter for the same reason. What follows is only the subset a
// relay needs: no extensions, no compression, no client role, no subprotocols.
//
// THE HUB DOES NOT LOOK INSIDE. Every payload relayed here is an opaque blob.
// It will carry CRDT updates and may be encrypted end to end, so anything the
// hub decided on the basis of a payload's contents would be a decision it is
// not entitled to make and would stop working the day the clients encrypt. The
// only bytes this code parses are its own framing and the tiny JSON join
// message — never a relayed payload.
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const EMPTY = Buffer.alloc(0);

/** One message, fragments included. A client that exceeds it is closed 1009. */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
// The two caps below are overridable the same way MAX_EVENTS is, and for the
// same reason: a cap nobody can reach in a test is a cap nobody has tested.
// Filling 512 rooms or 4 MiB of log over a real socket to prove the eviction
// works would be a slow test that mostly measures localhost.
/** What one room may keep. Oldest entries are dropped past it. */
export const ROOM_LOG_MAX_BYTES = Number(process.env.ZEVET_ROOM_LOG_MAX_BYTES || 4 * 1024 * 1024);
/** How many rooms exist at once — live ones and merely remembered ones. */
export const MAX_ROOMS = Number(process.env.ZEVET_MAX_ROOMS || 512);
/** Room names are opaque to the hub; length is the only thing it judges. */
export const MAX_ROOM_NAME = 256;
// A socket that has stopped draining buffers in THIS process, exactly like the
// SSE listener case above, and gets the same treatment rather than the same
// excuse. Replaying a full room log legitimately queues ROOM_LOG_MAX_BYTES at
// once, so this has to sit above that or a normal join would cut itself off.
const WS_MAX_BUFFERED_BYTES = 2 * ROOM_LOG_MAX_BYTES;
const WS_PING_MS = 30 * 1000;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

// The close codes this hub sends, from RFC 6455 §7.4.1.
const CLOSE_PROTOCOL = 1002; // the peer broke framing
const CLOSE_POLICY = 1008; // the framing was fine, the message was not
const CLOSE_TOO_BIG = 1009;
const CLOSE_TRY_LATER = 1013;

/**
 * Parse whatever whole frames are at the front of `buffer`.
 *
 * Returns `{ frames, rest, error }`. `rest` is the bytes that are not yet a
 * whole frame; the caller keeps them and prepends them to the next chunk. THAT
 * IS THE ENTIRE POINT OF THIS FUNCTION. TCP has no idea what a frame is: one
 * `data` event can carry half a frame, or three frames and a bit, and a decoder
 * that assumes otherwise works perfectly on localhost and corrupts everything
 * over a real network. test/hub-ws.test.mjs feeds it split buffers for exactly
 * this reason.
 *
 * `error` is `{ code, reason }` and means the peer broke the protocol: the
 * caller must close and stop reading. Frames decoded before the error are still
 * returned, for a test or a log to look at — the connection handler throws them
 * away, because a peer that has lost framing is not saying anything worth
 * acting on.
 *
 * Pure: no sockets, no retained state.
 */
export function decodeFrames(buffer) {
  const frames = [];
  let off = 0;

  for (;;) {
    if (buffer.length - off < 2) break;
    const b0 = buffer[off];
    const b1 = buffer[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const control = (opcode & 0x08) !== 0;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let cursor = off + 2;

    // No extension was negotiated, so a set RSV bit means the peer is speaking
    // something this hub never agreed to. Guessing is how a decoder ends up
    // handing compressed bytes to a room as if they were a payload.
    if ((b0 & 0x70) !== 0) {
      return { frames, rest: EMPTY, error: { code: CLOSE_PROTOCOL, reason: "reserved bit set" } };
    }
    if (!control && opcode !== OP_CONTINUATION && opcode !== OP_TEXT && opcode !== OP_BINARY) {
      return { frames, rest: EMPTY, error: { code: CLOSE_PROTOCOL, reason: "unknown opcode" } };
    }
    if (control && opcode !== OP_CLOSE && opcode !== OP_PING && opcode !== OP_PONG) {
      return { frames, rest: EMPTY, error: { code: CLOSE_PROTOCOL, reason: "unknown control opcode" } };
    }
    if (control && (len > 125 || !fin)) {
      return { frames, rest: EMPTY, error: { code: CLOSE_PROTOCOL, reason: "control frame must be short and final" } };
    }
    // Checked here, before the length bytes are even needed: a client MUST mask
    // (§5.3), and the bit is known from the second byte. Rejecting this early
    // means a truncated unmasked frame is refused rather than waited on.
    if (!masked) {
      return { frames, rest: EMPTY, error: { code: CLOSE_PROTOCOL, reason: "client frames must be masked" } };
    }

    if (len === 126) {
      if (buffer.length - cursor < 2) break;
      len = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (len === 127) {
      if (buffer.length - cursor < 8) break;
      const wide = buffer.readBigUInt64BE(cursor);
      cursor += 8;
      // Refused on the HEADER, not after buffering the payload. A 64-bit length
      // is the cheapest denial of service there is: eight bytes on the wire ask
      // this process to hold however many gigabytes the sender feels like
      // naming, and a decoder that waits for them has already lost.
      if (wide > BigInt(MAX_MESSAGE_BYTES)) {
        return { frames, rest: EMPTY, error: { code: CLOSE_TOO_BIG, reason: "frame over the size cap" } };
      }
      len = Number(wide);
    }
    if (len > MAX_MESSAGE_BYTES) {
      return { frames, rest: EMPTY, error: { code: CLOSE_TOO_BIG, reason: "frame over the size cap" } };
    }

    if (buffer.length - cursor < 4) break;
    const key = buffer.subarray(cursor, cursor + 4);
    cursor += 4;
    if (buffer.length - cursor < len) break;

    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = buffer[cursor + i] ^ key[i & 3];
    cursor += len;

    frames.push({ fin, opcode, payload });
    off = cursor;
  }

  return { frames, rest: buffer.subarray(off), error: null };
}

/**
 * One server-to-client frame. Never masked, never fragmented.
 *
 * §5.1 is explicit that a server MUST NOT mask. Fragmenting outbound would be
 * legal but pointless here — a relayed blob is however big it is, and splitting
 * it only gives the peer more chances to reassemble it wrong.
 */
export function encodeFrame(opcode, payload = EMPTY) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, body]);
}

/**
 * Fragments in, messages out.
 *
 * A closure, because the reassembly state belongs to one socket and to nothing
 * else. Each frame produces exactly one verdict:
 *   { kind: "control", opcode, payload }  — ping/pong/close, answer it now
 *   { kind: "partial" }                   — held, waiting for the rest
 *   { kind: "message", opcode, payload }  — a whole message
 *   { kind: "error", code, reason }       — close the connection
 *
 * A control frame may legally sit BETWEEN two fragments of a message (§5.4) and
 * must not disturb the message being assembled. That is what the first branch
 * returns early for, and what the suite interleaves a ping to prove.
 */
export function createAssembler(max = MAX_MESSAGE_BYTES) {
  let opcode = 0;
  let chunks = [];
  let size = 0;

  return function push(frame) {
    if ((frame.opcode & 0x08) !== 0) {
      return { kind: "control", opcode: frame.opcode, payload: frame.payload };
    }

    if (frame.opcode === OP_CONTINUATION) {
      if (chunks.length === 0) {
        return { kind: "error", code: CLOSE_PROTOCOL, reason: "continuation with nothing to continue" };
      }
    } else {
      if (chunks.length > 0) {
        return { kind: "error", code: CLOSE_PROTOCOL, reason: "a new message began mid-message" };
      }
      opcode = frame.opcode;
    }

    size += frame.payload.length;
    if (size > max) {
      chunks = [];
      size = 0;
      return { kind: "error", code: CLOSE_TOO_BIG, reason: "message over the size cap" };
    }
    chunks.push(frame.payload);
    if (!frame.fin) return { kind: "partial" };

    const payload = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    chunks = [];
    size = 0;
    return { kind: "message", opcode, payload };
  };
}

/**
 * Rooms. In memory, like the `events` ring buffer above, and gone on restart.
 *
 * A hub restart loses every room and every log. Said here rather than
 * discovered later: the log is a convenience for a client that joins late, not
 * a database. A client that cannot rebuild the document from its own copy after
 * a hub restart was already broken; this is not the thing that broke it.
 *
 * name -> { log: Buffer[], bytes, sockets: Set<conn>, used: epoch ms }
 */
const rooms = new Map();
/** Every live upgraded socket, joined or not. Reported by /healthz. */
const wsClients = new Set();

/** Write one frame, and cut loose a socket that has stopped draining. */
function wsSend(conn, opcode, payload) {
  const socket = conn.socket;
  if (socket.destroyed || socket.writableEnded) return false;
  socket.write(encodeFrame(opcode, payload));
  if (socket.writableLength > WS_MAX_BUFFERED_BYTES) {
    console.error("zevet: dropping a ws client that stopped draining");
    socket.destroy();
    return false;
  }
  return true;
}

function wsClose(conn, code, reason = "") {
  // §5.5: a control frame payload is at most 125 bytes, two of which are the code.
  const text = Buffer.from(reason, "utf8").subarray(0, 123);
  const body = Buffer.allocUnsafe(2 + text.length);
  body.writeUInt16BE(code, 0);
  text.copy(body, 2);
  if (conn.socket.destroyed) return;
  conn.socket.write(encodeFrame(OP_CLOSE, body));
  conn.socket.end();
  // §7.1.1 says the server may close the underlying connection once it has sent
  // a close frame, and a peer that answers nothing would otherwise hold a
  // half-closed socket here for as long as it liked. unref'd, so this cannot be
  // the thing keeping the process alive.
  setTimeout(() => conn.socket.destroy(), 10_000).unref();
}

function forgetConn(conn) {
  wsClients.delete(conn);
  const room = rooms.get(conn.room);
  if (!room) return;
  room.sockets.delete(conn);
  // Empty AND with nothing to say: nobody can want it back. A room that still
  // holds a log is kept, because whoever closed the lid is going to open it
  // again — that is what the log is for.
  if (room.sockets.size === 0 && room.log.length === 0) rooms.delete(conn.room);
}

/** Forget the least recently used room nobody is sitting in. False if there is none. */
function evictIdleRoom() {
  let victimName = null;
  let victimUsed = Infinity;
  for (const [name, room] of rooms) {
    if (room.sockets.size > 0) continue;
    if (room.used < victimUsed) {
      victimName = name;
      victimUsed = room.used;
    }
  }
  if (victimName === null) return false;
  rooms.delete(victimName);
  return true;
}

function joinRoom(conn, name) {
  let room = rooms.get(name);
  if (!room) {
    if (rooms.size >= MAX_ROOMS && !evictIdleRoom()) {
      // Every room is occupied and the cap is reached. Refusing is the honest
      // answer: evicting a room people are sitting in would silently
      // desynchronise them, which is a worse failure than a failed join
      // because nobody would see it happen.
      wsClose(conn, CLOSE_TRY_LATER, "the hub is holding as many rooms as it will");
      return false;
    }
    room = { log: [], bytes: 0, sockets: new Set(), used: Date.now() };
    rooms.set(name, room);
  }
  room.used = Date.now();
  conn.room = name;
  conn.joined = true;

  // REPLAY, THEN SUBSCRIBE, WITH NOTHING IN BETWEEN.
  //
  // The ordering hazard is real, and is why this is one straight line with no
  // await in it. Subscribe first and a live update can be written between two
  // replayed entries. Put an await between the loop and the subscribe and an
  // update arriving in that gap goes to nobody and is lost. Because
  // `socket.write` only queues, and this function yields to the event loop at
  // no point, every replayed entry is queued before any live frame can be, and
  // a slow socket simply drains them in that same order.
  for (const blob of room.log) wsSend(conn, OP_BINARY, blob);
  room.sockets.add(conn);
  return true;
}

/**
 * A blob from one client to everyone else in the room, and into the log.
 *
 * THE LOG IS LOSSY BY DESIGN, AND THAT IS ONLY SAFE BECAUSE OF SNAPSHOTS.
 * Dropping the oldest entries of an update log would, on its own, leave a late
 * joiner permanently missing history it can never ask for again. What makes it
 * safe is the client's half of the contract: periodically send
 * {"type":"snapshot"} followed by one blob holding the whole state, which
 * replaces the log outright. If clients stop doing that, a late joiner to a
 * room past the cap gets an incomplete history — this cap and that client
 * behaviour are one design, not two.
 */
function relay(conn, blob) {
  const room = rooms.get(conn.room);
  if (!room) return;
  room.used = Date.now();

  if (conn.pendingSnapshot) {
    conn.pendingSnapshot = false;
    room.log = [blob];
    room.bytes = blob.length;
  } else {
    room.log.push(blob);
    room.bytes += blob.length;
    // `> 1` so a single blob larger than the cap survives: it is the newest and
    // most complete thing the room has, and dropping it to satisfy an
    // accounting rule would leave the room with nothing at all.
    while (room.bytes > ROOM_LOG_MAX_BYTES && room.log.length > 1) {
      room.bytes -= room.log.shift().length;
    }
  }

  // A snapshot is relayed like any other blob rather than being swallowed. The
  // hub cannot know whether a peer needs it, and guessing would be the hub
  // interpreting a payload — the one thing it is not allowed to do.
  //
  // Never back to the sender: it has the update already, and echoing one is how
  // a client that trusts the hub applies its own edit twice.
  for (const other of room.sockets) {
    if (other !== conn) wsSend(other, OP_BINARY, blob);
  }
}

/**
 * The only JSON this transport speaks. Two messages, both tiny.
 *
 * Returns false when the connection has been closed and the caller must stop.
 *
 * There is deliberately no "joined" acknowledgement: a client reads its replay
 * as ordinary binary frames. NOT VERIFIED against a real client — none exists
 * in this repo yet, so the join/snapshot shape is asserted only by the suite,
 * and the first real editor may well want an ack saying where the replay ends.
 */
function handleControlMessage(conn, payload) {
  let msg;
  try {
    msg = JSON.parse(payload.toString("utf8"));
  } catch {
    wsClose(conn, CLOSE_POLICY, "text frames must be JSON");
    return false;
  }
  if (!msg || typeof msg !== "object") {
    wsClose(conn, CLOSE_POLICY, "expected a JSON object");
    return false;
  }

  if (msg.type === "join") {
    if (conn.joined) {
      // One socket, one room. Moving rooms is a new socket — cheap, and it
      // keeps the replay-then-subscribe path above free of a second case
      // where a half-replayed socket is already in a set somewhere.
      wsClose(conn, CLOSE_POLICY, "already joined");
      return false;
    }
    const room = msg.room;
    // Opaque on purpose: a room name is the clients' business, and the hub does
    // not parse, namespace or normalise it. Length is bounded because memory is.
    if (typeof room !== "string" || room.length === 0 || room.length > MAX_ROOM_NAME) {
      wsClose(conn, CLOSE_POLICY, "join needs a room name of 1..256 characters");
      return false;
    }
    return joinRoom(conn, room);
  }

  if (msg.type === "snapshot") {
    if (!conn.joined) {
      wsClose(conn, CLOSE_POLICY, "join before sending a snapshot");
      return false;
    }
    conn.pendingSnapshot = true;
    return true;
  }

  wsClose(conn, CLOSE_POLICY, "unknown message type");
  return false;
}

/** Everything after a successful handshake: one socket's whole life. */
function attachWebSocket(socket, head) {
  const conn = { socket, room: null, joined: false, pendingSnapshot: false, sawTraffic: true };
  wsClients.add(conn);
  const assemble = createAssembler();
  let buffered = head && head.length ? Buffer.from(head) : EMPTY;
  let closing = false;

  // Liveness. A laptop that sleeps, or a NAT that forgets the mapping, leaves a
  // socket that is open to this process and dead to everyone else; without this
  // it sits in a room forever and its peers keep paying to write to it. Two
  // silent intervals, not one, so a client with nothing to say is not killed
  // for it — it only has to answer a ping.
  const ping = setInterval(() => {
    if (!conn.sawTraffic) {
      socket.destroy();
      return;
    }
    conn.sawTraffic = false;
    wsSend(conn, OP_PING, EMPTY);
  }, WS_PING_MS);
  ping.unref();

  socket.on("data", (chunk) => {
    if (closing) return;
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    const { frames, rest, error } = decodeFrames(buffered);
    buffered = rest;
    if (error) {
      closing = true;
      wsClose(conn, error.code, error.reason);
      return;
    }

    for (const frame of frames) {
      conn.sawTraffic = true;
      const out = assemble(frame);

      if (out.kind === "partial") continue;

      if (out.kind === "error") {
        closing = true;
        wsClose(conn, out.code, out.reason);
        return;
      }

      if (out.kind === "control") {
        if (out.opcode === OP_PING) {
          wsSend(conn, OP_PONG, out.payload);
          continue;
        }
        if (out.opcode === OP_PONG) continue;
        // §5.5.1: echo the close and stop. The peer's own status code goes back
        // as it arrived; inventing one here would hide what it told us.
        closing = true;
        if (!socket.destroyed) {
          socket.write(encodeFrame(OP_CLOSE, out.payload.subarray(0, 125)));
          socket.end();
        }
        return;
      }

      if (out.opcode === OP_TEXT) {
        if (!handleControlMessage(conn, out.payload)) {
          closing = true;
          return;
        }
        continue;
      }

      // Binary: opaque, and only once the socket is in a room.
      if (!conn.joined) {
        closing = true;
        wsClose(conn, CLOSE_POLICY, "join before sending data");
        return;
      }
      relay(conn, out.payload);
    }
  });

  const shut = () => {
    clearInterval(ping);
    forgetConn(conn);
  };
  socket.on("close", shut);
  socket.on("error", () => {
    shut();
    socket.destroy();
  });
}

const UPGRADE_STATUS = { 400: "Bad Request", 401: "Unauthorized", 429: "Too Many Requests" };

/** Refuse before the handshake, in the one language a socket mid-upgrade has. */
function denyUpgrade(socket, code, message) {
  const body = JSON.stringify({ error: message });
  const response =
    `HTTP/1.1 ${code} ${UPGRADE_STATUS[code] || "Bad Request"}\r\n` +
    "content-type: application/json\r\n" +
    `content-length: ${Buffer.byteLength(body)}\r\n` +
    "connection: close\r\n\r\n" +
    body;
  // end() and destroy only once it is flushed. `write()` then `destroy()` looks
  // the same on localhost and is not: destroy discards anything still queued, so
  // over a slow link the client gets a reset instead of the 401 telling it why.
  socket.end(response, () => socket.destroy());
}

server.on("upgrade", (req, socket, head) => {
  // A peer that resets during the handshake emits 'error' on a socket with no
  // listener, which in Node is an uncaught exception and a dead hub for
  // everyone. The http server's own error handling does not cover this socket
  // once it has been handed over.
  socket.on("error", () => socket.destroy());

  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return denyUpgrade(socket, 400, "unreadable request line");
  }
  if (url.pathname !== "/ws") return denyUpgrade(socket, 400, "no websocket here");

  // The SAME token check, the SAME failure counter and the SAME limit as every
  // HTTP route — reused rather than reimplemented, because a second copy of an
  // auth check is a second place for it to drift. `refuse()` itself cannot be
  // called here: it answers through a ServerResponse and an upgrade has none.
  // Note what is deliberately NOT done, matching `refuse()`: the limit is
  // consulted only on the failure path, so a teammate holding the right token
  // is never locked out by somebody else's brute force.
  if (!tokenFrom(req, url)) {
    authFailed(req, url);
    return denyUpgrade(socket, rateLimited(req) ? 429 : 401, "bad token");
  }

  const key = req.headers["sec-websocket-key"];
  if (
    String(req.headers.upgrade || "").toLowerCase() !== "websocket" ||
    typeof key !== "string" ||
    req.headers["sec-websocket-version"] !== "13"
  ) {
    return denyUpgrade(socket, 400, "not a version 13 websocket handshake");
  }

  const accept = createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "upgrade: websocket\r\n" +
      "connection: Upgrade\r\n" +
      `sec-websocket-accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  // `head` is whatever arrived glued to the handshake. A client that sends
  // frames before it has seen the 101 is within its rights, and those bytes are
  // already off the wire — dropping them loses a message for no reason.
  attachWebSocket(socket, head);
});

// Without this, restarting while the old hub still holds the port prints an
// unhandled EADDRINUSE stack trace instead of the plain message every other
// failure in this file bothers to give.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`zevet: port ${PORT} is already in use — another hub is probably still running.`);
    console.error("      Stop that one, or start this one with a different PORT.");
  } else {
    console.error(`zevet: the hub could not start — ${err.message}`);
  }
  process.exit(1);
});

// The frame codec above is pure, and the suite unit-tests it directly against
// hand-built buffers rather than only through a socket — which means this file
// has to be importable. An import that seized a port would break `node --test`,
// so the suite sets ZEVET_NO_LISTEN=1. The check is opt-OUT rather than the
// tidier "am I the entry module?" on purpose: the deployed hub is started in
// ways this file cannot enumerate (docker CMD, npm script, a supervisor), and a
// mis-detected entry point would mean a hub that starts, logs nothing and
// listens to nobody. Getting this wrong must not be able to break production.
if (process.env.ZEVET_NO_LISTEN !== "1") {
  server.listen(PORT, () => {
    // Report the port the OS actually gave us, not the one we asked for. With
    // PORT=0 those differ, and printing the request rather than the result is
    // how a process ends up unreachable at the address it just announced.
    const actual = server.address().port;
    console.log(`zevet hub listening on http://127.0.0.1:${actual}`);
    console.log(`open the board:  http://127.0.0.1:${actual}/?token=<ZEVET_TOKEN>`);
  });
}
