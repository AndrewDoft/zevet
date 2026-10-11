// Updates while zevet is NOT running (Andrew, 2026-10-11: "this stuff just needs to update in the background, no
// while running"). Electron-free; every side effect is injected. Mirrors masora2 apps/desktop/shell/background-update.js (D-794).
//
// The in-app updaters only run while the app does, so a release published after a quit waited for the next launch.
// A per-user OS job (Windows Scheduled Task, macOS LaunchAgent) now starts `zevet --background-update` hourly and
// at logon. That mode drives the SAME verifiers as the app: the payload client (signed pulse, hash-bound manifest)
// and the AppUpdater (signed feed, sha256, Authenticode, rollback.json). Never a second, weaker path.
//
//   payload  checked, downloaded and staged. The next launch applies it before the first window (bootstrap.js
//            startPayload), so opening zevet after a release runs the release. Needs no elevation.
//   shell    the installer, silently, WITHOUT --force-run (the app must not open). Only where the install directory is
//            writable by this user. A per-machine install under Program Files is not: its installer would raise a UAC
//            prompt on a desktop nobody is looking at, so the job leaves it, says so in the log, and the payload path
//            keeps the app current. The running app still idle-installs the shell itself (idle-install.js).
//
// Nothing here may be visible: the task runs a GUI-subsystem exe (no console), the mode opens no window, every child
// is spawned with windowsHide. Every run logs one start line and one outcome line, whatever happens.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BACKGROUND_ARG = "--background-update";
const REGISTER_ARG = "--register-background-update";
const TASK_NAME = "Zevet Background Update";
const AGENT_LABEL = "com.andrewdoft.zevet.background-update";
const ATTEMPT_FILE = "background-update-attempts.json";
/** One installer attempt per version per day: a failing installer is not retried hourly. */
const ATTEMPT_GAP_MS = 24 * 60 * 60 * 1000;
const EVERY_SECONDS = 60 * 60;

const isBackgroundLaunch = (argv) => (argv || []).includes(BACKGROUND_ARG);
const isRegisterLaunch = (argv) => (argv || []).includes(REGISTER_ARG);

/**
 * May the installer `version` be run now? Pure. `lockHeld` is the single-instance lock: false means zevet is running
 * (or starting) and owns the update. `offerable` is rollback.offerable(version).
 */
/** (app-update.js is required here, not at load: bootstrap.js loads this file on every launch and tests stub that one.) */
function decide({ lockHeld, running, version, offerable, attempt, now }) {
  const { compareVersions } = require("./app-update.js");
  if (!lockHeld) return { install: false, reason: "running" };
  if (!version) return { install: false, reason: "no-update" };
  if (compareVersions(version, running) <= 0) return { install: false, reason: "not-newer" };
  if (!offerable) return { install: false, reason: "withdrawn" };
  if (attempt && attempt.version === version && now - attempt.at < ATTEMPT_GAP_MS) return { install: false, reason: "attempted-today" };
  return { install: true, reason: "newer" };
}

function readAttempt(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, ATTEMPT_FILE), "utf8")); } catch { return null; }
}

function writeAttempt(dir, version, now, log) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ATTEMPT_FILE), JSON.stringify({ version, at: now }));
  } catch (err) { log(`could not record the attempt: ${err.message}`); }
}

/** Can this user write the install directory? A probe file, because Windows ACLs are not what fs.access reports. */
function installDirWritable(dir, fsImpl = fs) {
  const probe = path.join(dir, `.zevet-write-probe-${process.pid}`);
  try {
    fsImpl.writeFileSync(probe, "");
    fsImpl.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function payloadStep({ payload, log }) {
  try {
    const r = await payload.check();
    const staged = payload.staged();
    if (r.status === "staged") return `staged ${r.build}`;
    if (staged) return `staged ${staged.build} (waiting for the next launch)`;
    return r.status === "none" ? "current" : `${r.status}${r.build ? ` ${r.build}` : ""}${r.reason ? ` (${r.reason})` : ""}`;
  } catch (err) {
    log(`payload check failed: ${err && err.message}`);
    return `error: ${err && err.message}`;
  }
}

async function shellStep({ lockHeld, updater, rollback, running, dir, canInstall, aborted, now, log }) {
  if (!canInstall()) return "needs-elevation (install directory is not writable by this user; the app idle-installs it, the payload keeps it current)";
  let state;
  try { state = await updater.check(); } catch (err) { log(`installer check failed: ${err.message}`); return `error: ${err.message}`; }
  const version = state.phase === "ready" ? state.version : null;
  if (!version && state.phase === "error") log(`installer feed: ${state.error}`);
  const d = decide({ lockHeld, running, version, offerable: !rollback || rollback.offerable(version), attempt: readAttempt(dir), now: now() });
  if (!d.install) return version ? `${version} skipped: ${d.reason}` : d.reason === "no-update" ? "current" : d.reason;
  if (aborted()) return `${version} skipped: zevet was launched`;
  // Recorded BEFORE the attempt: a process killed by its own installer cannot record.
  writeAttempt(dir, version, now(), log);
  try {
    log(`${running} -> ${version}: running the installer silently`);
    const r = updater.installQuiet();
    return r && r.ok === false ? `failed: ${r.error}` : `installing ${version}`;
  } catch (err) {
    log(`installer failed: ${err.message}`);
    return `failed: ${err.message}`;
  }
}

/**
 * One background run. `payload` is the payload client, `updater` an AppUpdater, `rollback` the update-rollback.js
 * object, `lockHeld` the result of the single-instance lock, `aborted()` true once a person launched the app
 * meanwhile, `sweep()` removes old payload trees. Never throws. Logs one start and one outcome line.
 * Returns { payload, shell } outcome strings; shell is "installing <v>" when an installer was started.
 */
async function runBackgroundUpdate({ lockHeld, payload, updater, rollback, running, build = running, dir, canInstall = () => true, sweep = async () => null, now = Date.now, aborted = () => false, log = () => {} }) {
  log(`start: shell ${running}, payload ${build}, ${lockHeld ? "no zevet running" : "zevet is running"}`);
  const out = { payload: "skipped", shell: "skipped" };
  try {
    if (!lockHeld) {
      out.payload = out.shell = "zevet is running; it updates itself";
      return out;
    }
    out.payload = await payloadStep({ payload, log });
    try { await sweep(); } catch (err) { log(`old payload cleanup failed: ${err && err.message}`); }
    out.shell = await shellStep({ lockHeld, updater, rollback, running, dir, canInstall, aborted, now, log });
    return out;
  } catch (err) {
    log(`crashed: ${err && err.stack || err}`);
    out.shell = out.shell === "skipped" ? `error: ${err && err.message}` : out.shell;
    return out;
  } finally {
    log(`outcome: payload ${out.payload}; shell ${out.shell}`);
  }
}

// ── Windows Scheduled Task ───────────────────────────────────────────────────────────────────────────────────────

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Task Scheduler XML. Per-user, LeastPrivilege: no admin, no UAC. Hourly (repeating forever) and at logon;
 * `logon: false` drops the logon trigger, the fallback when Windows refuses it to a non-elevated registrant
 * (StartWhenAvailable then runs a missed hour at the next opportunity).
 */
function taskXml({ exe, user, logon = true }) {
  const u = xmlEscape(user);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Installs a newer signed zevet release while zevet is not running. Invisible; no prompts.</Description>
  </RegistrationInfo>
  <Triggers>${logon ? `
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${u}</UserId>
      <Delay>PT2M</Delay>
    </LogonTrigger>` : ""}
    <TimeTrigger>
      <Repetition>
        <Interval>PT${EVERY_SECONDS / 3600}H</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${u}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(exe)}</Command>
      <Arguments>${BACKGROUND_ARG}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** schtasks wants the XML file as UTF-16 LE with a BOM (it is declared so above). */
const utf16 = (xml) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
const createArgs = (xmlFile) => ["/Create", "/TN", TASK_NAME, "/XML", xmlFile, "/F"];
const queryArgs = () => ["/Query", "/TN", TASK_NAME];
const deleteArgs = () => ["/Delete", "/TN", TASK_NAME, "/F"];

const windowsUser = (env = process.env) => (env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : String(env.USERNAME || os.userInfo().username));

/**
 * Create or refresh the Windows task. Idempotent: a stored hash of the XML plus a successful query means nothing
 * to do. `run(cmd, args)` -> { code } must spawn hidden. `dryRun` returns what it WOULD run and runs nothing.
 */
async function ensureWindowsTask({ exe, user = windowsUser(), dir, run, writeFile = fs.writeFileSync, tmpdir = os.tmpdir(), log = () => {}, dryRun = false }) {
  const variants = [true, false].map((logon) => taskXml({ exe, user, logon }));
  const hash = crypto.createHash("sha256").update(variants[0]).update(exe).digest("hex");
  const hashFile = path.join(dir, "background-task.json");
  if (dryRun) {
    return { commands: [["schtasks.exe", ...queryArgs()], ["schtasks.exe", ...createArgs("<tmp>.xml")]], xml: variants[0], fallbackXml: variants[1] };
  }
  let stored = null;
  try { stored = JSON.parse(fs.readFileSync(hashFile, "utf8")).hash; } catch { /* first run */ }
  if (stored === hash && (await run("schtasks.exe", queryArgs())).code === 0) return "unchanged";
  for (const [i, xml] of variants.entries()) {
    const file = path.join(tmpdir, `zevet-background-task-${process.pid}.xml`);
    try {
      writeFile(file, utf16(xml));
      const r = await run("schtasks.exe", createArgs(file));
      if (r.code === 0) {
        try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(hashFile, JSON.stringify({ hash })); } catch (err) { log(`could not record the task hash: ${err.message}`); }
        log(`scheduled task registered${i ? " (without the logon trigger)" : ""}`);
        return i ? "registered-no-logon" : "registered";
      }
      log(`schtasks /Create exited ${r.code}${r.stderr ? `: ${String(r.stderr).trim()}` : ""}`);
    } catch (err) {
      log(`schtasks /Create failed: ${err.message}`);
    } finally {
      try { fs.rmSync(file, { force: true }); } catch { /* temp */ }
    }
  }
  return "failed";
}

// ── macOS LaunchAgent ────────────────────────────────────────────────────────────────────────────────────────────

/** User-level LaunchAgent: hourly and at login. UNVERIFIED on a Mac (none here); the text is what the tests pin. */
function agentPlist({ exe }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(exe)}</string>
    <string>${BACKGROUND_ARG}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${EVERY_SECONDS}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
</dict>
</plist>
`;
}

const agentPath = (home = os.homedir()) => path.join(home, "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);

async function ensureMacAgent({ exe, home = os.homedir(), uid = process.getuid && process.getuid(), run, log = () => {}, dryRun = false }) {
  const file = agentPath(home);
  const plist = agentPlist({ exe });
  const commands = [["launchctl", "bootout", `gui/${uid}/${AGENT_LABEL}`], ["launchctl", "bootstrap", `gui/${uid}`, file]];
  if (dryRun) return { file, plist, commands };
  let current = null;
  try { current = fs.readFileSync(file, "utf8"); } catch { /* none yet */ }
  if (current === plist) return "unchanged";
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, plist);
    await run(commands[0][0], commands[0].slice(1));   // not loaded yet is an error nobody needs
    const r = await run(commands[1][0], commands[1].slice(1));
    if (r.code !== 0) { log(`launchctl bootstrap exited ${r.code}`); return "failed"; }
    log("launch agent registered");
    return "registered";
  } catch (err) {
    log(`launch agent failed: ${err.message}`);
    return "failed";
  }
}

/** Register the OS job for this platform. Never throws. */
async function ensureBackgroundJob({ platform = process.platform, exe = process.execPath, ...rest }) {
  try {
    if (platform === "win32") return await ensureWindowsTask({ exe, ...rest });
    if (platform === "darwin") return await ensureMacAgent({ exe, ...rest });
    return "unsupported";
  } catch (err) {
    if (rest.log) rest.log(`background job registration failed: ${err.message}`);
    return "failed";
  }
}

/**
 * Should THIS process own the OS job? Only a real packaged install: a dev Electron, a test rig on a throwaway profile
 * or a CI runner registering itself would repoint (or create) the job on a machine that has a real zevet.
 */
function mayRegister({ isPackaged, execPath, env = process.env, misplaced }) {
  if (!isPackaged) return false;
  if (env.ZEVET_ALLOW_MULTI === "1" || env.ZEVET_PAYLOAD_ROOT || env.ZEVET_NO_BACKGROUND_UPDATE === "1" || env.CI) return false;
  return !(misplaced && misplaced(execPath));
}

if (require.main === module) {
  // Dry run: prints what would be registered; creates nothing. node background-update.js <exe> [win32|darwin]
  const exe = process.argv[2] || "C:\\Users\\you\\AppData\\Local\\Programs\\zevet\\zevet.exe";
  const platform = process.argv[3] || process.platform;
  ensureBackgroundJob({ platform, exe, dryRun: true, user: "PC\\you", home: "/Users/you", uid: 501, dir: "-" }).then((r) => {
    for (const c of r.commands) console.log(c.join(" "));
    console.log(r.xml || r.plist);
  });
}

module.exports = {
  BACKGROUND_ARG, REGISTER_ARG, TASK_NAME, AGENT_LABEL, ATTEMPT_FILE, ATTEMPT_GAP_MS,
  isBackgroundLaunch, isRegisterLaunch, decide, installDirWritable, runBackgroundUpdate, mayRegister,
  taskXml, agentPlist, agentPath, windowsUser, deleteArgs, ensureBackgroundJob,
};
