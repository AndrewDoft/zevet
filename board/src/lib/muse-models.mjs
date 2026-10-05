/** Meta Model API's own ids: dev.meta.ai/docs/models, fetched 2026-09-27 (see
 *  docs/contracts/meta-model-api.md). No cache on disk to generate this from
 *  (unlike claude and codex), so it is copied from the doc and dated — same
 *  arrangement as gemini-models.mjs. Chat lists it only when a Meta key is
 *  detected (composercontrols.tsx); no adapter runs it yet.
 *
 *  Only the two ids the quickstart itself points a plain OpenAI-compatible
 *  client at. `-contributor` builds are the ones opencode's free zen tier
 *  already exposes for no key (models.generated.mjs), a separate, already
 *  working path this list does not duplicate.
 *
 *  Shaped like agent-models.generated.mjs's rows (`{id, name, note}`), not a
 *  bare string array like GEMINI_MODELS — models.mjs's CATALOGUE reads that
 *  shape to give the picker a real name instead of falling back to the raw id
 *  (the fallback every OTHER unrecognised alias already gets; see its own
 *  "NOT INVENTED HERE" warning). */
export const MUSE_MODELS = [
  { id: "muse-spark-1.3", name: "Muse Spark 1.3", note: "" },
  { id: "muse-spark-1.1", name: "Muse Spark 1.1", note: "" },
];
