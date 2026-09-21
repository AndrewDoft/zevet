/**
 * Speech views onto the active console: two cards built on real capability
 * and real data, nothing invented.
 *
 * - ReadAloud speaks the last assistant message with the browser's own
 *   `window.speechSynthesis` — a capability that needs no agent support at
 *   all, which is the whole reason it's worth building here.
 * - Speakers turns the transcript into "who said what", reusing the same
 *   Task/tool-call reading agentviews.tsx already does for TaskCards.
 *
 * Same untrusted-args problem as agentviews.tsx/moreviews.tsx (tool args
 * vary across CLIs), so the same small reader helpers are duplicated here
 * rather than imported — neither file exports them.
 */
import { useEffect, useRef, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { selectActiveConsole, useBoard } from "../lib/board";
import { ReadAloud as ReadAloudView } from "./assistant-ui/elements/read-aloud";
import { SpeakerIdentity, type SpeakerTurn } from "./assistant-ui/elements/speaker-identity";

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function str(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

function pick(args: unknown, ...keys: string[]): string {
  const o = rec(args);
  for (const k of keys) {
    const v = str(o[k]);
    if (v) return v;
  }
  return "";
}

/** The first argument value worth showing, whichever key it's under — tool
 *  args vary too much across CLIs to pick one fixed key, unlike `pick`. */
function firstArgValue(args: unknown): string {
  const o = rec(args);
  for (const k of Object.keys(o)) {
    const v = str(o[k]);
    if (v) return v;
  }
  return "";
}

/** A tool result flattened to text — same collapsing rule as tools.tsx's
 *  `resultText`, duplicated because it is not exported. */
function resultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map(resultText).filter(Boolean).join("\n");
  const o = rec(result);
  for (const k of ["text", "output", "aggregated_output", "stdout", "content", "result"]) {
    if (o[k] != null) return resultText(o[k]);
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/** The text parts of a message, concatenated — content may be a plain
 *  string or an array, per the same guard every reader here uses. */
function textOf(content: ThreadMessageLike["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ");
}

/**
 * The words a person would actually read out.
 *
 * ⚠️ NOT THE RAW MARKDOWN. The first version fed the message text straight in,
 * and against a real turn the speech synthesiser said "backtick backtick
 * backtick mermaid flowchart L R A open square bracket agent stdout" — a
 * diagram read as punctuation. A fenced block is a figure, not a sentence;
 * the transcript above shows it properly and this skips it. Inline code keeps
 * its contents (`liveActorsOf` is a word somebody says) and loses the marks.
 */
const speakable = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{4,}\S.*$/gm, " ")
    .replace(/[*_#>]/g, " ");

const wordsOf = (content: ThreadMessageLike["content"]): string[] =>
  speakable(textOf(content)).trim().split(/\s+/).filter(Boolean);

function lastAssistantMessage(
  messages: readonly ThreadMessageLike[],
): ThreadMessageLike | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") return messages[i];
  }
  return undefined;
}

/* ---------------------------------------------------------------------------
 * ReadAloud — the last assistant message, spoken.
 * ------------------------------------------------------------------------- */

// A small, real set of rates — cycled on click, applied to the utterance.
const RATES: readonly number[] = [1, 1.25, 1.5, 1.75, 2];

function mmss(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Char offset of each word in `words.join(" ")` — the same string handed to
 *  the utterance, so a `boundary` event's charIndex maps back onto it. */
function wordStarts(words: readonly string[]): number[] {
  const starts: number[] = [];
  let pos = 0;
  for (const w of words) {
    starts.push(pos);
    pos += w.length + 1; // +1 for the joining space
  }
  return starts;
}

/** The word `charIndex` falls in, given `starts` from `wordStarts`. */
function wordAt(starts: readonly number[], charIndex: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= charIndex) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function ReadAloud() {
  const active = useBoard(selectActiveConsole);
  const messages = active?.transcript.messages ?? [];
  const turn = lastAssistantMessage(messages);
  const words = turn ? wordsOf(turn.content) : [];

  const [playing, setPlaying] = useState(false);
  const [spokenIndex, setSpokenIndex] = useState(0);
  const [rate, setRate] = useState<number>(RATES[0]);
  const [elapsedMs, setElapsedMs] = useState(0);
  // Total elapsed carries across pause/resume/rate-change segments; only the
  // in-flight segment's start needs a ref (it must survive re-renders
  // without re-triggering effects).
  const baseMsRef = useRef(0);
  const segmentStartRef = useRef<number | null>(null);

  const endSegment = () => {
    if (segmentStartRef.current != null) {
      baseMsRef.current += Date.now() - segmentStartRef.current;
      segmentStartRef.current = null;
    }
  };

  // A console that keeps talking about a thread you've navigated away from
  // is a bug — stop and reset the moment the active console changes.
  useEffect(() => {
    window.speechSynthesis?.cancel();
    setPlaying(false);
    setSpokenIndex(0);
    baseMsRef.current = 0;
    segmentStartRef.current = null;
    setElapsedMs(0);
  }, [active?.key]);

  useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel();
    };
  }, []);

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setElapsedMs(
        baseMsRef.current + (segmentStartRef.current != null ? Date.now() - segmentStartRef.current : 0),
      );
    }, 250);
    return () => window.clearInterval(id);
  }, [playing]);

  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  if (!supported || words.length === 0) return null;

  const speak = (fromIndex: number, useRate: number) => {
    const synth = window.speechSynthesis;
    synth.cancel();
    const segment = words.slice(fromIndex);
    if (!segment.length) return;
    const starts = wordStarts(segment);
    const utter = new SpeechSynthesisUtterance(segment.join(" "));
    utter.rate = useRate;
    utter.onboundary = (e) => {
      if (e.name && e.name !== "word") return;
      setSpokenIndex(Math.min(fromIndex + wordAt(starts, e.charIndex), words.length - 1));
    };
    utter.onstart = () => {
      segmentStartRef.current = Date.now();
      setPlaying(true);
    };
    utter.onpause = () => {
      endSegment();
      setPlaying(false);
    };
    utter.onresume = () => {
      segmentStartRef.current = Date.now();
      setPlaying(true);
    };
    utter.onend = () => {
      endSegment();
      setPlaying(false);
      setSpokenIndex(words.length);
    };
    utter.onerror = () => {
      endSegment();
      setPlaying(false);
    };
    synth.speak(utter);
  };

  const onToggle = () => {
    if (playing) {
      window.speechSynthesis.cancel();
      endSegment();
      setPlaying(false);
      return;
    }
    const from = spokenIndex >= words.length ? 0 : spokenIndex;
    if (from === 0) {
      baseMsRef.current = 0;
      setElapsedMs(0);
    }
    speak(from, rate);
  };

  const onRateChange = () => {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
    setRate(next);
    // ponytail: restarts the utterance at the current word rather than
    // adjusting rate mid-speech — the Web Speech API exposes no such knob,
    // and reconstructing mid-utterance state for it isn't worth the code.
    if (playing) speak(spokenIndex, next);
  };

  return (
    <ReadAloudView
      words={words}
      spokenIndex={spokenIndex}
      playing={playing}
      rate={rate}
      elapsed={mmss(elapsedMs)}
      // speechSynthesis never reports a duration before it finishes — there
      // is no pre-flight timing API — so this is the true, measured extent
      // of what will be read (a word count), not a guessed clock.
      duration={`${words.length} word${words.length === 1 ? "" : "s"}`}
      onToggle={onToggle}
      onRateChange={onRateChange}
    />
  );
}

/* ---------------------------------------------------------------------------
 * Speakers — the transcript's recent turns, attributed.
 * ------------------------------------------------------------------------- */

const isTask = (n: string) => n === "task" || n === "subagent";

function buildTurns(
  messages: readonly ThreadMessageLike[],
  agentName: string,
  model: string,
): SpeakerTurn[] {
  const out: SpeakerTurn[] = [];
  messages.forEach((m, mi) => {
    if (m.role === "user") {
      const text = textOf(m.content).trim();
      if (text) out.push({ id: m.id ?? `u${mi}`, kind: "user", name: "you", text });
      return;
    }
    if (m.role !== "assistant") return; // "system" has no one to attribute it to

    const content = m.content;
    if (!Array.isArray(content)) {
      const text = typeof content === "string" ? content.trim() : "";
      if (text) {
        out.push({ id: m.id ?? `a${mi}`, kind: "agent", name: agentName, detail: model || undefined, text });
      }
      return;
    }

    content.forEach((part, pi) => {
      if (part.type === "text") {
        const text = part.text.trim();
        if (text) {
          out.push({
            id: `${m.id ?? mi}-t${pi}`,
            kind: "agent",
            name: agentName,
            detail: model || undefined,
            text,
          });
        }
        return;
      }
      if (part.type !== "tool-call") return;

      const id = part.toolCallId || `${m.id ?? mi}-c${pi}`;
      if (isTask(part.toolName.toLowerCase())) {
        // Same reading TaskCards (agentviews.tsx) uses for a Task dispatch.
        const kind = pick(part.args, "subagent_type", "agent", "type") || "agent";
        const label = pick(part.args, "description", "prompt", "task") || kind;
        out.push({ id, kind: "subagent", name: kind, text: label });
        return;
      }

      out.push({
        id,
        kind: "tool",
        name: part.toolName,
        detail: firstArgValue(part.args) || undefined,
        text: resultText(part.result).trim(),
      });
    });
  });
  return out;
}

export function Speakers() {
  const active = useBoard(selectActiveConsole);
  const messages = active?.transcript.messages ?? [];
  const all = buildTurns(messages, active?.agent || "agent", active?.model || "");

  // The last six entries only: this card answers "who's been talking",
  // not "show me the whole session" — a full transcript belongs to the
  // thread view, not a glanceable dashboard card. Twelve measured 785px
  // inside a panel column that is 46vh tall, which is the whole session
  // again in the place that exists to summarise it.
  //
  // ⚠️ AND EACH ONE IS CLIPPED. Measured against a real turn, twelve entries
  // carrying their full text made an 851px card inside a panel column that is
  // 46vh tall — it WAS the whole session, in the place that exists to
  // summarise it. A line or two each is what "who said what" needs; the
  // transcript above has the rest, in full, already.
  const turns = all.slice(-6).map((t) =>
    t.text.length > 180 ? { ...t, text: `${t.text.slice(0, 180).trimEnd()}…` } : t,
  );
  if (turns.length < 2) return null;

  return <SpeakerIdentity turns={turns} className="max-w-none" />;
}

/**
 * The row that holds it.
 *
 * ⚠️ NOT ALWAYS OPEN. ReadAloud renders the whole answer again, word by word,
 * so it can highlight the one being spoken — about 300px of the conversation
 * column, permanently, saying what the transcript directly above it already
 * says. Same rule as the meters and the turn detail: a closed row, and the
 * word count on it so you know what you are about to hear.
 */
export function ListenShelf() {
  const active = useBoard(selectActiveConsole);
  const [open, setOpen] = useState(false);
  const messages = active?.transcript.messages ?? [];
  const turn = lastAssistantMessage(messages);
  const words = turn ? wordsOf(turn.content) : [];

  // Nothing said yet, or a turn that was all tool calls. Also nothing at all
  // in a browser with no speech synthesis, which ReadAloud checks for itself.
  if (!words.length || typeof window === "undefined" || !window.speechSynthesis) return null;

  return (
    <div className="listen-shelf">
      <button
        type="button"
        className="run-meters-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRightIcon className="chev size-3.5 shrink-0 opacity-60" />
        <span>Read aloud</span>
        <span className="spacer" />
        <span className="tabular-nums">{words.length} words</span>
      </button>
      {open ? (
        <div className="listen-shelf-body">
          <ReadAloud />
        </div>
      ) : null}
    </div>
  );
}
