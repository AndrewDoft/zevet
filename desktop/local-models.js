// Local model servers on THIS machine, probed from the desktop only: Ollama (127.0.0.1:11434) and
// LM Studio (127.0.0.1:1234). Two fixed loopback URLs, a 2 s timeout, no subnet scan, no other host.
"use strict";

const TARGETS = [
  { provider: "ollama", url: "http://127.0.0.1:11434/api/tags", names: (j) => ((j && j.models) || []).map((m) => m && m.name) },
  { provider: "lmstudio", url: "http://127.0.0.1:1234/v1/models", names: (j) => ((j && j.data) || []).map((m) => m && m.id) },
];

/** [{provider, state: "connected"|"not_setup", models: string[]}] (names capped at 50). */
async function detectLocalModels({ fetch: http = globalThis.fetch, timeoutMs = 2000 } = {}) {
  return Promise.all(
    TARGETS.map(async (t) => {
      try {
        const res = await http(t.url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return { provider: t.provider, state: "not_setup", models: [] };
        const body = await res.json();
        if (!body || typeof body !== "object") return { provider: t.provider, state: "not_setup", models: [] };
        const models = t.names(body).filter((n) => typeof n === "string" && n && n.length <= 200).slice(0, 50);
        return { provider: t.provider, state: "connected", models };
      } catch {
        return { provider: t.provider, state: "not_setup", models: [] };
      }
    }),
  );
}

module.exports = { detectLocalModels, TARGETS };
