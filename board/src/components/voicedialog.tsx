/**
 * The pop-up that offers Masora Voice when the mic is pressed without it.
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
          <DialogTitle>Masora Voice isn&rsquo;t installed</DialogTitle>
          <DialogDescription>
            {/* What it IS, in one line, because "install this" with no account
                of what it does is how people decline things they wanted. */}
            zevet&rsquo;s microphone runs Masora Voice: hold a key anywhere on this
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
            Get Masora Voice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What to do now that the flow bar is up — shown once per run, under the
 * composer, after the mic has actually started Masora Voice.
 *
 * ⚠️ THIS EXISTS BECAUSE THE MIC CANNOT START THE RECORDING. Masora Voice has
 * no trigger a separate process can pull (desktop/masora-voice.js lists what
 * was checked), so pressing the mic raises the bar and nothing else happens
 * until a key is held. Without this line that reads as a broken button.
 */
export function VoiceHint() {
  const voiceHotkey = useBoard((s) => s.voiceHotkey);
  const setVoiceHotkey = useBoard((s) => s.setVoiceHotkey);
  if (!voiceHotkey) return null;
  return (
    <div className="voice-hint" role="status">
      <span>
        Masora Voice is on. Hold <kbd>{voiceHotkey}</kbd> and talk — it types into
        whatever has focus.
      </span>
      <button type="button" onClick={() => setVoiceHotkey("")} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
