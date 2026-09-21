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
 * ⚠️ AND ZEVET CANNOT START A RECORDING. Checked against the source rather
 * than assumed: masora_dictation has no socket, no named pipe, no file it
 * watches, and no admin CLI verb for it (admin.py's verbs are download-model,
 * model-manifest, set-enrollment, enroll, renew, enrollment-status, set,
 * set-key, test-connection, status, quit). The one named Win32 event it
 * listens on is `Local\MasoraDictation-<hash>-quit`, which only quits.
 * Synthesising the hotkey does not work either — hotkey/windows.py's
 * `should_process()` drops events flagged LLKHF_INJECTED unless the app was
 * started with `--accept-injected`, a flag its own help calls "e2e tests
 * only". So the person still holds the hotkey; zevet says which one.
 * A record trigger would have to be added on the Masora Voice side, next to
 * the quit event it already has.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

/** The GUI launcher inside an installed bundle. install.ps1 lays the versioned
 *  bundle out with a stable `launcher/` directory, which is why this is not
 *  version-dependent. */
const EXE = "Masora Voice.exe";

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

module.exports = { candidates, find, hotkey, status, start, EXE, DEFAULT_HOLD };
