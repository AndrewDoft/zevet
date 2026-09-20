#!/usr/bin/env node
/**
 * Regenerate the free-model list the launcher offers for opencode.
 *
 * MODELS.opencode in src/lib/constants.ts was three OpenRouter ids typed by
 * hand. The free tier churns weekly — models appear, get renamed, and go away —
 * so a hand-kept list is wrong shortly after it is written, and the way it is
 * wrong is invisible: the launcher offers a model, opencode fails to resolve it
 * at spawn, and the console dies with a message nobody connects to this file.
 *
 * So this derives the list instead, by rule:
 *
 *   free        both prompt and completion priced at zero
 *   text        emits text — drops music, embedding and safety-classifier models
 *   addressable not the `openrouter/` meta namespace: those pick a backing model
 *               at call time, or hide the lab behind a codename, and neither can
 *               satisfy the origin rule
 *   origin      made by a lab on ORG_ALLOW — an ALLOWLIST, not a denylist of labs
 *               to avoid. A denylist fails open: the next lab nobody has heard of
 *               ships to users by default. An unrecognised org is dropped and
 *               reported, never silently included.
 *   size        at least MIN_ACTIVE_B ACTIVE params, so a 3B model does not reach
 *               a user behind a name that sounds capable
 *
 * Every id it emits is addressed the way zevet spawns it — `opencode run -m <id>`
 * — so what the launcher offers is exactly what the CLI accepts.
 *
 *     node scripts/sync-models.mjs             # rewrite the generated file
 *     node scripts/sync-models.mjs --dry-run   # print every verdict, write nothing
 *     node scripts/sync-models.mjs --check     # exit 1 if it would change
 *
 * The output is COMMITTED. A user launching a console has no network budget for
 * a provider round trip, and the app must offer models offline.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "src", "lib", "models.generated.mjs");
const OUT_TYPES = path.join(HERE, "..", "src", "lib", "models.generated.d.mts");
const OR_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** Minimum ACTIVE billions of params. Set just above Nemotron 3.5 Lightning
 *  (3B active), which is small enough to corrupt file paths in an agent loop. */
const MIN_ACTIVE_B = 6;

/** Labs whose models may be offered. Extend deliberately, never in code. */
const ORG_ALLOW = new Set([
  "google", "nvidia", "meta", "meta-llama", "cohere", "poolside",
  "thinkingmachines", "mistralai", "liquid", "allenai", "ai2", "microsoft",
  "ibm", "granite", "amazon", "apple", "xai", "openai", "anthropic",
  "perplexity", "reka", "nousresearch", "arcee", "sarvam",
]);

/** opencode's own ids carry no org prefix, so origin comes from the name.
 *
 *  ⚠️ Matched at a word boundary, never as a bare substring: "ling" occurs
 *  inside "inkling", and a plain includes() attributes Thinking Machines'
 *  model to InclusionAI — which reads as a policy exclusion and silently
 *  removes a legitimate model from the picker. */
const NAME_ORG = [
  ["muse-spark", "meta"], ["muse-glimmer", "meta"], ["llama", "meta"],
  ["nemotron", "nvidia"], ["gpt-oss", "openai"], ["gemma", "google"],
  ["north", "cohere"], ["command", "cohere"], ["laguna", "poolside"],
  ["inkling", "thinkingmachines"], ["mimo", "xiaomi"], ["ling", "inclusionai"],
  ["qwen", "qwen"], ["glm", "z-ai"], ["deepseek", "deepseek"],
  ["kimi", "moonshotai"], ["minimax", "minimax"], ["dots", "dots-studio"],
];

/** True when `frag` starts a dash-separated word of `name`, or is all of it.
 *  Written as a scan rather than a built RegExp so there is no escaping to get
 *  wrong: these fragments contain `.` and `-`, which a naive pattern would
 *  treat as metacharacters. */
const AT_EDGE = (c) => c === undefined || c === "-" || c === "_" || c === ".";
function namesLab(name, frag) {
  for (let i = name.indexOf(frag); i !== -1; i = name.indexOf(frag, i + 1)) {
    const before = i === 0 ? undefined : name[i - 1];
    const after = name[i + frag.length];
    if (AT_EDGE(before) && (AT_EDGE(after) || /\d/.test(after ?? ""))) return true;
  }
  return false;
}

/** Not general-purpose text generators. The modality field alone misses these:
 *  a music or safety model still advertises text INPUT. */
const NOT_GENERAL = ["lyria", "content-safety", "guard", "moderation", "embed",
  "rerank", "whisper", "-tts", "-stt", "image", "diffusion"];

/** Active params for models whose id does not state them. Without this a sparse
 *  model ships behind a marketing name: Lightning is 3B active. */
const ACTIVE_OVERRIDE = [["lightning", 3], ["muse-glimmer", 3]];

const orgOf = (id) => {
  const slash = id.indexOf("/");
  if (slash > 0 && !id.startsWith("opencode/")) return id.slice(0, slash).toLowerCase();
  const body = (slash > 0 ? id.slice(slash + 1) : id).toLowerCase();
  return NAME_ORG.find(([frag]) => namesLab(body, frag))?.[1] ?? "";
};

const activeB = (id) => {
  const low = id.toLowerCase();
  const sparse = low.match(/[-_](\d+(?:\.\d+)?)b[-_]a(\d+(?:\.\d+)?)b/);
  if (sparse) return Number(sparse[2]);
  const dense = low.match(/[-_](\d+(?:\.\d+)?)b(?![a-z0-9])/);
  if (dense) return Number(dense[1]);
  return ACTIVE_OVERRIDE.find(([frag]) => low.includes(frag))?.[1] ?? null;
};

/** "ok", or a sentence saying why this model is not offered. */
function verdict(id, outputModalities) {
  if (id.startsWith("openrouter/")) return "openrouter/ meta namespace";
  const low = id.toLowerCase();
  const bad = NOT_GENERAL.find((f) => low.includes(f));
  if (bad) return `not a general text model (${bad.replace(/^-/, "")})`;
  if (outputModalities?.length && !outputModalities.includes("text")) {
    return `cannot emit text (${outputModalities.join(",")})`;
  }
  const org = orgOf(id);
  if (!org) return "origin unknown: no lab resolves from the id";
  if (!ORG_ALLOW.has(org)) return `origin not on the allowlist (${org})`;
  const n = activeB(id);
  if (n !== null && n < MIN_ACTIVE_B) return `${n}B active < ${MIN_ACTIVE_B}B floor`;
  return "ok";
}

async function openrouterFree() {
  const res = await fetch(OR_MODELS_URL, { headers: { "user-agent": "zevet/sync-models" } });
  if (!res.ok) throw new Error(`OpenRouter returned ${res.status}`);
  const { data } = await res.json();
  return data
    .filter((m) => Number(m.pricing?.prompt ?? 1) === 0 && Number(m.pricing?.completion ?? 1) === 0)
    .map((m) => ({
      id: m.id,
      out: m.architecture?.output_modalities ?? [],
      // zevet spawns `opencode run -m <id>`, and opencode addresses an
      // OpenRouter model with this prefix. Offering the bare id would put a
      // model in the picker that the CLI cannot resolve.
      spawn: `openrouter/${m.id}`,
    }));
}

function opencodeZen() {
  let out;
  try {
    // execSync, not execFileSync: on Windows opencode is a .cmd shim, which
    // execFileSync will not resolve. Without a shell this returns nothing and
    // the zen models vanish from the picker with no error to explain it. The
    // command is a literal — nothing here is interpolated from input.
    out = execSync("opencode models", { encoding: "utf8", timeout: 90_000 });
  } catch {
    // opencode absent or not signed in. OpenRouter alone still produces a list,
    // which is the right outcome: the person running this may not be the person
    // who has opencode installed.
    return [];
  }
  return out
    .split("\n").map((l) => l.trim())
    .filter((id) => id.startsWith("opencode/") && id.endsWith("-free"))
    .map((id) => ({ id, out: [], spawn: id }));
}

const header = (rows, dropped) => `// GENERATED by board/scripts/sync-models.mjs — do not edit by hand.
// Re-run \`node scripts/sync-models.mjs\` from board/ to refresh.
// test/models.test.mjs asserts the rules below still hold for what is here.
//
// Free models the launcher offers for opencode, derived from OpenRouter and
// \`opencode models\`, filtered by rule: free, emits text, made by a lab on an
// allowlist, and at least ${MIN_ACTIVE_B}B active params. ${dropped} candidate(s) were dropped;
// run with --dry-run to see each one and why.
//
// Generated ${new Date().toISOString().slice(0, 10)} — ${rows.length} model(s).
`;

const body = (rows) => `
/** Model ids \`opencode run -m <id>\` accepts, vetted and free. */
export const OPENCODE_FREE_MODELS = [
${rows.map((r) => `  ${JSON.stringify(r.spawn)},`).join("\n")}
];
`;

const types = `/** Model ids \`opencode run -m <id>\` accepts, vetted and free. */
export const OPENCODE_FREE_MODELS: readonly string[];
`;

const args = new Set(process.argv.slice(2));
const found = [...opencodeZen(), ...(await openrouterFree())];

const kept = [];
const dropped = [];
const seen = new Set();
for (const m of found) {
  const why = verdict(m.id, m.out);
  if (why !== "ok") { dropped.push([m.id, why]); continue; }
  // The same model offered by both providers: opencode's own id wins, because
  // it needs no OpenRouter key and is not subject to the free-tier daily cap.
  const key = m.id.split("/").pop()
    .replace(/:free|-free|-contributor|-preview|-it/g, "")
    .replace(/[-_]\d+(?:\.\d+)?b(?:[-_]a\d+(?:\.\d+)?b)?/g, "");
  if (seen.has(key)) { dropped.push([m.id, `duplicate of ${key}`]); continue; }
  seen.add(key);
  kept.push(m);
}
kept.sort((a, b) => a.spawn.localeCompare(b.spawn));

// Every branch sets process.exitCode and falls through rather than calling
// process.exit(). exit() tears down the loop while the `opencode models` child
// handle is still closing, and libuv asserts on Windows — which would turn a
// passing --check into a CI failure reporting async.c.
if (args.has("--dry-run")) {
  for (const k of kept) console.log("  +", k.spawn);
  for (const [id, why] of dropped) console.log("  -", id, "—", why);
  console.log(`\n${kept.length} routable, ${dropped.length} dropped`);
} else if (args.has("--check")) {
  let current = "";
  try { current = readFileSync(OUT, "utf8"); } catch { /* absent counts as changed */ }
  // The date line moves every day; compare only the list itself.
  const list = (t) => t.slice(t.indexOf("OPENCODE_FREE_MODELS"));
  if (list(current) !== list(body(kept))) {
    console.error("sync-models: the generated list is stale. Run scripts/sync-models.mjs.");
    process.exitCode = 1;
  } else {
    console.log("sync-models: up to date.");
  }
} else if (!kept.length) {
  // Never write an empty list. Both providers being unreachable is a network
  // failure, and overwriting a good committed list with nothing would take the
  // launcher's opencode models away from everyone on the next build.
  console.error("sync-models: no models resolved — leaving the committed list alone.");
  process.exitCode = 1;
} else {
  writeFileSync(OUT, header(kept, dropped.length) + body(kept));
  writeFileSync(OUT_TYPES, types);
  console.log(`sync-models: wrote ${kept.length} model(s), dropped ${dropped.length}.`);
}
