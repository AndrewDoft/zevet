/**
 * The pop-up that offers zevet Voice when the mic is pressed without it.
 *
 * Andrew: "if masora voice is not downloaded, you get a pop up to download
 * it." Same shape as updatedialog.tsx, and for the same reason — this is a
 * decision, made at the one moment somebody has shown they want it, which is
 * the only kind of interruption this board allows.
 *
 * The link opens outside the app: main.js's `setWindowOpenHandler` sends every
 * https target to `shell.openExternal`, so a plain anchor is the whole of it.
 * No new IPC, and no in-app browser to keep a person inside.
 *
 * There is no "don't ask again": the dialog only ever appears because someone
 * pressed the microphone, so it is already gated on intent.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useBoard } from "../lib/board";

export function VoiceDialog() {
  const voiceAsk = useBoard((s) => s.voiceAsk);
  const setVoiceAsk = useBoard((s) => s.setVoiceAsk);
  if (!voiceAsk) return null;

  return (
    <Dialog open onOpenChange={(open: boolean) => { if (!open) setVoiceAsk(null); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>zevet Voice isn&rsquo;t installed</DialogTitle>
          <DialogDescription>
            {/* What it IS, in one line, because "install this" with no account
                of what it does is how people decline things they wanted. */}
            zevet&rsquo;s microphone runs zevet Voice: hold a key anywhere on this
            machine and what you say is transcribed on-device and typed into
            whatever you are looking at — including this composer.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setVoiceAsk(null)}>
            Not now
          </Button>
          <Button
            onClick={() => {
              window.open(voiceAsk, "_blank", "noopener");
              setVoiceAsk(null);
            }}
          >
            Get zevet Voice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What the microphone just did, in one line under the composer.
 *
 * ⚠️ EVERY PRESS SAYS SOMETHING. zevet Voice draws its own flow bar in its own
 * process, so nothing about a dictation is visible inside zevet — and the
 * gesture has real outcomes that differ ("listening", "press again in a
 * moment" on a cold start, "update zevet Voice" on an old build). A mic that
 * silently did one of four different things is the bug this removes.
 * lib/voice.ts picks the sentence; this only shows it.
 */
export function VoiceHint() {
  const line = useBoard((s) => s.voiceHotkey);
  const setVoiceHotkey = useBoard((s) => s.setVoiceHotkey);
  if (!line) return null;
  return (
    <div className="voice-hint" role="status">
      <span>{line}</span>
      <button type="button" onClick={() => setVoiceHotkey("")} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
