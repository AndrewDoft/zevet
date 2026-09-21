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
for (const file of walk(path.join(SRC, "components", "assistant-ui"))) {
  if (!/\.(tsx?|ts)$/.test(file)) continue;
  const before = readFileSync(file, "utf8");
  const after = before.replace(/(["'])@\/components\/([a-z0-9.-]+)\1/g, (whole, q, base) => {
    const declared = [...wanted.values()].find(
      (p) => p.replace(/^components\//, "").replace(/\.tsx?$/, "") === `assistant-ui/elements/${base}`,
    );
    return declared ? `${q}@/components/assistant-ui/elements/${base}${q}` : whole;
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
    file: "components/assistant-ui/elements/connection-state.tsx",
    // zevet's hub relays events and runs nothing. The agent that kept going is
    // on somebody's own machine — the opposite claim, and the reassuring one.
    from: "Connection lost. The run kept going on the server.",
    to: "Lost the hub. Your agents keep running on their own machines.",
  },
  {
    file: "components/assistant-ui/elements/checkpoint-history.tsx",
    // A commit that touched one file said "1 files". Not a false claim, but
    // the count beside it is read off git and the sloppiness undercuts it.
    from: "{checkpoint.at} · {checkpoint.files} files",
    to: '{checkpoint.at} · {checkpoint.files} {checkpoint.files === 1 ? "file" : "files"}',
  },
];

let copied = 0;
for (const { file, from, to } of COPY) {
  const full = path.join(SRC, file);
  if (!statSync(full, { throwIfNoEntry: false })) continue;
  const before = readFileSync(full, "utf8");
  if (before.includes(to)) continue;
  if (!before.includes(from)) {
    console.error(`  ! ${file}: upstream copy changed — re-check "${from.slice(0, 40)}…"`);
    continue;
  }
  writeFileSync(full, before.replace(from, to));
  console.log(`  corrected copy in ${file}`);
  copied++;
}
if (copied) console.log(`corrected ${copied} sentence(s) that were wrong for zevet`);
