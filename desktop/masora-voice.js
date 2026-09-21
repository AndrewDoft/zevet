/**
 * Masora Voice, from zevet's side of the machine.
 *
 * Masora Voice is a SEPARATE desktop app — a Python tray app that registers a
 * global hotkey, records while it is held, transcribes locally and types the
 * text into whatever field has focus. Its "flow bar" is a native Win32 layered
 * window drawn by that process (masora_dictation/ui/flowbar.py), not anything
 * a web view can render. So zevet cannot draw the bar, and does not try: what
 * it can do is make sure the app that owns the bar is running.
 *
 * Andrew: "when someone hits the microphone, it turns on the masora voice flow
 * bar. if masora voice is not downloaded, you get a pop up to download it."
 *
 * ⚠️ THE BAR IS VISIBLE WHENEVER THE APP RUNS, which is what makes this work
 * at all. masora_dictation/ui/flowbar.py's visibility test is
 *
 *     visible = active or (st.show_at_rest and not self._fullscreen)
 *
 * and `show_at_rest` comes from `BarConfig.show`, which defaults to True
 * (masora_dictation/config.py). `bar.start()` runs once at startup in
 * __main__.py. So "turn the flow bar on" IS "start the app".
 *
 * ⚠️ IT CAN START A RECORDING TOO, and that had to be built on the other
 * side first. When this file was written there was no way in: masora_dictation
 * had no socket, no named pipe, no watched file and no admin verb for it, and
 * synthesising the chord does not work either — hotkey/windows.py's
 * `should_process()` drops LLKHF_INJECTED events unless the app was started
 * with `--accept-injected`, which its own help calls "e2e tests only". zevet
 * 0.2.24 shipped the consequence: a mic that raised the bar and then told you
 * to press a key yourself, which reads as a broken button.
 *
 * masora2-dictation D-DEPLOY-10 added `Local\MasoraDictation-<hash>-record`,
 * the sibling of the quit event, set by `masora_dictation.admin record`. It
 * posts Masora Voice's own `toggle`, so the same signal starts a hands-free
 * dictation and then finishes it.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");

/** The GUI launcher inside an installed bundle. install.ps1 lays the versioned
 *  bundle out with a stable `launcher/` directory, which is why this is not
 *  version-dependent. */
const EXE = "Masora Voice.exe";
/** The same bundle's console launcher, which forwards argv to a module. Verified
 *  on a real install: `"Masora Voice Console.exe" -m masora_dictation.admin status`
 *  printed "running (supervised)". */
const CONSOLE_EXE = "Masora Voice Console.exe";

/**
 * Where install.ps1 puts it: per-user by default, all-users optionally.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
function candidates(env) {
  const out = [];
  const local = env.LOCALAPPDATA;
  const machine = env["ProgramFiles"];
  if (local) out.push(path.join(local, "Programs", "Masora Voice", "launcher", EXE));
  if (machine) out.push(path.join(machine, "Masora Voice", "launcher", EXE));
  return out;
}

/**
 * The installed executable, or null.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
function find(env = process.env) {
  for (const p of candidates(env)) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // Not there. The next candidate, or null.
    }
  }
  return null;
}

/** What Masora Voice's own default is, when its config says nothing.
 *  masora_dictation/config.py: HotkeyConfig.hold = ["ctrl", "backquote"]. */
const DEFAULT_HOLD = ["ctrl", "backquote"];

const KEY_LABEL = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", backquote: "`", space: "Space" };

/**
 * The hold-to-talk chord, read from Masora Voice's own config so zevet never
 * tells somebody to press a key they have rebound.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function hotkey(env = process.env) {
  let keys = DEFAULT_HOLD;
  const appData = env.APPDATA;
  if (appData) {
    try {
      const file = path.join(appData, "Masora", "Dictation", "config.json");
      const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      const hold = cfg && cfg.hotkey && cfg.hotkey.hold;
      if (Array.isArray(hold) && hold.length && hold.every((k) => typeof k === "string")) {
        keys = hold;
      }
    } catch {
      // No config yet, or unreadable, or half-written. The default is right.
    }
  }
  return keys.map((k) => KEY_LABEL[k] || k).join("+");
}

/**
 * Is it there, and what should the board say about it.
 *
 * `running` is deliberately NOT reported. Asking costs a `tasklist` spawn and
 * buys nothing: starting a second copy is already harmless (its SingleInstance
 * mutex makes the new process log and exit with EXIT_ALREADY_RUNNING —
 * platform_services.py), and either way the outcome the person sees is the
 * same one, a flow bar on screen.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
function status(env = process.env) {
  const exe = find(env);
  return {
    installed: Boolean(exe),
    exe,
    hotkey: hotkey(env),
    // Where the board sends somebody who does not have it. masora-landing's
    // /voice page, which carries both platforms' builds.
    download: "https://usemasora.com/voice",
  };
}

/**
 * Start it, so its flow bar comes up.
 *
 * Detached and unref'd: this is a tray app with its own lifetime, and it must
 * not die with zevet. Starting it when it is already running is a no-op by
 * design — see `status`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {typeof spawn} [spawnImpl]
 */
function start(env = process.env, spawnImpl = spawn) {
  const exe = find(env);
  if (!exe) return { ok: false, error: "Masora Voice is not installed", installed: false };
  try {
    const child = spawnImpl(exe, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      cwd: path.dirname(exe),
    });
    if (child && typeof child.unref === "function") child.unref();
  } catch (err) {
    return { ok: false, error: `could not start Masora Voice: ${err.message}`, installed: true };
  }
  return { ok: true, installed: true, hotkey: hotkey(env) };
}

/**
 * Ask the running instance to start a dictation — or stop the one in progress.
 *
 * ⚠️ THIS IS A TOGGLE, not a start, because that is what the event does:
 * `admin record` posts Masora Voice's own `toggle`, the hands-free transition
 * its Ctrl+`+Space chord posts. So the second press stops and transcribes.
 * zevet gets that for free and must not pretend otherwise.
 *
 * The text does NOT come back through here. Masora Voice types into whatever
 * window has focus when the signal lands, which is zevet — that is the whole
 * design, and why this resolves with no transcript.
 *
 * An older Masora Voice has no `record` verb and exits non-zero with its usage
 * on stderr. That is reported as `{ ok: false, stale: true }` rather than as a
 * generic failure, because the answer to it is "update Masora Voice" and not
 * "something went wrong".
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {typeof execFile} [execFileImpl]
 */
function dictate(env = process.env, execFileImpl = execFile) {
  const exe = find(env);
  if (!exe) return Promise.resolve({ ok: false, installed: false, error: "Masora Voice is not installed" });
  const cli = path.join(path.dirname(exe), CONSOLE_EXE);
  return new Promise((resolve) => {
    execFileImpl(
      cli,
      ["-m", "masora_dictation.admin", "record"],
      { windowsHide: true, timeout: 10000 },
      (err, _stdout, stderr) => {
        if (!err) return resolve({ ok: true, installed: true });
        const said = String(stderr || err.message || "");
        // Its argparse prints the verb list when the verb is unknown.
        const stale = /invalid choice|usage: masora_dictation\.admin/i.test(said);
        resolve({
          ok: false,
          installed: true,
          stale,
          error: stale ? "this Masora Voice is too old for the record trigger" : said.trim().split("\n")[0],
        });
      },
    );
  });
}

/**
 * The whole microphone gesture, in one call, because it is one intent.
 *
 * Masora Voice has to be RUNNING to take a record signal — `admin record`
 * refuses otherwise rather than claiming success. So a cold machine needs two
 * steps, and they cannot be collapsed: the app takes seconds to come up, load
 * its model and arm its listener, and a signal sent into that gap is simply
 * lost. Rather than sleep-and-hope, this reports `starting` and the board asks
 * for the mic again — by which time the flow bar is on screen, which is its
 * own invitation.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ dictateImpl?: Function, startImpl?: Function }} [impls]
 */
async function mic(env = process.env, impls = {}) {
  const dictateImpl = impls.dictateImpl || dictate;
  const startImpl = impls.startImpl || start;
  if (!find(env)) {
    return { ok: false, installed: false, download: status(env).download };
  }
  const first = await dictateImpl(env);
  if (first.ok) return { ok: true, installed: true, dictating: true, hotkey: hotkey(env) };
  if (first.stale) return { ...first, hotkey: hotkey(env) };
  // Not running: raise it, and say so rather than pretending to have started
  // a dictation that nothing heard.
  const started = startImpl(env);
  return {
    ok: false,
    installed: true,
    starting: started.ok,
    error: started.ok ? null : started.error,
    hotkey: hotkey(env),
  };
}

module.exports = { candidates, find, hotkey, status, start, dictate, mic, EXE, CONSOLE_EXE, DEFAULT_HOLD };
