/**
 * Finding and starting Masora Voice.
 *
 * The interesting half is the one that CANNOT be exercised on the machine this
 * was written on, where Masora Voice happens to be installed: the not-found
 * path, which is what decides whether somebody is offered the download or left
 * with a mic that does nothing. So every case here builds its own fake
 * environment and its own fake tree rather than reading the real one.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const voice = require("../desktop/masora-voice.js");

/** A throwaway %LOCALAPPDATA% with, optionally, the app installed in it. */
function fakeHome(t, { installed = false, hotkey = null } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "zevet-voice-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const local = path.join(root, "Local");
  const appData = path.join(root, "Roaming");
  mkdirSync(local, { recursive: true });
  mkdirSync(appData, { recursive: true });
  if (installed) {
    const dir = path.join(local, "Programs", "Masora Voice", "launcher");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, voice.EXE), "");
  }
  if (hotkey) {
    const dir = path.join(appData, "Masora", "Dictation");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ hotkey: { hold: hotkey } }));
  }
  return { LOCALAPPDATA: local, APPDATA: appData };
}

describe("masora voice", () => {
  test("finds the per-user install where install.ps1 puts it", (t) => {
    const env = fakeHome(t, { installed: true });
    const exe = voice.find(env);
    assert.ok(exe, "the installed exe was not found");
    assert.match(exe, /Programs[\\/]Masora Voice[\\/]launcher[\\/]Masora Voice\.exe$/);
  });

  test("an environment without it returns null rather than a guessed path", (t) => {
    const env = fakeHome(t, { installed: false });
    assert.equal(voice.find(env), null);
    // A path that merely LOOKS right is the failure worth preventing: the
    // board would then start nothing and say nothing.
    assert.equal(voice.status(env).installed, false);
    assert.equal(voice.status(env).exe, null);
  });

  test("start on a machine without it reports that, and spawns nothing", (t) => {
    const env = fakeHome(t, { installed: false });
    let spawned = 0;
    const r = voice.start(env, () => { spawned++; return { unref() {} }; });
    assert.equal(r.ok, false);
    assert.equal(r.installed, false);
    assert.equal(spawned, 0, "it tried to run something that is not there");
  });

  test("start runs the exe detached, so the tray app outlives zevet", (t) => {
    const env = fakeHome(t, { installed: true });
    const calls = [];
    let unrefs = 0;
    const r = voice.start(env, (...a) => { calls.push(a); return { unref: () => unrefs++ }; });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0][0], /Masora Voice\.exe$/);
    assert.deepEqual(calls[0][1], []);
    // Detached AND unref'd, or it dies with the app that started it — the
    // whole point is a flow bar that stays up.
    assert.equal(calls[0][2].detached, true);
    assert.equal(calls[0][2].stdio, "ignore");
    assert.equal(unrefs, 1);
  });

  test("the hotkey comes from Masora Voice's own config, not a hard-coded guess", (t) => {
    // Default, with no config written yet.
    assert.equal(voice.hotkey(fakeHome(t, {})), "Ctrl+`");
    // Rebound. zevet must not keep telling someone to press the old chord.
    assert.equal(voice.hotkey(fakeHome(t, { hotkey: ["ctrl", "alt", "space"] })), "Ctrl+Alt+Space");
  });

  test("a corrupt config falls back rather than throwing", (t) => {
    const env = fakeHome(t, {});
    const dir = path.join(env.APPDATA, "Masora", "Dictation");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.json"), "{ half written");
    assert.equal(voice.hotkey(env), "Ctrl+`");
  });

  test("status carries a download somewhere real", (t) => {
    const s = voice.status(fakeHome(t, {}));
    // The board opens this in a browser when the mic is pressed without the
    // app. A wrong URL is a dead end at exactly the moment of intent.
    assert.equal(s.download, "https://usemasora.com/voice");
  });
});
