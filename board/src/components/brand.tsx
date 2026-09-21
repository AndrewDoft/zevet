/**
 * Two small "who is this" renderers, in the same reads-only-what-it-knows
 * spirit as moreviews.tsx: nothing invented, nothing rendered when the fact
 * behind it does not exist.
 */
"use client";

import type { CSSProperties } from "react";
import { useAuiState } from "@assistant-ui/react";
import { cn } from "@/lib/utils";
import { HUES } from "../lib/constants";
import { ClaudeLogo, OpenAILogo } from "./assistant-ui/elements/logos";
import { VoiceOrb } from "./assistant-ui/elements/voice";

/* ---------------------------------------------------------------------------
 * AgentLogo — the provider mark for the CLI actually running, not a generic
 * brand. codex resolves gpt-5 / gpt-5-codex / o3 (lib/constants.ts MODELS),
 * all OpenAI, so the OpenAI mark is honest for it. opencode is a front end
 * for many labs at once (lib/models.generated.mjs: poolside, cohere, google,
 * nvidia, thinkingmachines, opencode's own contributor builds) — none of
 * logos.tsx's three marks belongs to all of them, so opencode renders no
 * logo rather than borrow one lab's mark for the rest. An unknown agent name
 * renders nothing too.
 * ------------------------------------------------------------------------- */

export interface AgentLogoProps {
  agent: string;
  hue?: number;
  className?: string;
}

export function AgentLogo({ agent, hue, className }: AgentLogoProps) {
  // Same index space as board.ts's hueOf: --who-N is defined for N in
  // [0, HUES). A teammate's colour, not a literal hue angle.
  const who =
    hue == null ? undefined : `var(--who-${((hue % HUES) + HUES) % HUES})`;
  const style = who ? ({ "--who": who, color: who } as CSSProperties) : undefined;

  if (agent === "claude") {
    return (
      <ClaudeLogo
        className={cn(
          "size-4 shrink-0",
          // ClaudeLogo hardcodes fill="#D97757" on its <path>, not on the
          // <svg> root, so a "currentColor" prop alone never reaches it —
          // props only ever land on the root element. CSS beats a
          // presentation attribute regardless of specificity, so a plain
          // descendant rule reclaims it without touching the vendored file.
          who && "[&_path]:fill-current",
          className,
        )}
        style={style}
      />
    );
  }

  if (agent === "codex") {
    // OpenAILogo already draws with fill="currentColor" on the <svg> root,
    // so the wrapper's `color` is enough — no override needed.
    return (
      <OpenAILogo className={cn("size-4 shrink-0", className)} style={style} />
    );
  }

  return null;
}

/* ---------------------------------------------------------------------------
 * DictationOrb — the composer's Web Speech dictation, not a voice session.
 * zevet has no realtime voice connection (no useVoiceState/useVoiceControls
 * wiring — see lib/runtime.tsx's WebSpeechDictationAdapter and the composer's
 * own ComposerPrimitive.Dictate in thread.aui.tsx, which read
 * s.composer.dictation, not s.thread.voice). This orb reads that same field:
 * dictation active -> "listening". Every other state, including "speaking",
 * renders nothing — nothing in zevet talks back.
 * ------------------------------------------------------------------------- */

export interface DictationOrbProps {
  className?: string;
}

export function DictationOrb({ className }: DictationOrbProps) {
  const dictating = useAuiState((s) => s.composer.dictation != null);
  if (!dictating) return null;
  // volume defaults to 0 inside VoiceOrb itself (voice.tsx) — dictation
  // carries no level meter, so it is left unset rather than faked.
  return <VoiceOrb state="listening" className={className} />;
}
