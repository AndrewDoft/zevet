/** Who pays for a turn (D-073): the words the board puts around a payer label.
 *  Plain JavaScript like roster.mjs so the gate tests run the shipped copy.
 *  The label itself ("Claude · andrew@x.com (Max)") is made by the desktop from
 *  the engine's own login; unknown is "" and every function here then says
 *  nothing. */

const ENGINE_OF = { claude: "Claude", "claude-code": "Claude", codex: "Codex", opencode: "OpenCode", zevet: "Zevet model" };

/** The payer sealed for one teammate session, or "". */
export function payerOfSession(payers, actor, session) {
  const want = String(actor || "").toLowerCase();
  const p = (payers || []).find((x) => x && x.session === session && String(x.actor || "").toLowerCase() === want);
  return p ? p.label : "";
}

/** The newest payer a teammate has shown for an engine (a spawn has no session
 *  yet; their machine's login for that engine is what will pay), or "". */
export function payerOfActor(payers, actor, agent) {
  const want = String(actor || "").toLowerCase();
  const engine = ENGINE_OF[String(agent || "").toLowerCase()];
  if (!engine) return "";
  const mine = (payers || []).filter((x) => x && String(x.actor || "").toLowerCase() === want && String(x.label || "").startsWith(engine));
  return mine.length ? mine[mine.length - 1].label : "";
}

/** "Bills kai: Claude · k@x.com (Max)". `who` "" means the reader. Unknown: "". */
export function billsLine(who, label) {
  if (!label) return "";
  return `Bills ${who || "you"}: ${label}`;
}
