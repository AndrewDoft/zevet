"use strict";

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function first(...values) {
  for (const value of values) {
    const v = text(value);
    if (v) return v;
  }
  return "";
}

function codexFromRollout(rollout) {
  const p = rollout?.payload || rollout?.provenance || {};
  const provenance = p.provenance || p;
  const model = first(provenance.model, provenance.model_name, p.model);
  const effort = first(provenance.reasoning_effort, provenance.model_reasoning_effort, p.reasoning_effort);
  const account = first(provenance.account, provenance.plan, provenance.account_plan, p.account);
  return { model, effort, account };
}

function opencodeFromEvents(events) {
  for (const event of Array.isArray(events) ? events : []) {
    const model = first(event.model, event.modelID, event.part?.modelID);
    const provider = first(event.provider, event.providerID, event.part?.providerID);
    if (model) return { model: provider && !model.startsWith(`${provider}/`) ? `${provider}/${model}` : model };
  }
  return {};
}

/** Resolve only values an agent actually reported, in the documented priority order. */
function resolveSessionMeta(agent, source = {}) {
  const live = agent === "opencode" ? opencodeFromEvents(source.events) : codexFromRollout(source.rollout);
  const model = first(live.model, source.launch?.model, source.config?.model);
  const effort = first(live.effort, source.launch?.effort, source.config?.model_reasoning_effort);
  const account = first(live.account, source.launch?.account, source.config?.account, source.config?.plan);
  return Object.fromEntries(Object.entries({ model, effort, account }).filter(([, value]) => value));
}

module.exports = { resolveSessionMeta };
