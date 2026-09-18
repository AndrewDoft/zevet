// Shared rig for the suite: start a real hub on a real port, talk to it over
// real HTTP. Nothing here mocks the thing under test — a hub that only works
// against a fake socket is not evidence about the hub teammates will run.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TOKEN = "test-token-0123456789abcdef";

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
  const child = spawn(process.execPath, [path.join(ROOT, "hub", "server.mjs")], {
    env: { ...process.env, ZEVET_TOKEN: TOKEN, PORT: "0", ...env },
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

  return {
    base,
    port,
    stderr: () => stderr.join(""),
    async stop() {
      child.kill();
      await new Promise((r) => child.once("exit", r));
    },
  };
}

export function tempDir(prefix = "zevet-test-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Runs a client script with stdin, capturing stdout and stderr separately. */
export function runScript(script, { stdin = "", env = {}, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "client", script)], {
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

export async function state(base, token = TOKEN) {
  const res = await fetch(`${base}/api/state?token=${encodeURIComponent(token)}`);
  return { status: res.status, body: res.ok ? await res.json() : await res.json().catch(() => null) };
}
