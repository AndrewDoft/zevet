/**
 * The composer's microphone, wired to Masora Voice.
 *
 * ⚠️ WHAT THE MIC USED TO DO, and why it stopped. It was assistant-ui's
 * `WebSpeechDictationAdapter`, which is `window.SpeechRecognition` — and in
 * Electron that has no backend. Pressing it printed `Dictation error: network`
 * to the console and put a white rectangle at the bottom of the conversation
 * (the dictation orb, rendering unstyled), which is what Andrew saw:
 * "when i hit the microphone there is an issue, and something goes up and it
 * looks weird."
 *
 * ⚠️ THIS ADAPTER RETURNS NO TRANSCRIPT, EVER, and that is not a stub.
 * Masora Voice types its text into whatever window has focus — which, when you
 * have just clicked zevet's composer, is zevet's composer. The text arrives as
 * keystrokes, not through this adapter, so there is nothing for `onSpeech` to
 * emit and the session ends as soon as the app is up. Emitting a fake
 * "listening" state that never resolves would be the lie; ending is the truth.
 *
 * ⚠️ AND IT CANNOT START THE RECORDING. Masora Voice has no IPC surface for it
 * — see desktop/masora-voice.js, which lists what was actually checked in its
 * source. Clicking the mic starts the APP, whose flow bar then appears; the
 * person holds the hotkey to talk, and `hotkey` is read from Masora Voice's
 * own config so zevet never names a key somebody has rebound.
 */
import type { DictationAdapter } from "@assistant-ui/react";
import { bridge } from "./bridge";

export type VoiceStatus = {
  installed: boolean;
  exe: string | null;
  hotkey: string;
  download: string;
};

/** Ended before it began, with the reason the caller asked for. A session is
 *  the only shape `listen()` may return, so "nothing to listen to" still has
 *  to be one. */
function endedSession(): DictationAdapter.Session {
  const noop = () => () => {};
  return {
    status: { type: "ended", reason: "stopped" },
    stop: async () => {},
    cancel: () => {},
    onSpeechStart: noop,
    onSpeechEnd: noop,
    onSpeech: noop,
  };
}

export class MasoraVoiceDictationAdapter implements DictationAdapter {
  /** Called when Masora Voice is not installed, so the board can offer it.
   *  A callback rather than a store import: this file is the adapter, and the
   *  dialog is the board's business. */
  private readonly onMissing: (download: string) => void;
  private readonly onStarted: (hotkey: string) => void;

  constructor(opts: { onMissing: (download: string) => void; onStarted: (hotkey: string) => void }) {
    this.onMissing = opts.onMissing;
    this.onStarted = opts.onStarted;
  }

  listen(): DictationAdapter.Session {
    const local = bridge.local as
      | { voiceStart?: () => Promise<{ ok: boolean; installed?: boolean; hotkey?: string }> }
      | undefined;
    // An older desktop build has no such method. Offering the download is the
    // honest answer there too — what it cannot do is pretend to dictate.
    if (!local || typeof local.voiceStart !== "function") {
      this.onMissing("https://usemasora.com/voice");
      return endedSession();
    }
    void local
      .voiceStart()
      .then((r) => {
        if (r && r.ok) this.onStarted(r.hotkey || "");
        else this.onMissing("https://usemasora.com/voice");
      })
      .catch(() => this.onMissing("https://usemasora.com/voice"));
    return endedSession();
  }
}
