// zevet hub — the one process the three of us point at.
//
// Zero dependencies on purpose. Every teammate has to run or reach this, on
// Windows and macOS alike, and "npm install failed on my machine" is exactly
// the class of problem this tool exists to make visible rather than to cause.
// Server-Sent Events carry the live feed: the dashboard only ever listens, so
// a full duplex socket would buy nothing and cost a dependency.
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
const CLIENT_FILES = ["hook.mjs", "install.mjs", "updater.mjs", "detect.mjs", "install-codex.mjs"];

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
    return json(res, 200, { ok: true, events: events.length, listeners: listeners.size });
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

server.listen(PORT, () => {
  // Report the port the OS actually gave us, not the one we asked for. With
  // PORT=0 those differ, and printing the request rather than the result is
  // how a process ends up unreachable at the address it just announced.
  const actual = server.address().port;
  console.log(`zevet hub listening on http://127.0.0.1:${actual}`);
  console.log(`open the board:  http://127.0.0.1:${actual}/?token=<ZEVET_TOKEN>`);
});
