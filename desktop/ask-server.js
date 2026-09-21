"use strict";

// ask-server — the loopback side of the computer-use permission gate.
//
// zevet-mcp.js is a headless Node process with no UI of its own; it cannot
// ask a human anything. This is the other half: an HTTP server bound to
// 127.0.0.1 that the MCP server POSTs to before every screen/mouse/keyboard
// action, and whose answer main.js supplies by resolving `onPermit`'s
// promise once a person has looked at the board and clicked allow or deny.
//
// DEFAULT IS DENY ON TIMEOUT. A permission prompt nobody answered is not a
// "yes" — it is silence, and treating silence as approval turns "the user
// didn't see it" into "the agent's mouse and keyboard are free to use".
// Denying on timeout costs the agent one failed tool call it can retry or
// explain; allowing on timeout would hand control of the desktop to
// whichever process asked, unattended.

const http = require("node:http");
const { randomBytes, timingSafeEqual } = require("node:crypto");

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes: enough for a person to
  // notice a prompt on the board and answer it, short enough that a user who
  // stepped away doesn't leave the gate open indefinitely.
const MAX_BODY_BYTES = 64 * 1024;

function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== "string") return false;
  const host = hostHeader.split(":")[0].toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

/** Origin is absent on plain (non-browser) HTTP clients like our own MCP
 *  server's fetch() calls — that's fine, there is nothing to check. When it
 *  IS present, it must be loopback. */
function isLoopbackOrigin(originHeader) {
  if (typeof originHeader !== "string") return true;
  try {
    return isLoopbackHost(new URL(originHeader).hostname);
  } catch {
    return false;
  }
}

function tokenMatches(given, expected) {
  if (typeof given !== "string" || !given.length) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // lengths differ: not a timing
  // leak, since timingSafeEqual requires equal-length buffers anyway.
  return timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function normalizePermitResult(result) {
  if (result && typeof result === "object") {
    return { ok: !!result.ok, reason: result.reason ? String(result.reason) : undefined };
  }
  return { ok: !!result };
}

/**
 * Start the gate. Returns a Promise (the port is only known once bound) of
 * `{ url, token, close }`.
 *
 * `onPermit(request)` — where `request` is `{ tool, arguments }` from the
 * POST body — returns a Promise (or value) that resolves to `{ ok, reason? }`
 * or a plain boolean. It races against `timeoutMs` and loses to a deny if it
 * takes too long; a permit handler that throws also denies.
 */
function start({ onPermit, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof onPermit !== "function") {
    throw new Error("ask-server: start() requires an onPermit(request) function");
  }
  const token = randomBytes(24).toString("hex");

  const server = http.createServer((req, res) => {
    Promise.resolve()
      .then(async () => {
        if (!isLoopbackHost(req.headers.host) || !isLoopbackOrigin(req.headers.origin)) {
          json(res, 403, { ok: false, reason: "not loopback" });
          return;
        }

        const auth = req.headers.authorization || "";
        const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!tokenMatches(given, token)) {
          json(res, 401, { ok: false, reason: "bad token" });
          return;
        }

        if (req.method !== "POST" || req.url !== "/permit") {
          json(res, 404, { ok: false, reason: "not found" });
          return;
        }

        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          json(res, 413, { ok: false, reason: err.message });
          return;
        }

        let payload;
        try {
          payload = body ? JSON.parse(body) : {};
        } catch {
          json(res, 400, { ok: false, reason: "invalid JSON body" });
          return;
        }

        let timer;
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => resolve({ ok: false, reason: "timed out waiting for approval" }), timeoutMs);
        });

        let result;
        try {
          result = await Promise.race([Promise.resolve(onPermit(payload)), timeout]);
        } catch (err) {
          result = { ok: false, reason: `permission handler failed: ${err.message}` };
        } finally {
          clearTimeout(timer);
        }

        json(res, 200, normalizePermitResult(result));
      })
      .catch((err) => {
        try {
          json(res, 500, { ok: false, reason: err.message });
        } catch {
          // response already sent/closed; nothing left to do
        }
      });
  });

  return new Promise((resolveStart) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveStart({
        url: `http://127.0.0.1:${port}`,
        token,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

module.exports = { start, DEFAULT_TIMEOUT_MS };
