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
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.ZEVET_TOKEN || "";
const MAX_EVENTS = Number(process.env.ZEVET_MAX_EVENTS || 2000);
// Two agents touching one file inside this window is worth a warning. Ten
// minutes is a guess we can move; it is deliberately longer than a turn.
const COLLISION_WINDOW_MS = Number(process.env.ZEVET_COLLISION_WINDOW_MS || 10 * 60 * 1000);
const IDLE_AFTER_MS = 90 * 1000;

/**
 * Tools that change a file. Reading the same file as a teammate is not a
 * collision — it is two people doing their jobs.
 */
const WRITING_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "Update", "Create"]);

if (!TOKEN) {
  console.error("zevet: refusing to start without ZEVET_TOKEN set.");
  console.error("      Pick a long random string and give the same one to every teammate.");
  process.exit(1);
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
  "uninstall.mjs",
  "doctor.mjs",
];

/** The self-hosted faces. All SIL OFL-1.1; see hub/public/fonts/LICENSE. */
const FONT_FILES = [
  "jost-variable.woff2",
  "ibm-plex-mono-400.woff2",
  // Kept so an older cached board does not 404 its own type mid-session.
  "hanken-grotesk-variable.woff2",
  "frank-ruhl-libre-variable.woff2",
];

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

function tokenOk(given) {
  if (typeof given !== "string" || given.length !== TOKEN.length) return false;
  try {
    return timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));
  } catch {
    return false;
  }
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
  const actors = new Map();
  for (const e of events) {
    const a = actors.get(e.actor) || { actor: e.actor, hue: null, lastTs: 0, lastEvent: null, turns: 0, tools: 0 };
    a.lastTs = Math.max(a.lastTs, e.ts);
    if (!a.lastEvent || e.ts >= a.lastEvent.ts) a.lastEvent = e;
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

  return { now, roster, collisions, events: events.slice(-300), windowMs: COLLISION_WINDOW_MS, idleAfterMs: IDLE_AFTER_MS };
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");


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
    const evt = {
      id: randomUUID(),
      ts: Date.now(),
      actor: String(parsed.actor || "unknown").slice(0, 40),
      repo: String(parsed.repo || "").slice(0, 120),
      branch: String(parsed.branch || "").slice(0, 120),
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
