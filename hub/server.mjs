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

if (!TOKEN) {
  console.error("zevet: refusing to start without ZEVET_TOKEN set.");
  console.error("      Pick a long random string and give the same one to every teammate.");
  process.exit(1);
}

const CLIENT_DIR = path.join(HERE, "..", "client");
/** Exactly what the update channel will serve. An allowlist, not a directory listing. */
const CLIENT_FILES = ["hook.mjs", "install.mjs", "updater.mjs"];

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

function record(evt) {
  events.push(evt);
  while (events.length > MAX_EVENTS) events.shift();
  const frame = `event: activity\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of listeners) {
    try {
      res.write(frame);
    } catch (err) {
      // A listener that cannot be written to is gone. Drop it and say so —
      // silence here is how a dashboard appears live while receiving nothing.
      console.error(`zevet: dropping dead listener (${err && err.code})`);
      listeners.delete(res);
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

  // Collisions: one file, two or more people, both inside the window.
  const byTarget = new Map();
  for (const e of events) {
    if (!e.target || e.kind !== "tool") continue;
    if (now - e.ts > COLLISION_WINDOW_MS) continue;
    const seen = byTarget.get(e.target) || new Map();
    const prev = seen.get(e.actor) || 0;
    seen.set(e.actor, Math.max(prev, e.ts));
    byTarget.set(e.target, seen);
  }
  const collisions = [];
  for (const [target, seen] of byTarget) {
    if (seen.size < 2) continue;
    collisions.push({
      target,
      actors: [...seen.entries()].map(([actor, ts]) => ({ actor, ts })).sort((x, y) => y.ts - x.ts),
      lastTs: Math.max(...seen.values()),
    });
  }
  collisions.sort((x, y) => y.lastTs - x.lastTs);

  return { now, roster, collisions, events: events.slice(-300), windowMs: COLLISION_WINDOW_MS, idleAfterMs: IDLE_AFTER_MS };
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
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
    if (!tokenOk(req.headers["x-zevet-token"])) return json(res, 401, { error: "bad token" });
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
    };
    record(evt);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/state") {
    if (!tokenOk(url.searchParams.get("token"))) return json(res, 401, { error: "bad token" });
    return json(res, 200, snapshot());
  }

  if (url.pathname === "/events") {
    if (!tokenOk(url.searchParams.get("token"))) return json(res, 401, { error: "bad token" });
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
    if (!tokenOk(req.headers["x-zevet-token"])) return json(res, 401, { error: "bad token" });
    try {
      return json(res, 200, await buildManifest());
    } catch (err) {
      return json(res, 500, { error: `cannot build manifest: ${err.message}` });
    }
  }

  if (url.pathname.startsWith("/dist/")) {
    if (!tokenOk(req.headers["x-zevet-token"])) return json(res, 401, { error: "bad token" });
    // Allowlist, not a path join against user input: "/dist/../../.env" is a
    // request somebody will eventually make.
    const name = decodeURIComponent(url.pathname.slice("/dist/".length));
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

  if (url.pathname === "/" || url.pathname === "/index.html") {
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

server.listen(PORT, () => {
  console.log(`zevet hub listening on http://127.0.0.1:${PORT}`);
  console.log(`open the board:  http://127.0.0.1:${PORT}/?token=<ZEVET_TOKEN>`);
});
