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
import { normalizeAgentKey, providerFor } from "./icons/providers";
import { VoiceOrb } from "./assistant-ui/elements/voice";

/* ---------------------------------------------------------------------------
 * AgentLogo — the provider mark for the CLI actually running, not a generic
 * brand. codex resolves gpt-5 / gpt-5-codex / o3 (lib/constants.ts MODELS),
 * all OpenAI, so the OpenAI mark is honest for it. claude and codex are
 * matched directly below and never go through providerFor: their marks
 * (logos.tsx) live outside icons/providers.tsx, which only knows the labs
 * opencode fronts.
 *
 * opencode itself is a front end for many labs at once (lib/models.generated
 * .mjs: poolside, cohere, google, nvidia, thinkingmachines, opencode's own
 * contributor builds), so the bare agent name "opencode" is ambiguous on its
 * own UNLESS the model id says more — icons/providers.tsx's providerFor()
 * resolves both the agent name and, as a fallback, the model id (agent
 * first, since it is the more specific signal when it alone is enough, e.g.
 * agent "opencode" now resolves to opencode's own mark; model second, for
 * when the model id names a lab the agent name can't, e.g. an opencode run
 * on "openrouter/deepseek/deepseek-chat:free"). Two names reach here for the
 * same three agents — see normalizeAgentKey's comment in icons/providers.tsx
 * for both vocabularies and why. An unidentifiable agent/model pair renders
 * nothing rather than guess.
 * ------------------------------------------------------------------------- */

export interface AgentLogoProps {
  agent: string;
  /** The model the agent ran, when known. Only consulted when the agent name
   *  alone doesn't identify a provider (opencode fronts a dozen). */
  model?: string;
  hue?: number;
  className?: string;
}

export function AgentLogo({ agent, model, hue, className }: AgentLogoProps) {
  // Same index space as board.ts's hueOf: --who-N is defined for N in
  // [0, HUES). A teammate's colour, not a literal hue angle.
  const who =
    hue == null ? undefined : `var(--who-${((hue % HUES) + HUES) % HUES})`;
  const style = who ? ({ "--who": who, color: who } as CSSProperties) : undefined;

  const a = normalizeAgentKey(agent);

  if (a === "claude") {
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

  if (a === "codex") {
    // OpenAILogo already draws with fill="currentColor" on the <svg> root,
    // so the wrapper's `color` is enough — no override needed.
    return (
      <OpenAILogo className={cn("size-4 shrink-0", className)} style={style} />
    );
  }

  const provider = providerFor(a) ?? (model ? providerFor(model) : null);
  if (!provider) return null;
  const { Mark } = provider;
  return (
    <Mark
      className={cn("size-4 shrink-0", who && "[&_path]:fill-current", className)}
      style={style}
    />
  );
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
