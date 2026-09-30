// The loopback agent API asking the board to do what a person's Send does
// (desktop/board-ask.js). Plain JS so the round trip is testable without React.

/** The picker spells claude's models "claude-sonnet-5", not "sonnet": an alias
 *  resolves to the first (newest) picker id containing it; anything else stands. */
export function pickerModel(agent, model, agents) {
  const ids = ((agents || []).find((a) => a.name === agent) || {}).models || [];
  if (!model || ids.some((m) => m.id === model)) return model;
  const hit = ids.find((m) => m.id.includes(model));
  return hit ? hit.id : model;
}

/** `deps`: startAgent(name, launch) -> Promise<{ok,id,engine,error}>, sendPrompt(key, text),
 *  findConsole(id), agents(). Answers with the result main relays to the caller. */
export async function answerBoardRequest(req, deps) {
  if (req.kind === "start") {
    const r = await deps.startAgent(req.agent, {
      background: true,
      root: req.cwd,
      prompt: req.prompt || "",
      model: pickerModel(req.agent, req.model, deps.agents()),
      mode: req.mode,
      engine: req.engine,
      label: req.label,
    });
    return r && r.ok ? { ok: true, id: r.id, engine: r.engine } : { ok: false, error: (r && r.error) || "could not start" };
  }
  if (req.kind === "send") {
    const c = deps.findConsole(req.id);
    if (!c) return { ok: false, notFound: true };
    if (!c.id && c.running) return { ok: false, error: "still starting" };
    deps.sendPrompt(c.key, req.prompt);
    return { ok: true };
  }
  return { ok: false, error: `unknown request ${req.kind}` };
}
