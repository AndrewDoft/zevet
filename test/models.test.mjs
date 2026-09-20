// The free-model list the launcher offers is GENERATED from two providers'
// catalogues, so the rules that make it safe to ship have to be asserted on the
// output rather than trusted to the generator that produced it.
//
// ⚠️ WHY THIS EXISTS. board/scripts/sync-models.mjs is run by a person, and the
// day it is run is the day a provider has added something nobody expected. The
// diff is a list of model ids: it reads as noise and gets approved. These are
// the properties that must hold however the list was produced —
//
//   - every id resolves at `opencode run -m <id>`, or the launcher offers a
//     model that kills the console at spawn
//   - every id is free, or launching one bills the user
//   - no model from an origin the project does not ship
//   - no model below the active-parameter floor, which is about output quality
//     rather than policy: a 3B model in an agent loop corrupts file paths
//
// A failure here means the generated list is wrong, not that the rule is.
// Regenerate, or fix the rule in sync-models.mjs — never edit the list by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OPENCODE_FREE_MODELS as MODELS } from "../board/src/lib/models.generated.mjs";
import { aliasOf, describeModel } from "../board/src/lib/models.mjs";

/** Origins this project does not ship. opencode re-hosts models under its own
 *  prefix, so a vendor-prefix check alone waves `opencode/ling-3.0-flash-fin-free`
 *  straight through — these are matched against the whole id.
 *
 *  ⚠️ At a BOUNDARY, never as a bare substring. "ling" occurs inside
 *  "inkling-small", and a plain includes() rejected Thinking Machines' model as
 *  an InclusionAI one. A denial that fires on a legitimate model is the same
 *  class of bug as one that misses a denied model: both mean the list nobody
 *  reads is not what it claims. */
const DENIED_ORIGINS = [
  "qwen", "alibaba", "z-ai", "zhipu", "glm", "deepseek", "moonshot", "kimi",
  "minimax", "inclusionai", "ling", "mimo", "xiaomi", "bytedance", "baidu",
  "ernie", "01-ai", "tencent", "hunyuan", "stepfun", "skywork", "iflytek",
  "sensetime", "dots-studio", "rednote", "internlm", "baichuan",
];

/** True when `token` names a path segment of the id, or starts one of that
 *  segment's dash-separated words. Deliberately not a substring test — see
 *  above. Written as a scan rather than a built RegExp so there is no escaping
 *  to get wrong: these tokens contain `.` and `-`. */
const AT_EDGE = (c) => c === undefined || c === "-" || c === "_" || c === "." || c === ":";
const wordMatch = (seg, token) => {
  for (let i = seg.indexOf(token); i !== -1; i = seg.indexOf(token, i + 1)) {
    const before = i === 0 ? undefined : seg[i - 1];
    const after = seg[i + token.length];
    if (AT_EDGE(before) && (AT_EDGE(after) || /\d/.test(after ?? ""))) return true;
  }
  return false;
};
const originMatches = (id, token) =>
  id.toLowerCase().split("/").some((seg) => seg === token || wordMatch(seg, token));

test("the launcher has something to offer", () => {
  assert.ok(MODELS.length > 0,
    "an empty list means the opencode model picker silently shows nothing");
});

test("every id is one `opencode run -m` can resolve", () => {
  for (const id of MODELS) {
    assert.match(id, /^(opencode|openrouter)\//,
      `${id} carries no provider prefix, so opencode cannot resolve it at spawn`);
  }
});

test("every id is free", () => {
  for (const id of MODELS) {
    assert.ok(id.endsWith(":free") || id.endsWith("-free"),
      `${id} is not marked free — launching it could bill the user`);
  }
});

test("no model from an origin this project does not ship", () => {
  for (const id of MODELS) {
    for (const denied of DENIED_ORIGINS) {
      assert.ok(!originMatches(id, denied),
        `${id} matches the denied origin '${denied}'`);
    }
  }
});

test("no model below the 6B active-parameter floor", () => {
  for (const id of MODELS) {
    const low = id.toLowerCase();
    // Sparse models state both counts as <total>b-a<active>b; the active count
    // is the one that predicts quality. A dense model states one number.
    const sparse = low.match(/[-_](\d+(?:\.\d+)?)b[-_]a(\d+(?:\.\d+)?)b/);
    const dense = low.match(/[-_](\d+(?:\.\d+)?)b(?![a-z0-9])/);
    const active = sparse ? Number(sparse[2]) : dense ? Number(dense[1]) : null;
    if (active !== null) {
      assert.ok(active >= 6, `${id} is ${active}B active, below the 6B floor`);
    }
    // Lightning states no size in its id and is 3B active. The floor cannot
    // catch it by parsing, so it is named.
    assert.ok(!low.includes("lightning"),
      `${id} is Lightning: 3B active behind a name that does not say so`);
  }
});

test("no meta-router or cloaked model", () => {
  for (const id of MODELS) {
    assert.ok(!/^openrouter\/(free|auto)\b/.test(id),
      `${id} picks its backing model at call time, so its origin is unknowable`);
  }
});

test("no duplicate ids", () => {
  assert.equal(new Set(MODELS).size, MODELS.length,
    "a duplicate id would render as two identical rows in the picker");
});

// ── how a model id is shown ──────────────────────────────────────────────────

test("aliasOf splits on the first colon, not the last", () => {
  // OpenRouter ids carry a colon of their own; splitting on the last one would
  // hand opencode the string "free".
  assert.equal(aliasOf("opencode:openrouter/thinkingmachines/inkling:free"),
    "openrouter/thinkingmachines/inkling:free");
  assert.equal(aliasOf("claude:opus"), "opus");
  assert.equal(aliasOf("opencode:"), "");
  assert.equal(aliasOf("nocolon"), "");
});

test("every generated id survives the id round trip", () => {
  // The picker builds `<family>:<alias>` and reads the alias back out. If that
  // is lossy for any id, the launcher spawns a model other than the one shown.
  for (const id of MODELS) {
    assert.equal(aliasOf(`opencode:${id}`), id, `${id} does not round trip`);
  }
});

test("describeModel names the model, not the path to it", () => {
  assert.deepEqual(describeModel("openrouter/thinkingmachines/inkling:free"),
    { label: "inkling", from: "openrouter/thinkingmachines", trains: false });
  assert.deepEqual(describeModel("openrouter/thinkingmachines/inkling-small:free"),
    { label: "inkling-small", from: "openrouter/thinkingmachines", trains: false });
  assert.deepEqual(describeModel("opencode/muse-spark-1.3-contributor-free"),
    { label: "muse-spark-1.3", from: "opencode", trains: true });
  assert.deepEqual(describeModel("opus"), { label: "opus", from: "", trains: false });
  assert.deepEqual(describeModel(""), { label: "default", from: "", trains: false });
});

test("no two generated models render the same label", () => {
  // This is the bug the labels exist to fix: inkling and inkling-small both
  // truncated to "openrouter/thinkingmachines/in…" in the picker.
  const labels = MODELS.map((id) => {
    const { label, from } = describeModel(id);
    return `${from}/${label}`;
  });
  assert.equal(new Set(labels).size, labels.length,
    `two models render alike: ${labels.join(", ")}`);
});

test("the contributor builds are flagged as training on prompts", () => {
  const contributor = MODELS.filter((id) => id.includes("-contributor"));
  assert.ok(contributor.length > 0, "expected at least one contributor build");
  for (const id of contributor) {
    assert.equal(describeModel(id).trains, true, `${id} is not flagged`);
  }
});
