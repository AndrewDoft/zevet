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

/** A port nobody else in this suite is using. */
let nextPort = 8900 + Math.floor(Math.random() * 400);
export function freePort() {
  return nextPort++;
}

/**
 * Starts the hub and resolves once it is genuinely answering, not once the
 * process exists. Polling /healthz rather than sleeping is the difference
 * between a suite that is slow and a suite that is flaky.
 */
export async function startHub(env = {}) {
  const port = freePort();
  const child = spawn(process.execPath, [path.join(ROOT, "hub", "server.mjs")], {
    env: { ...process.env, ZEVET_TOKEN: TOKEN, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (d) => stderr.push(d.toString()));
  child.stdout.on("data", () => {});

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`hub exited ${child.exitCode}: ${stderr.join("")}`);
    }
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`hub never answered: ${stderr.join("")}`);
    await new Promise((r) => setTimeout(r, 40));
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
