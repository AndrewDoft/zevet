// Shared rig for the suite: start a real hub on a real port, talk to it over
// real HTTP. Nothing here mocks the thing under test — a hub that only works
// against a fake socket is not evidence about the hub teammates will run.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Accounts } from "../hub/accounts.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Why the real-Electron suites (scripts/drive/drive.mjs) cannot run here, or
 * false when they can. They SKIP with this reason — a skip is reported as
 * skipped, never as passed, and never as a cancelled hook.
 */
export const NO_DRIVE = (() => {
  try {
    createRequire(path.join(ROOT, "package.json"))("playwright-core");
  } catch {
    return "playwright-core is not installed (run `npm ci` at the repo root)";
  }
  try {
    createRequire(path.join(ROOT, "desktop", "package.json"))("electron");
  } catch {
    return "no Electron binary (run `npm ci` in desktop/)";
  }
  return false;
})();

export const TOKEN = "test-token-0123456789abcdef";

/**
 * The contract change, in one place: a shared team token used to be enough
 * to read the board (see hub/server.mjs's teamFromSession and the incident
 * it documents). `state()` below now needs a real session by default, and
 * this is where every `startHub()` gets one, keyed by the hub's own base URL
 * so `state(base)` can find it without every call site naming a token.
 *
 * Not used when the caller already manages ZEVET_ACCOUNTS itself (team.test.mjs's
 * own seededHub(), team-credentials.test.mjs's hand-written file, etc.) —
 * those already seed the sessions they need, and a second, unrelated owner
 * dropped into the SAME file would just be a stray row nothing reads.
 */
const sessionByBase = new Map();
const DEFAULT_TEST_OWNER = { login: "zevet-test-owner", id: "test-owner-1" };

/**
 * Ports are assigned by the OS, not guessed.
 *
 * This used to hand out numbers from a random base. `node --test` runs test
 * FILES in parallel, each with its own copy of this module and its own random
 * base drawn from the same range, so two files eventually picked the same port
 * and one hub answered for the other. It failed about one run in three — which
 * is worse than failing every time, because flaky red teaches you to ignore
 * red. PORT=0 lets the kernel pick, and the hub prints what it got.
 */

/**
 * Starts the hub and resolves once it is genuinely answering, not once the
 * process exists. Polling /healthz rather than sleeping is the difference
 * between a suite that is slow and a suite that is flaky.
 */
export async function startHub(env = {}) {
  // Every test hub gets its own event log. Without this they share the repo's
  // var/events.jsonl: runs see each other's boards, the file grows forever,
  // and a restart test can never start empty. An explicit ZEVET_EVENTS wins,
  // which is how the persistence tests hand one file to two hubs in a row.
  const eventsDir = "ZEVET_EVENTS" in env
    ? null
    : mkdtempSync(path.join(tmpdir(), "zevet-hub-events-"));

  // Same idea for accounts: a caller that did not bring its own gets a
  // throwaway file seeded with one signed-in owner, so `state()` (below) has
  // a real session to authenticate the DEFAULT team's board reads with. An
  // Accounts instance reads its file once, at construction, so this has to
  // exist before the child process starts — there is no way to hand a
  // running hub a session after the fact.
  let accountsDir = null;
  let ownerSession = null;
  if (!("ZEVET_ACCOUNTS" in env)) {
    accountsDir = mkdtempSync(path.join(tmpdir(), "zevet-hub-accounts-"));
    const accountsFile = path.join(accountsDir, "accounts.json");
    const seed = new Accounts({ file: accountsFile });
    ownerSession = seed.signIn(DEFAULT_TEST_OWNER).token;
  }

  const child = spawn(process.execPath, [path.join(ROOT, "hub", "server.mjs")], {
    env: {
      ...process.env,
      ZEVET_TOKEN: TOKEN,
      PORT: "0",
      ...(eventsDir ? { ZEVET_EVENTS: path.join(eventsDir, "events.jsonl") } : {}),
      ...(accountsDir ? { ZEVET_ACCOUNTS: path.join(accountsDir, "accounts.json") } : {}),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  let stdout = "";
  child.stderr.on("data", (d) => stderr.push(d.toString()));
  child.stdout.on("data", (d) => {
    stdout += d.toString();
  });

  // Wait for the hub to SAY which port it got, then confirm it answers there.
  const deadline = Date.now() + 10000;
  let port = null;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`hub exited ${child.exitCode}: ${stderr.join("")}`);
    }
    const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
    if (m) {
      port = Number(m[1]);
      break;
    }
    if (Date.now() > deadline) throw new Error(`hub never announced a port: ${stderr.join("")}${stdout}`);
    await new Promise((r) => setTimeout(r, 20));
  }

  const base = `http://127.0.0.1:${port}`;
  for (;;) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) break;
    } catch {
      // not accepting connections yet
    }
    if (Date.now() > deadline) throw new Error(`hub never answered on ${port}: ${stderr.join("")}`);
    await new Promise((r) => setTimeout(r, 20));
  }

  if (ownerSession) sessionByBase.set(base, ownerSession);

  return {
    base,
    port,
    sessionToken: ownerSession,
    stderr: () => stderr.join(""),
    stdout: () => stdout,
    async stop() {
      child.kill();
      await new Promise((r) => child.once("exit", r));
      if (eventsDir) rmSync(eventsDir, { recursive: true, force: true });
      if (accountsDir) rmSync(accountsDir, { recursive: true, force: true });
      sessionByBase.delete(base);
    },
  };
}

export function tempDir(prefix = "zevet-test-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    dir,
    // maxRetries, because Windows. A child that has only just exited can still
    // hold a handle on its cwd for a few milliseconds, and rmSync then throws
    // ENOTEMPTY -- a cleanup failure that fails the test around it and reads
    // exactly like a real defect. Retrying is the documented remedy. The window
    // here is deliberately wide: runner AV software has held a tempdir for more
    // than the previous 30x100ms budget (observed on the build runner, 2026-09).
    cleanup: () =>
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 120,
        retryDelay: 250,
      }),
  };
}

/** Runs a client script with stdin, capturing stdout and stderr separately. */
export function runScript(script, { stdin = "", env = {}, cwd = ROOT, args = [] } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "client", script), ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
    child.stdin.end(stdin);
  });
}

export function post(base, body, token = TOKEN) {
  return fetch(`${base}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zevet-token": token },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * `token` defaults to the session `startHub()` auto-seeded for this exact
 * base URL (see sessionByBase above) — /api/state now requires a real
 * session, not just the shared TOKEN. Falls back to TOKEN only for a hub
 * that manages its own accounts file (no auto-seed happened), so a caller
 * testing "no session at all" can still get that by passing one explicitly.
 */
/** The session `startHub()` auto-seeded for this base, if any — for test
 *  files that build their own ws/HTTP calls instead of going through
 *  `state()`/`post()` (hub-ws.test.mjs, hub-events.test.mjs's SSE clients). */
export function sessionFor(base) {
  return sessionByBase.get(base);
}

export async function state(base, token) {
  const t = token !== undefined ? token : (sessionByBase.get(base) ?? TOKEN);
  const res = await fetch(`${base}/api/state?token=${encodeURIComponent(t)}`);
  return { status: res.status, body: res.ok ? await res.json() : await res.json().catch(() => null) };
}
