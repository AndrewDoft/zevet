# Amoeba vs zevet — gap and build plan (2026-10-06)

Source: a 21 s Instagram reel by bendoescareer (the video's caption is "Cursor is dead… Google Docs for
people's AI agents"; product: **Amoeba, "Code and Develop as a Team"**). It's a marketing clip, not a demo:
everything below is read from on-screen frames and captions (audio was not transcribed). Anything Amoeba
does that the clip doesn't show is unknown. zevet side checked against `main` @ 0.2.120.

## What the clip shows

1. One shared file open for several people, each with a **named, colored cursor labelled with the human or agent**
   (`Chen · Codex`, `Mina · Claude Code`, `Alice · Claude Code`, `Bob · Codex`, plain `Devon`), sitting at the
   line that agent is editing, with a highlighted pill over the region being changed.
2. Composer that targets someone else's agent: *"Bob is using Codex gpt-5.4. Steer their agent…"*
3. Side panel: Session / Environment, a people list (`Bob · editing L28`) and **comment threads** anchored to code
   ("retryOnce can recurse under contention…").
4. A canvas of parallel agent cards ("Claude: writing design tests…", "Codex: handling pair at least…") — "build in parallel".
5. "Shared context": every agent knows what the others are doing; people can see each other's prompt boxes.
6. Mixed agents (Claude Code + Codex) in one session; a Share button; a landing page.

## Where zevet stands

| Amoeba feature | zevet today | Gap |
|---|---|---|
| Shared live editor, human cursors | **Have.** CodeMirror + Yjs, E2E-encrypted via hub (README "Shared editing") | none (never tested on two machines — INSUF) |
| Mixed Claude Code / Codex / opencode | **Have.** hooks for all three | none |
| Who-edits-what, collision warning | **Have** (board lanes + desktop notifications) — arguably ahead of the clip | none |
| Desktop app that runs agents | **Have.** `desktop/agent-*.js`, worktrees, subagent panel, voice | none |
| **Agent cursor at a line in the shared buffer** | **Missing.** README: "no presence for an agent's line" — hook has file, no line | **A** |
| **Steer a teammate's agent from your composer** | **Missing.** README: no cross-machine routing (deliberate). `tools.tsx` "steering" is an agent steering its own subagents | **B** |
| **Anchored code comments / threads** | **Missing.** No comment code in editor or board | **C** |
| **Shared context fed *into* agents** | **Missing, and blocked on purpose** — hook rule #1 is "never write stdout" (the `defer` incident) | **D** |
| Canvas of parallel agents | **Partial.** lanes + `graphviews.tsx`/`subagents-panel.tsx` are per-console, not a cross-person graph | **E** (cosmetic) |
| See teammates' prompt boxes live | **Missing** (drafts are local, `drafts.mjs`) | **F** (small) |

Not gaps: voice (zevet-voice repo + `voicedialog.tsx`), invite/share (`invite.tsx`, setup scripts).

## Build plan, in order of value ÷ cost

### A. Agent cursors in the buffer (small, do first)
- The hook only reports `PreToolUse` (client/hook.mjs:489-492), so it knows the file *before* the edit. Add a line
  lookup in the **desktop/board side**, not the hook: when a file-edit event arrives, find `new_string` (Claude
  `Edit`), `newString` (opencode) or the `@@` hunk header (Codex `apply_patch`) in the file on disk after the event
  lands (file-watch already exists: `desktop/file-watch.js`) and take the line range.
- Publish it as a **synthetic Yjs awareness state** per agent (`clientID` derived from `actor+agent`), with
  `{name:"Mina · Claude Code", color: authorcolor, range:[from,to]}`. yCollab already renders remote selections, so
  this is mostly a label style plus the highlighted pill (selection decoration).
- Honesty rule (README is already strict about this): show a *range* ("editing L17–19"), never a fake caret; if the
  string can't be found, show the agent on the file tab only. Expire the state ~10 s after the last event.
- Test: unit test the locate-line function with Edit/apply_patch/opencode fixtures; browser walk with a simulated agent.

### B. Steer a teammate's agent (medium, security-sensitive)
- Hub already holds a per-person SSE channel. Add a `steer` message: `{to, repo, text, from}`, **encrypted with the
  doc key** (prompts are source-adjacent; the hub must not read them).
- Owner's desktop (`agent-engine.js`) receives it and queues it as a user turn on that agent session, prefixed
  `[from Devon]`. Per-repo setting on the owner: **ask (default) / auto / off**; "ask" shows a card in the board
  (reuse the permits UI in `permits.tsx`).
- Why default-ask: a steer is remote prompt injection into a machine holding credentials. This is the same class
  of risk the README already flags for the update channel; do not ship auto-accept first.
- Visibility (ship rule): the sender sees `queued → delivered → accepted/declined`; the owner's transcript marks the
  turn as from a teammate.
- Reverses the README's "no cross-machine approval routing"; record it as a D-record in `DECISIONS.md`.

### C. Anchored comments (medium)
- One `Y.Array` of comments per room (`<repo>:<path>`) in the same encrypted doc: `{id, author, text, anchor:
  Y.RelativePosition, resolvedAt}`. Relative positions survive concurrent edits and agent writes. Render as gutter
  markers + a thread list in the existing side panel (`people.tsx` area).
- Agents read them through a file the client keeps current (see D), not through the hook.
- Test: two Yjs docs, concurrent edit above the anchor, assert the comment follows the line.

### D. Shared context into agents (the real product difference; design first)
- The hub already knows everyone's current activity. Amoeba's pitch is that each agent *uses* it. zevet can't print
  to the hook's stdout (rule 1), so use two channels that don't touch the hook:
  1. **Desktop-launched agents:** `agent-engine.js` appends a compact "team activity + open comments" block via
     `--append-system-prompt` / the SDK system prompt, refreshed per turn. Zero hook risk.
  2. **Agents started in a plain terminal:** the updater (already detached) rewrites `~/.zevet/activity.md`; the
     setup script adds one `@~/.zevet/activity.md` import line to the repo's `CLAUDE.md`/`AGENTS.md`. Opt-in.
- Keep the block short (who, which file, last 3 prompts' first lines) — a big block taxes every turn.
- Needs a decision from Andrew before building: does shared context include other people's **prompt text**? That is
  the privacy line zevet currently stays behind.

### E. Cross-person agent graph (cosmetic, last)
- A board view: one node per agent (person, agent, file, status), edges where two agents touched the same file.
  Data is already on the hub; this is only a renderer. Skip unless the demo value matters.

### F. Live prompt boxes (small)
- Publish the composer draft (debounced, opt-in per person) over the same awareness channel; render as a ghost
  bubble under the person's name. Lowest value; drafts can be sensitive, so default off.

## Suggested order
A (1–2 days) → C → B (with D-record and the ask-by-default gate) → D (after the privacy decision) → F/E if wanted.
A+C alone close the visible gap in the clip; B+D are what would make zevet *better* rather than equal, but also
the only parts that need a security review.

## Open items
- Two-machine editing is still unproven (README); A, C and B all assume it works — verify first.
- The reel is 21 s; if there is a longer Amoeba demo or docs page, read it before committing to B/D scope.
