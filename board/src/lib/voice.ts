/**
 * The composer's microphone, wired to zevet Voice.
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
 * zevet Voice types its text into whatever window has focus — which, when you
 * have just clicked zevet's composer, is zevet's composer. The text arrives as
 * keystrokes, not through this adapter, so there is nothing for `onSpeech` to
 * emit and the session ends as soon as the app is up. Emitting a fake
 * "listening" state that never resolves would be the lie; ending is the truth.
 *
 * ⚠️ IT IS A TOGGLE, not a start. The trigger posts zevet Voice's own
 * `toggle` — the hands-free transition its Ctrl+`+Space chord posts — so the
 * second press is what stops the dictation and transcribes it. zevet says so
 * rather than leaving somebody holding a mic that looks stuck on.
 *
 * On a cold machine it takes two presses for a different reason: zevet Voice
 * must be RUNNING to take a record signal, and one sent while it is still
 * coming up is lost. The first press raises it, the second dictates.
 */
import type { DictationAdapter } from "@assistant-ui/react";
import { bridge } from "./bridge";

export type VoiceStatus = {
  installed: boolean;
  exe: string | null;
  hotkey: string;
  download: string;
};

/** What `local:voiceMic` answers. See desktop/zevet-voice.js's `mic()`. */
export type MicResult = {
  ok: boolean;
  installed: boolean;
  dictating?: boolean;
  starting?: boolean;
  stale?: boolean;
  hotkey?: string;
  error?: string | null;
  download?: string;
};

const DOWNLOAD = "https://usemasora.com/voice";

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
  /** Called when zevet Voice is not installed, so the board can offer it.
   *  A callback rather than a store import: this file is the adapter, and the
   *  dialog is the board's business. */
  private readonly onMissing: (download: string) => void;
  private readonly onSaid: (line: string) => void;

  constructor(opts: { onMissing: (download: string) => void; onSaid: (line: string) => void }) {
    this.onMissing = opts.onMissing;
    this.onSaid = opts.onSaid;
  }

  listen(): DictationAdapter.Session {
    const local = bridge.local as { voiceMic?: () => Promise<MicResult> } | undefined;
    // An older desktop build has no such method. Offering the download is the
    // honest answer there too — what it cannot do is pretend to dictate.
    if (!local || typeof local.voiceMic !== "function") {
      this.onMissing(DOWNLOAD);
      return endedSession();
    }
    void local
      .voiceMic()
      .then((r) => this.report(r))
      .catch(() => this.onMissing(DOWNLOAD));
    return endedSession();
  }

  /** One of four outcomes, each with its own sentence. The one thing none of
   *  them may do is stay silent — the mic is a button, and a button that does
   *  nothing visible is the bug this whole file exists to remove. */
  private report(r: MicResult): void {
    if (!r || !r.installed) return this.onMissing((r && r.download) || DOWNLOAD);
    if (r.ok) return this.onSaid("Listening. Press the mic again when you are done.");
    if (r.stale) {
      return this.onSaid(
        `This zevet Voice is too old to be started from here — update it, or hold ${r.hotkey || "the hotkey"}.`,
      );
    }
    if (r.starting) {
      // Cold start: the app is coming up and has not armed its listener yet. A
      // signal sent into that gap is simply lost, so ask rather than sleep.
      return this.onSaid("zevet Voice is starting. Press the mic again in a moment.");
    }
    this.onSaid(r.error || "zevet Voice could not be started.");
  }
}
