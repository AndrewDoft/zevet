#!/usr/bin/env node
/**
 * Put assistant-ui registry files where the registry says they go.
 *
 * `npx shadcn add @assistant-ui/<item>` resolves `registry:component` against
 * `aliases.components` using only the BASENAME, so every item lands flat in
 * `src/components/`. The registry's own manifests declare nested paths —
 *
 *     components/assistant-ui/elements/thread.aui.tsx
 *     components/assistant-ui/utils/range.ts
 *
 * — and the files import each other through those paths (`../utils/range`,
 * `@/components/assistant-ui/elements/attachment.aui`). Flattened, none of it
 * resolves: the first install produced 38 TS2307s.
 *
 * So: after any `shadcn add`, run this. It reads each manifest, and for every
 * file whose declared path differs from where shadcn put it, moves it there.
 * Idempotent — a file already in the right place is left alone.
 *
 *     node scripts/sync-registry.mjs            # every item in ITEMS
 *     node scripts/sync-registry.mjs thread     # just these
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");
const STYLE = JSON.parse(readFileSync(path.join(HERE, "..", "components.json"), "utf8")).style;

/** Every assistant-ui item the board installs. Keep in sync with what the UI
 *  actually imports; an item listed here that nothing imports is dead weight
 *  in the bundle. */
export const ITEMS = [
  // syntax-highlighter is deliberately NOT installed: it brings a second
  // highlighting engine. components/highlight.tsx serves the same role.
  "thread", "thread-list", "markdown-text",
  "attachment", "file", "image", "reasoning", "tool-fallback", "tool-group",
  "follow-up-suggestions", "tooltip-icon-button", "model-selector",
  "elements-surfaces", "elements-range", "elements-task",
  "elements-composer", "elements-message-pair", "elements-message-actions",
  "elements-scroll-anchor", "elements-empty-state", "elements-day-separator",
  "elements-error-state", "elements-streaming-text", "elements-typing-indicator",
  "elements-loading-state", "elements-tool-call", "elements-tool-group",
  "elements-tool-timeline", "elements-tool-error", "elements-reasoning-panel",
  "elements-terminal-block", "elements-todo-list", "elements-subagent-list",
  "elements-stopped-run", "elements-agent-card", "elements-agent-status",
  "elements-connection-state", "elements-thread-list", "elements-activity-graph",
  "elements-cost-meter", "elements-context-breakdown", "elements-message-timing",
  "elements-file-tree", "elements-command-palette", "elements-code-diff",
  "elements-reviewable-diff", "elements-approval-card", "elements-permission-grant",
  "elements-reasoning-effort", "elements-model-picker", "elements-job-progress",
  "elements-quota-banner", "elements-settings-panel", "elements-guardrail-notice",
  "elements-task-card", "elements-timeline", "elements-web-search",
  "elements-web-preview", "sources", "elements-data-table",
  "elements-conversation-search", "elements-thread-search",
  "elements-number-ticker", "elements-checkpoint-history",
  "elements-regenerate-menu", "elements-edit-message", "elements-quote-reply",
  "elements-trace-waterfall", "elements-message-queue",
  "elements-document-reference", "elements-inline-citation",
  "elements-agent-plan", "elements-task-card", "elements-recommendation-card",
  "elements-artifact-card", "elements-agent-card", "elements-agent-handoff",
  "elements-background-inbox", "elements-schedule-card", "elements-draft-restore",
  "elements-prompt-library", "elements-command-palette", "elements-checkpoint-history",
  "elements-thinking-indicator", "elements-mcp-server-panel",
  "elements-computer-use", "elements-code-runner",
  // 0.2.16 — knowledge and structured output.
  "elements-image-generation", "elements-retrieval-chunks", "elements-memory-chips",
  "elements-research-report", "elements-map-answer", "elements-chart",
  "elements-diagram", "elements-flow-graph", "elements-math-block",
  "elements-spec-sheet", "elements-comparison-card", "elements-score-breakdown",
  // 0.2.16 — renderers, primitives and the rest of the thread surfaces.
  "syntax-highlighter", "shiki-highlighter", "generative-ui",
  "logos", "heat-graph", "assistant-modal", "assistant-sidebar",
  "threadlist-sidebar", "voice", "context-display", "mcp-config", "quote",
  "composer-trigger-popover", "directive-text", "elements-chat-panel",
  "elements-canvas-split", "elements-shared-conversation",
  "elements-launcher-bubble", "elements-onboarding", "elements-mobile-composer",
  "elements-conversation-map",
  // 0.2.16 — the last of the thread and voice items.
  "elements-message-branches", "elements-feedback-dialog",
  "elements-speaker-identity", "elements-confidence-marker",
  "elements-elicitation-form", "elements-voice-conversation",
  "elements-read-aloud",
];

const manifestUrl = (name) =>
  name.startsWith("http") ? name : `https://r.assistant-ui.com/styles/${STYLE}/${name}.json`;

const seen = new Set();
const wanted = new Map(); // basename -> declared path, relative to src/

async function collect(name) {
  const url = manifestUrl(name);
  if (seen.has(url)) return;
  seen.add(url);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`  ! ${name} → ${res.status}`);
    return;
  }
  const item = await res.json();
  for (const f of item.files ?? []) {
    const declared = f.target || f.path;
    if (!declared) continue;
    wanted.set(path.basename(declared), declared.replace(/^src\//, ""));
  }
  // Only follow assistant-ui's own deps. `button`, `collapsible` and friends
  // are shadcn's, and those DO land correctly under components/ui.
  for (const dep of item.registryDependencies ?? []) {
    if (dep.startsWith("http") && dep.includes("assistant-ui")) await collect(dep);
  }
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : ITEMS;
for (const name of names) await collect(name);

let moved = 0;
for (const file of walk(SRC)) {
  const rel = path.relative(SRC, file).split(path.sep).join("/");
  const declared = wanted.get(path.basename(file));
  if (!declared || rel === declared) continue;
  // Only ever move a file OUT of the flat components/ dump. A file the board
  // wrote itself, in its own directory, is not the registry's to relocate.
  if (path.dirname(rel) !== "components") continue;
  const dest = path.join(SRC, declared);
  mkdirSync(path.dirname(dest), { recursive: true });
  if (statSync(dest, { throwIfNoEntry: false })) rmSync(dest);
  renameSync(file, dest);
  console.log(`  ${rel} -> ${declared}`);
  moved++;
}
console.log(moved ? `moved ${moved} file(s) into place` : "nothing to move");

/* Some published files disagree with their own manifest: thread.aui.tsx
 * imports `@/components/markdown-text` while every manifest that declares
 * markdown-text puts it at components/assistant-ui/elements/. Upstream's bug,
 * and one that re-appears on every re-install — so it is repaired here rather
 * than by hand. Only imports whose basename the registry actually placed are
 * touched; anything else is the board's own and is left alone. */
let fixed = 0;
/* Every directory the registry drops files into. Walking only assistant-ui was
 * enough until an item shipped an icon under components/icons. */
const REPAIR_DIRS = ["assistant-ui", "icons"];
for (const dir of REPAIR_DIRS)
for (const file of walk(path.join(SRC, "components", dir))) {
  if (!/\.(tsx?|ts)$/.test(file)) continue;
  const before = readFileSync(file, "utf8");
  const after = before.replace(/(["'])@\/components\/([a-z0-9.-]+)\1/g, (whole, q, base) => {
    // FOLLOW THE MANIFEST; do not assume a directory. This used to rewrite
    // every such import to assistant-ui/elements/, which is where most items
    // land — and then threadlist-sidebar shipped importing `@/components/github`
    // while its own manifest puts that icon under components/icons/, so the
    // import was left broken. `wanted` already knows where each basename goes.
    const declared = wanted.get(`${base}.tsx`) || wanted.get(`${base}.ts`);
    if (!declared) return whole;
    const target = declared.replace(/^components\//, "").replace(/\.tsx?$/, "");
    return `${q}@/components/${target}${q}`;
  });
  if (after !== before) {
    writeFileSync(file, after);
    console.log(`  repaired imports in ${path.relative(SRC, file).split(path.sep).join("/")}`);
    fixed++;
  }
}
if (fixed) console.log(`repaired ${fixed} file(s) whose imports disagreed with the manifest`);

/* Copy that is wrong for this product.
 *
 * These are not style preferences. Each one is a sentence the registry ships
 * that states something FALSE about zevet, so it has to survive a re-install
 * the same way the import repairs do. Keep the list short and keep the reason
 * on every entry; anything that is merely a wording preference does not belong
 * here, because every entry is a patch that has to be re-checked when upstream
 * rewrites the file. */
const COPY = [
  {
    file: "components/assistant-ui/elements/thread.aui.tsx",
    // Andrew, on 0.2.20: "there needs to be the model selector, the effort
    // selector, context, etc. in the chatbox, not above in that weird way."
    // They were a strip sitting above the transcript, which read as a settings
    // screen the conversation happened to be under. The composer's own action
    // row is where they belong — beside the attachment and mic buttons.
    //
    // Everything is kept in components/composercontrols.tsx so this patch
    // stays two lines: the vendored file is re-fetched on every re-install,
    // and the more of it we rewrite the more of it we have to re-check.
    from: 'import { File } from "@/components/assistant-ui/elements/file";',
    to: 'import { File } from "@/components/assistant-ui/elements/file";\nimport { ComposerControls } from "@/components/composercontrols";',
  },
  {
    file: "components/assistant-ui/elements/thread.aui.tsx",
    from: `      <ComposerAddAttachment />
      <div className="flex items-center gap-1.5">`,
    to: `      <div className="flex min-w-0 items-center gap-1.5">
        <ComposerAddAttachment />
        <ComposerControls />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">`,
  },
  {
    file: "components/assistant-ui/elements/permission-grant.tsx",
    // ⚠️ TWO BUTTONS PROMISING A STANDING GRANT zevet does not have. The
    // element offers "This session" and "Always", and nothing here records a
    // grant of any duration — every request is asked, every time. So "Always"
    // would silently ask again on the next call, and "This session" names a
    // scope that does not exist. Deleting the one and renaming the other
    // leaves exactly what is true: allow this, or deny it.
    //
    // Dropping "Always" also fixes the emphasis. It was the only filled
    // button, so the loudest thing on a card asking to click somebody's
    // desktop was the most permissive answer.
    from: `              <button
                type="button"
                onClick={() => onGrant("session")}
                className="text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/90 h-8 rounded-full px-3 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96]"
              >
                This session
              </button>
              <button
                type="button"
                onClick={() => onGrant("always")}
                className={cn(
                  inkButton,
                  "flex h-8 items-center rounded-full px-3 text-xs font-medium",
                )}
              >
                Always
              </button>`,
    to: `              <button
                type="button"
                onClick={() => onGrant("session")}
                className="text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/90 h-8 rounded-full px-3 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96]"
              >
                Allow once
              </button>`,
  },
  {
    file: "components/assistant-ui/elements/permission-grant.tsx",
    // And the receipt afterwards said "granted · session" for the same reason.
    from: '{scope === "denied" ? "denied" : `granted · ${scope}`}',
    to: '{scope === "denied" ? "denied" : "allowed once"}',
  },
  {
    file: "components/assistant-ui/elements/permission-grant.tsx",
    // `inkButton` was only on the deleted "Always" button, and tsc fails the
    // build on an unused import. Removing the button has to remove it too.
    from: 'import { field, inkButton, mono, paper } from "./surfaces";',
    to: 'import { field, mono, paper } from "./surfaces";',
  },
  {
    file: "components/assistant-ui/elements/inline-citation.tsx",
    // The element ships as a DEMO: a hardcoded sentence about optimistic
    // updates, with exactly two citation slots baked into it. Its props say it
    // takes `sources`, so a caller hands it real search results and the
    // element attributes somebody else's prose to them. These three patches
    // make it do what the props already promise — the caller's own text, and
    // one chip per source — which is the only form in which it can be used
    // here at all.
    from: `export interface InlineCitationProps extends Omit<
  ComponentProps<"p">,
  "children"
> {`,
    to: `export interface InlineCitationProps extends ComponentProps<"p"> {`,
  },
  {
    file: "components/assistant-ui/elements/inline-citation.tsx",
    from: `export function InlineCitation({
  sources,`,
    to: `export function InlineCitation({
  children,
  sources,`,
  },
  {
    file: "components/assistant-ui/elements/inline-citation.tsx",
    from: `      Optimistic updates keep the thread responsive while the server confirms
      the write
      {sources[0] && (
        <Citation
          index={0}
          source={sources[0]}
          open={openIndex === 0}
          onOpenChange={(open) => onOpenIndexChange(open ? 0 : null)}
        />
      )}
      . The store already exposes a consistent snapshot for every subscriber
      {sources[1] && (
        <Citation
          index={1}
          source={sources[1]}
          open={openIndex === 1}
          onOpenChange={(open) => onOpenIndexChange(open ? 1 : null)}
        />
      )}
      , so no extra reconciliation pass is needed.`,
    to: `      {children}
      {sources.map((source, index) => (
        <Citation
          key={\`\${source.domain}-\${index}\`}
          index={index}
          source={source}
          open={openIndex === index}
          onOpenChange={(open) => onOpenIndexChange(open ? index : null)}
        />
      ))}`,
  },
  {
    file: "components/assistant-ui/elements/composer-trigger-popover.aui.tsx",
    // `process` does not exist in a browser and the board has no node types,
    // so this was a hard TS2591 on a clean install. vite's own build-time flag
    // asks the same question and compiles away in production.
    from: 'process.env.NODE_ENV !== "production"',
    to: "import.meta.env.DEV",
  },
  {
    file: "components/assistant-ui/elements/markdown-text.tsx",
    // Transcript code blocks render as plain <code> with no colour at all
    // unless a highlighter is handed to the markdown components — in a product
    // whose whole job is watching code change. This was a hand edit once, and
    // the next `shadcn add` silently took it back out; that is exactly what
    // this list exists to prevent. Not the registry's Prism or shiki one — see
    // components/highlight.tsx for why zevet uses its own side bundle.
    from: 'import { cn } from "@/lib/utils";',
    to: 'import { cn } from "@/lib/utils";\nimport { SyntaxHighlighter } from "@/components/highlight";',
  },
  {
    file: "components/assistant-ui/elements/markdown-text.tsx",
    from: "  CodeHeader,\n});",
    to: "  CodeHeader,\n  SyntaxHighlighter,\n});",
  },
  {
    file: "components/assistant-ui/elements/connection-state.tsx",
    // zevet's hub relays events and runs nothing. The agent that kept going is
    // on somebody's own machine — the opposite claim, and the reassuring one.
    from: "Connection lost. The run kept going on the server.",
    to: "Lost the hub. Your agents keep running on their own machines.",
  },
  {
    file: "components/assistant-ui/elements/document-reference.tsx",
    // The element was written for PDFs and counts pages. zevet's documents are
    // source files, and the anchors it cites are the line ranges an agent
    // actually read. "p. 412" of a file is a page that does not exist; the
    // number is right and only the unit was wrong.
    from: "{pages} pages · {anchors.length} cited",
    to: "read {anchors.length}× · through L{pages}",
  },
  {
    file: "components/assistant-ui/elements/document-reference.tsx",
    from: "p. {anchor.page}",
    to: "L{anchor.page}",
  },
  {
    file: "components/assistant-ui/elements/settings-panel.tsx",
    // `--append-system-prompt` is claude's flag; codex and opencode have no
    // equivalent (desktop/agent-console.js's invocationFor only ever adds it
    // for agent === "claude"). The registry's label doesn't say that, which
    // reads as "applies to whichever agent you're running" — false two-thirds
    // of the time. Said plainly instead of implied.
    from: "        <span className={cn(mono, \"text-foreground/30\")}>system prompt</span>",
    to: "        <span className={cn(mono, \"text-foreground/30\")}>system prompt · claude only</span>",
  },
  {
    file: "components/assistant-ui/elements/settings-panel.tsx",
    // None of zevet's three CLIs takes a temperature: not claude, not codex,
    // not opencode. The registry's panel requires the prop and renders a
    // slider bound to it unconditionally, so a caller with nothing to put
    // there was left inventing a number nothing reads. Made optional instead,
    // so `AgentSettings` (components/agentsettings.tsx) can leave it out and
    // the control simply does not render — see the next entry for the render
    // side of the same fix.
    from: "  temperature: number;",
    to: "  temperature?: number;",
  },
  {
    file: "components/assistant-ui/elements/settings-panel.tsx",
    from: `      <div className="flex flex-col gap-1.5">
        <span className="flex items-baseline justify-between">
          <span className={cn(mono, "text-foreground/30")}>temperature</span>
          <span className={cn(mono, "text-foreground/55 tabular-nums")}>
            {clamp(temperature, 0, 2).toFixed(1)}
          </span>
        </span>
        <input
          type="range"
          min={0}
          max={2}
          step={0.1}
          value={clamp(temperature, 0, 2)}
          aria-label="Temperature"
          onChange={(event) =>
            onTemperatureChange?.(Number(event.target.value))
          }
          className="accent-foreground/80 h-1 w-full cursor-pointer"
        />
      </div>`,
    to: `      {temperature !== undefined && (
        <div className="flex flex-col gap-1.5">
          <span className="flex items-baseline justify-between">
            <span className={cn(mono, "text-foreground/30")}>temperature</span>
            <span className={cn(mono, "text-foreground/55 tabular-nums")}>
              {clamp(temperature, 0, 2).toFixed(1)}
            </span>
          </span>
          <input
            type="range"
            min={0}
            max={2}
            step={0.1}
            value={clamp(temperature, 0, 2)}
            aria-label="Temperature"
            onChange={(event) =>
              onTemperatureChange?.(Number(event.target.value))
            }
            className="accent-foreground/80 h-1 w-full cursor-pointer"
          />
        </div>
      )}`,
  },
  {
    file: "components/assistant-ui/elements/checkpoint-history.tsx",
    // A commit that touched one file said "1 files". Not a false claim, but
    // the count beside it is read off git and the sloppiness undercuts it.
    from: "{checkpoint.at} · {checkpoint.files} files",
    to: '{checkpoint.at} · {checkpoint.files} {checkpoint.files === 1 ? "file" : "files"}',
  },
];

/* Line endings are not part of the patch. A `from` that spans lines is written
 * here with \n, the downloaded file may arrive with \r\n, and matching the one
 * against the other silently found nothing — which reads exactly like
 * "upstream changed the copy" and is not. Normalise both ends, then hand the
 * file back the endings it came with. */
const lf = (t) => t.replace(/\r\n/g, "\n");

let copied = 0;
for (const { file, from, to } of COPY) {
  const full = path.join(SRC, file);
  if (!statSync(full, { throwIfNoEntry: false })) continue;
  const raw = readFileSync(full, "utf8");
  const crlf = raw.includes("\r\n");
  const before = lf(raw);
  if (before.includes(lf(to))) continue;
  if (!before.includes(lf(from))) {
    console.error(`  ! ${file}: upstream copy changed — re-check "${lf(from).slice(0, 40)}…"`);
    continue;
  }
  const after = before.replace(lf(from), lf(to));
  writeFileSync(full, crlf ? after.replace(/\n/g, "\r\n") : after);
  console.log(`  corrected copy in ${file}`);
  copied++;
}
if (copied) console.log(`corrected ${copied} sentence(s) that were wrong for zevet`);
