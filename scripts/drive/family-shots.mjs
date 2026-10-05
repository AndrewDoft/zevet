// Dev-only: screenshots of setup + the Family panel against a local hub, a fake
// Masora and fixture files. Usage: node scripts/drive/family-shots.mjs <outdir>
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHub, ROOT } from "../../test/helpers.mjs";

const out = path.resolve(process.argv[2] || "shots");
mkdirSync(out, { recursive: true });
const DRIVE = path.join(ROOT, "scripts", "drive", "drive.mjs");
const drive = (...a) => JSON.parse(execFileSync(process.execPath, [DRIVE, ...a], { encoding: "utf8", timeout: 60000 }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SECRET = "ab".repeat(24);
const dir = mkdtempSync(path.join(tmpdir(), "zevet-shots-"));
const fam = path.join(dir, "family");
mkdirSync(fam);
const masora = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (req.url === "/healthz") return res.end(JSON.stringify({ ok: true, runtime: "masora-desktop" }));
    if (req.url === "/api/family/pair") return res.end(JSON.stringify({ token: "fake-token", member_email: "andrew@example.com" }));
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise((r) => masora.listen(0, "127.0.0.1", r));
const web = `http://127.0.0.1:${masora.address().port}`;
const now = () => new Date().toISOString();
writeFileSync(path.join(fam, "masora.json"), JSON.stringify({ web, api: web, runtime: "masora-desktop", version: "0.3.3", updated_at: now() }));
writeFileSync(path.join(fam, "family.key"), "fixture-key");
const voice = (o = {}) =>
  writeFileSync(path.join(fam, "voice.json"), JSON.stringify({ app: "voice", version: "0.1.9", pid: 1, updated_at: now(), running: true, masora: { connected: false, member_email: null }, ...o }));
voice();

const hub = await startHub({
  ZEVET_SECRET: SECRET,
  ZEVET_TOKEN: "",
  ZEVET_GITHUB_CLIENT_ID: "x",
  ZEVET_ACCOUNTS: path.join(dir, "accounts.json"),
});
process.env.MASORA_FAMILY_DIR = fam;
process.env.ZEVET_MASORA_URL = web;
try {
  drive("launch");
  await sleep(1500);
  const shot = (n, w = 0) => drive("screenshot", path.join(out, n), "--window", String(w));
  shot("01-setup-create.png");
  drive("type", "#teamName", "metrodora");
  drive("click", "#other summary");
  drive("type", "#hub", hub.base);
  shot("02-setup-other-hub.png");
  drive("click", "#modeJoin");
  drive("type", "#teamName", "nobody");
  drive("click", "#google");
  await sleep(1500);
  shot("03-setup-join-noteam.png");
  drive("click", "#modeCreate");
  drive("type", "#teamName", "Metrodora");
  await fetch(`${hub.base}/team/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "metrodora" }) });
  drive("click", "#gh");
  await sleep(1500);
  shot("04-setup-taken.png");
  drive("click", "#manual summary");
  drive("type", "#token", SECRET);
  drive("type", "#actor", "andrew");
  drive("click", "#check");
  await sleep(1500);
  shot("05-setup-connected.png");
  drive("click", "#finish");
  await sleep(6000);
  const wins = drive("windows");
  console.log(JSON.stringify(wins).slice(0, 300));
  const bw = 0;
  drive("click", "#settingsLink");
  await sleep(800);
  drive("click", "text=Family");
  await sleep(2500);
  shot("06-settings-family.png", bw);
  drive("click", ".fchip[data-state=Update]");
  await sleep(800);
  shot("07-card-update.png", bw);
  drive("click", ".fcard .sheet-close");
  rmSync(path.join(fam, "voice.json"));
  await sleep(4500);
  drive("click", ".fchip[data-state=Install]");
  await sleep(4000);
  shot("08-card-install.png", bw);
} finally {
  try {
    drive("close");
  } catch {}
  await hub.stop();
  masora.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
