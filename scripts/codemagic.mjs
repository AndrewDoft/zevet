// Start the Codemagic macOS build and wait for it, from Windows.
//
//   node scripts/codemagic.mjs [--branch main] [--workflow macos] [--out codemagic-out] [--timeout-min 75]
//
// Token: CODEMAGIC_TOKEN, else the DPAPI file zevet-voice uses
// (%LOCALAPPDATA%/Masora/ReleaseSigning/codemagic-token.dpapi). Never printed.
// Saves every step log and artifact under --out. Exits non-zero unless the build finished.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const API = "https://api.codemagic.io";
const APP_ID = "6ab33101a3079c5deee322d8"; // AndrewDoft/zevet on Andrew's Codemagic account
const DONE = new Set(["finished", "failed", "canceled", "timeout", "skipped"]);
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };

function token() {
  if (process.env.CODEMAGIC_TOKEN) return process.env.CODEMAGIC_TOKEN;
  const file = path.join(process.env.LOCALAPPDATA, "Masora", "ReleaseSigning", "codemagic-token.dpapi");
  const ps = `$s = (Get-Content -Raw '${file}').Trim() | ConvertTo-SecureString; ` +
    "[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))";
  return execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim();
}

const headers = { "x-auth-token": token(), "content-type": "application/json" };
async function api(p, init = {}) {
  const r = await fetch(p.startsWith("http") ? p : API + p, { headers, ...init });
  if (!r.ok) throw new Error(`${init.method || "GET"} ${p}: ${r.status} ${await r.text()}`);
  return r;
}

const out = arg("--out", "codemagic-out");
const deadline = Date.now() + Number(arg("--timeout-min", "75")) * 60_000;
const { buildId } = await (await api("/builds", {
  method: "POST",
  body: JSON.stringify({ appId: APP_ID, workflowId: arg("--workflow", "macos"), branch: arg("--branch", "main") }),
})).json();
console.log(`build ${buildId}: https://codemagic.io/app/${APP_ID}/build/${buildId}`);

let b, last;
for (;;) {
  b = (await (await api(`/builds/${buildId}`)).json()).build;
  if (b.status !== last) console.log(`  ${new Date().toISOString().slice(11, 19)} ${(last = b.status)}`);
  if (DONE.has(b.status)) break;
  if (Date.now() > deadline) { console.error(`timed out waiting; build ${buildId} still ${b.status}`); process.exit(2); }
  await delay(30_000);
}

mkdirSync(out, { recursive: true });
for (const [i, s] of (b.buildActions || []).entries()) {
  console.log(`  step ${s.name}: ${s.status}`);
  // Script steps keep their log on the subaction, not the step.
  const url = s.logUrl || s.subactions?.[0]?.logUrl;
  if (url) writeFileSync(path.join(out, `${String(i).padStart(2, "0")}-${s.name.replace(/[^\w.-]+/g, "_").slice(0, 40)}.log`),
    await (await api(url)).text());
}
for (const a of b.artefacts || []) {
  const r = await fetch(a.url, { headers: { "x-auth-token": headers["x-auth-token"] } });
  if (!r.ok) throw new Error(`artifact ${a.name}: ${r.status}`);
  writeFileSync(path.join(out, a.name), Buffer.from(await r.arrayBuffer()));
  console.log(`  artifact ${a.name} (${a.size} bytes)`);
}
console.log(`status ${b.status}; logs and artifacts in ${out}`);
process.exit(b.status === "finished" ? 0 : 1);
