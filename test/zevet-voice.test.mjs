/**
 * Finding and starting zevet Voice.
 *
 * The interesting half is the one that CANNOT be exercised on the machine this
 * was written on, where zevet Voice happens to be installed: the not-found
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
const voice = require("../desktop/zevet-voice.js");

/** A throwaway %LOCALAPPDATA% with, optionally, the app installed in it. */
function fakeHome(t, { installed = false, legacy = false, hotkey = null } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "zevet-voice-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const local = path.join(root, "Local");
  const appData = path.join(root, "Roaming");
  mkdirSync(local, { recursive: true });
  mkdirSync(appData, { recursive: true });
  // `legacy` lays it out under the name it shipped with before 2026-09-21,
  // which is what a machine that has not taken the Voice update still has.
  // Both flags together is the mid-migration machine, which is a real state:
  // install.ps1 only retires the old directory after the new one imports.
  const lay = (product) => {
    const dir = path.join(local, "Programs", product, "launcher");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, voice.EXE(product)), "");
  };
  if (installed) lay("zevet Voice");
  if (legacy) lay("Masora Voice");
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
    assert.match(exe, /Programs[\\/]zevet Voice[\\/]launcher[\\/]zevet Voice\.exe$/);
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
    assert.match(calls[0][0], /zevet Voice\.exe$/);
    assert.deepEqual(calls[0][1], []);
    // Detached AND unref'd, or it dies with the app that started it — the
    // whole point is a flow bar that stays up.
    assert.equal(calls[0][2].detached, true);
    assert.equal(calls[0][2].stdio, "ignore");
    assert.equal(unrefs, 1);
  });

  test("the hotkey comes from zevet Voice's own config, not a hard-coded guess", (t) => {
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

describe("the microphone gesture", () => {
  test("a machine without zevet Voice is offered the download, not an error", async (t) => {
    const env = fakeHome(t, { installed: false });
    const r = await voice.mic(env, { dictateImpl: async () => { throw new Error("must not run"); } });
    assert.equal(r.installed, false);
    assert.equal(r.download, "https://usemasora.com/voice");
  });

  test("a running instance dictates on the first press", async (t) => {
    const env = fakeHome(t, { installed: true });
    let started = 0;
    const r = await voice.mic(env, {
      dictateImpl: async () => ({ ok: true, installed: true }),
      startImpl: () => { started++; return { ok: true }; },
    });
    assert.equal(r.ok, true);
    assert.equal(r.dictating, true);
    // Already running: starting it again would be noise, and on a slow machine
    // a second window of nothing happening.
    assert.equal(started, 0);
  });

  test("a cold machine is raised and says so, rather than losing the signal", async (t) => {
    const env = fakeHome(t, { installed: true });
    let started = 0;
    const r = await voice.mic(env, {
      // What `admin record` answers when no instance is listening.
      dictateImpl: async () => ({ ok: false, installed: true, error: "zevet Voice is not running" }),
      startImpl: () => { started++; return { ok: true }; },
    });
    assert.equal(started, 1);
    assert.equal(r.starting, true);
    assert.equal(r.ok, false, "it must not claim a dictation nothing heard");
  });

  test("an old build is named as old, and is not restarted on top of itself", async (t) => {
    const env = fakeHome(t, { installed: true });
    let started = 0;
    const r = await voice.mic(env, {
      dictateImpl: async () => ({ ok: false, installed: true, stale: true }),
      startImpl: () => { started++; return { ok: true }; },
    });
    assert.equal(r.stale, true);
    // It IS running — it just cannot take the trigger. Launching a second copy
    // would do nothing but log EXIT_ALREADY_RUNNING.
    assert.equal(started, 0);
    assert.equal(r.hotkey, "Ctrl+`", "the fallback instruction needs the real chord");
  });
});

describe("the rename", () => {
  test("an install under the OLD name is still found", (t) => {
    // The two apps update independently, so there is a window where zevet has
    // the new name and the machine still has "Masora Voice". Reporting that as
    // "not installed" would offer somebody a download they already have.
    const env = fakeHome(t, { legacy: true });
    const exe = voice.find(env);
    assert.ok(exe, "a legacy install was not found");
    assert.match(exe, /Masora Voice\.exe$/);
    assert.equal(voice.status(env).installed, true);
  });

  test("the new name wins when a machine carries both", (t) => {
    const env = fakeHome(t, { installed: true, legacy: true });
    assert.match(
      voice.find(env),
      /zevet Voice\.exe$/,
      "mid-migration, the current install must be the one that runs",
    );
  });
});
