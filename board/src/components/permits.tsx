/**
 * Computer-use permits: the loopback gate desktop/ask-server.js runs in
 * front of desktop/zevet-mcp.js. Every click, keystroke, key press and
 * screenshot the agent asks for lands in `s.permits` (board.ts's
 * `onPermitRequest` subscription) and sits there until `answerPermit`
 * answers it — the agent genuinely blocks on the reply.
 *
 * Reader helpers (`rec`/`str`) are duplicated from moreviews.tsx rather than
 * imported, same reasoning as that file gives for duplicating them from
 * agentviews.tsx: nothing here exports them.
 */
"use client";

import type { ThreadMessageLike } from "@assistant-ui/react";
import { cn } from "@/lib/utils";
import {
  ComputerUse as ComputerUseCard,
  type ComputerStep,
} from "./assistant-ui/elements/computer-use";
import { PermissionGrant, type GrantScope } from "./assistant-ui/elements/permission-grant";
import { field, mono } from "./assistant-ui/elements/surfaces";
import { pct } from "./assistant-ui/utils/range";
import { answerPermit, selectActiveConsole, useBoard } from "../lib/board";
import type { PermitRequest } from "../lib/bridge";

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function str(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

/* ---------------------------------------------------------------------------
 * PermitPrompt — elements/permission-grant.tsx over the oldest unanswered
 * permit. `s.permits` is pushed to as requests arrive, so index 0 is the
 * oldest — the one actually blocking the agent right now.
 * ------------------------------------------------------------------------- */

/** What the agent asked for, in plain words — `args` is model output, so
 *  every value here goes through PermissionGrant as a plain string child,
 *  never markup, and JSX text interpolation can't be reinterpreted as HTML. */
function reachFor(p: PermitRequest): string[] {
  // `arguments` is the wire name; `args` only for an older desktop build. See
  // PermitRequest in lib/bridge.ts.
  const args = rec(p.arguments ?? p.args);
  const out: string[] = [];
  switch (p.tool) {
    case "click": {
      const x = args.x;
      const y = args.y;
      if (x != null && y != null) out.push(`click at (${str(x)}, ${str(y)})`);
      const button = str(args.button);
      if (button && button !== "left") out.push(`${button} button`);
      break;
    }
    case "type_text":
      out.push(`type: ${str(args.text)}`);
      break;
    case "press_key":
      out.push(`press "${str(args.key)}"`);
      break;
    case "screenshot":
      out.push("capture the full screen");
      break;
    default:
      break;
  }
  if (p.detail) out.push(p.detail);
  /* ⚠️ NEVER AN EMPTY LIST. This card is the only thing standing between an
     agent and the mouse, and "this grants" with nothing under it is worse than
     no card — it reads as "nothing much". Anything the switch above has no
     wording for gets printed as it arrived, and a request that carries nothing
     at all says so in as many words. Still plain strings: PermissionGrant
     takes these as text children, so model output cannot become markup. */
  if (!out.length) {
    for (const [k, v] of Object.entries(args)) {
      out.push(`${k}: ${str(v, JSON.stringify(v))}`);
    }
  }
  if (!out.length) out.push("the agent sent no details with this request");
  return out;
}

export function PermitPrompt() {
  const permit = useBoard((s) => s.permits[0]);
  if (!permit) return null;

  return (
    <PermissionGrant
      capability={permit.tool || "action"}
      requester="the agent"
      reach={reachFor(permit)}
      scope="pending"
      onGrant={(scope: GrantScope) => {
        // PermissionGrant's vocabulary is "denied" / "session" / "always",
        // but zevet answers one request at a time and keeps no standing
        // grant — there is no "once" scope to wire and no memory behind
        // "always". "This session" is repurposed as the one real Allow
        // (answers just this request, same as every other answer would);
        // "Always" is left unhandled because PermissionGrant HAS NO SUCH
        // BUTTON: elements/permission-grant.tsx renders exactly two, calling
        // onGrant("denied") and onGrant("session"). The scope is in its type
        // and not in its UI.
        //
        // ⚠️ THE NOTE HERE USED TO SAY "Always" WAS THE PROMINENT, FILLED
        // BUTTON, and that leaving it inert defused an accidental click. That
        // was stale, and on 2026-09-21 a reviewer reading this file alone
        // reported the dead branch as a live bug — reasonably, because the
        // comment said the button was on screen. Kept as a branch rather than
        // deleted so that the day the element grows one, this fails loudly
        // here instead of silently granting something zevet cannot remember.
        if (scope === "denied") void answerPermit(permit.id, false);
        else if (scope === "session") void answerPermit(permit.id, true);
      }}
    />
  );
}

/* ---------------------------------------------------------------------------
 * PermitQueue — elements/approval-card.tsx was refused: ApprovalCard is
 * built for exactly one command (one `state`, one `command` string, one set
 * of buttons) with no way to show a second waiting item, let alone a count.
 * Bending a queue into "one card, rendered N times" isn't what the element
 * is for and would just duplicate PermitPrompt. So per the brief, this
 * renders only the honest fact ApprovalCard can't: how many more are
 * waiting behind the one PermitPrompt already shows.
 * ------------------------------------------------------------------------- */

export function PermitQueue() {
  const waiting = useBoard((s) => s.permits.length);
  if (waiting < 2) return null;

  return (
    <span className={cn(field, mono, "text-foreground/45 w-fit rounded-full px-2.5 py-1")}>
      +{waiting - 1} more waiting
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * ComputerUse — elements/computer-use.tsx, one card per screenshot the agent
 * took, with the clicks made against that exact picture drawn on it.
 * ------------------------------------------------------------------------- */

interface ToolCallLike {
  type: "tool-call";
  toolCallId?: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
}

function toolCalls(content: ThreadMessageLike["content"]): ToolCallLike[] {
  if (!Array.isArray(content)) return [];
  return content.filter((p) => p.type === "tool-call") as unknown as ToolCallLike[];
}

const isShot = (n: string) => n === "mcp__zevet__screenshot";
const isClick = (n: string) => n === "mcp__zevet__click";

/** The base64 PNG, as a data URL — MCP's own image content block
 *  (`{type:"image", data, mimeType}`), passed through the transcript
 *  verbatim rather than translated to Anthropic's own image block shape. */
function imageDataUrl(result: unknown): string | undefined {
  if (!Array.isArray(result)) return undefined;
  for (const part of result) {
    const p = rec(part);
    if (p.type === "image" && typeof p.data === "string") {
      return `data:${str(p.mimeType, "image/png")};base64,${p.data}`;
    }
  }
  return undefined;
}

/** Just the text content blocks, joined — deliberately not the reusable
 *  `resultText` sweep other files use, because that would JSON.stringify
 *  the sibling image block's multi-MB base64 payload just to regex a size
 *  out of the text next to it. */
function textParts(result: unknown): string {
  if (!Array.isArray(result)) return "";
  return result
    .filter((p) => rec(p).type === "text")
    .map((p) => str(rec(p).text))
    .join("\n");
}

/** zevet-mcp's screenshot result appends "(screen WxH)" to its text part
 *  when it could read the display size (desktop/zevet-mcp.js's
 *  doScreenshot) — the only honest source for the pixel dimensions a
 *  click's real x/y need to become a percent position on the picture. */
function screenSize(result: unknown): { width: number; height: number } | undefined {
  const m = /screen (\d+)x(\d+)/.exec(textParts(result));
  return m ? { width: Number(m[1]), height: Number(m[2]) } : undefined;
}

interface Shot {
  id: string;
  dataUrl: string;
  label: string;
  steps: ComputerStep[];
}

/**
 * One entry per screenshot call that actually carried an image, each
 * holding the clicks that came after it and before the next screenshot —
 * pairing every click with the most recent screenshot BEFORE it, in
 * transcript order, because that is the picture the agent was looking at
 * when it chose where to click. A click drawn on a later screenshot would
 * be a claim about a decision that was never made, so a click with no
 * preceding screenshot (or one whose size never came back, so its pixel
 * coordinates can't honestly become a percent) is dropped, not guessed.
 */
function shotsWithSteps(messages: readonly ThreadMessageLike[]): Shot[] {
  const shots: Shot[] = [];
  let current: Shot | undefined;
  let dims: { width: number; height: number } | undefined;

  for (const m of messages) {
    for (const c of toolCalls(m.content)) {
      if (typeof c.toolName !== "string") continue;
      const name = c.toolName.toLowerCase();
      if (isShot(name)) {
        const dataUrl = imageDataUrl(c.result);
        if (!dataUrl) {
          current = undefined;
          dims = undefined;
          continue;
        }
        dims = screenSize(c.result);
        current = {
          id: c.toolCallId ?? `shot-${shots.length}`,
          dataUrl,
          label: dims ? `${dims.width}×${dims.height}` : "screenshot",
          steps: [],
        };
        shots.push(current);
      } else if (isClick(name) && current && dims) {
        const args = rec(c.args);
        const x = Number(args.x);
        const y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const button = str(args.button, "left");
        current.steps.push({
          id: c.toolCallId ?? `${current.id}-click-${current.steps.length}`,
          action: button === "left" ? "click" : `${button} click`,
          target: `${x}, ${y}`,
          x: pct(x, dims.width),
          y: pct(y, dims.height),
        });
      }
    }
  }
  return shots;
}

export function ComputerUse() {
  const messages = useBoard((s) => selectActiveConsole(s)?.transcript.messages) ?? [];
  const shots = shotsWithSteps(messages);
  if (!shots.length) return null;

  return (
    <div className="flex w-full flex-col gap-2">
      {shots.map((shot) => (
        <ComputerUseCard
          key={shot.id}
          url={shot.label}
          steps={shot.steps}
          activeIndex={shot.steps.length - 1}
        >
          {/* Plain flow, no object-fit crop: the img's own aspect ratio
           *  sets this container's box, so the dots' percent positions
           *  (computed against the real screen size above) land exactly
           *  where computer.js clicked, regardless of the screenshot's
           *  own resolution. */}
          <img src={shot.dataUrl} alt="" className="block h-auto w-full" />
        </ComputerUseCard>
      ))}
    </div>
  );
}
