# Amoeba site read vs Zevet: digest, matrix, build order (2026-10-07)

## 0. Method and caveats (read first)

- WebFetch returns a small model's rendering of each page, not raw HTML. Quotes below marked "verbatim" are what the fetcher returned inside quotation marks; long pages (blog posts, live-sessions, git, troubleshooting) were re-fetched for fuller transcription, but treat blog posts as summaries.
- Not verified: Discord contents, the "interactive demo" on the homepage (JS app), /signup, /account behind login, any in-app behaviour (everything below is what Amoeba says, not what it does), HN/Reddit/GitHub-org presence (searches found none for useamoeba; the only org hits were unrelated "amoeba" repos), funding/press (none found).
- Amoeba's own pages disagree in places (flagged inline). Zevet side was checked against README.md, DECISIONS.md D-001..D-059, the gap plan, and a file listing of `board/src/components` and `desktop/`; I did not run Zevet.

### URLs fetched OK (all https://useamoeba.com)
`/`, `/sitemap.xml`, `/robots.txt`, `/about` (2nd try), `/pricing` (2nd try), `/models` (x2), `/faq`, `/changelog`, `/download`, `/blog`, `/docs`, `/docs/getting-started`, `/docs/concepts/workspaces`, `/docs/agents/providers`, `/docs/collaboration/live-sessions` (x2), `/docs/git/repositories` (x2), `/docs/admin/members` (x2), `/docs/help/troubleshooting` (x2), all 10 `/blog/*` posts in the sitemap (stop-ai-agents-editing-same-file, multiplayer-coding-with-ai-agents, any-agent-harness-one-ide, local-first-agent-sessions-websocket, approval-gates-for-ai-agents, shared-project-memory-for-agents, parallel-subagents-one-result, amoeba-cli-quick-start, sandboxed-agents-zero-data-retention, agent-usage-limits-handoff), `/privacy`, `/terms`, `/contact`, `/login`. Plus 4 web searches.
### Failed / not reached
`/about` and `/pricing` first attempts (ECONNRESET, retried OK); `/security` (404; security lives at `/about#security`); `/account`, `/signup`, `/download/*` redirects, `discord.gg/4UWRhsqBfh`, homepage interactive demo, customer-logo external links (not fetched; logos are decoration, no case studies exist). Sitemap lists 29 URLs; every one was fetched. No docs subdomain exists (robots.txt blocks `/m`, `/tracker`, `/api/`, `/design/`).

---

## 1. Per-page digest

**Company**: Amoeba, Inc., Delaware. Founders named John, Kenneth, Keyu (emails ken@, kenneth@, keyu@useamoeba.com). Early access, "free while we work with pilot teams". Support = Discord, "the founders are there every day". Releases 0.1.5 (Aug 9 2026) to 0.1.43 (Oct 1 2026): about 4 releases/week.

**`/` homepage.** "Code and Develop as a Team." "A multiplayer IDE for your team and the coding agents it runs." Pillars: one shared session; overlap warnings "before agents run"; lanes in Mission Control; shared Brain (context + encrypted transcripts); Git worktrees. "Visible / Coordinated / Collaborative (team chat and task handoff)". Agents: Claude Code and Codex only, local CLIs under each person's own login. CTA: "Free in early access. Install, open a session, invite the team." Logo wall (Replit, Philips, Perplexity, opencode, Cline, Wix, ByteDance, MIT, Harvard, GovTech SG, Railway, Warp, Google, Samsung, L'Oreal): unverified decoration, no quotes or case studies. Footer: Interactive demo, How it works, Models, Pricing, Blog, Changelog, docs, About/Contact/Discord/Privacy/Terms/Security/FAQ.

**`/pricing`.** Free in early access: desktop app (macOS Apple silicon, Windows x64), shared sessions, BYO agents ("Claude Code, Codex, others"), founder support. Optional "Amoeba-managed model usage": provider token cost plus 5% ($1.00 becomes $1.05 before tax); no subscription, no seat fee, no prepaid bundles; billed daily via Stripe after payment authorization; the person who starts a run pays; allowance can be capped per account or uncapped; usage by run/model/workspace; failed payment pauses managed requests.

**`/models`.** "Native Harness" catalogue: 187 models, 24 providers, 23 at 20% off (frontier models), prices USD per 1M tokens, dated Oct 4 2026. Rows seen: Claude Opus 5.5 $3.20/$16 (1M ctx), Claude Fable 5.1 $8/$40, GPT-6 Sol $1.60/$8, GPT-6 Astra $8/$40, GPT 5.6 Luna $0.16/$0.96, GLM-5.3-Flash $0.06/$0.20, Sonnet 5 $1.60/$8, Haiku 4.5 $0.80/$4, Grok 4.6 $1.60/$4.80, GPT 5.5 $4/$24, etc. Tagline "Bring your models. Build together."  Note the discount is applied on top of the +5%/list story; whether managed usage is a resale below list is unclear. Changelog 0.1.34 says "Retired pricing, quota, billing controls" while /pricing and /terms still describe managed billing: inconsistent, treat billing as in flux.

**`/faq`** (verbatim answers, abridged): works with Claude Code and Codex; "No [agent needed]. Without an agent you can still watch every session live, comment, and hold work from the board"; code stays in local checkouts, moves via plain Git "through shadow refs on your configured remote"; Brain = "short, structured notes pinned to specific files and commits: decisions, gotchas and conventions"; four roles (Viewer, Commenter, Editor, Owner); platforms "macOS Apple silicon and Windows x64" (FAQ and /pricing omit Linux; /download and changelog ship Linux AppImage and Windows ARM64: stale FAQ); sign in with email, Google or GitHub; on usage limit "the session switches to awaiting takeover and a teammate can pick it up with full context".

**`/docs` index.** Seven sections: Getting started, Core concepts, Working with agents, Team collaboration, Code and Git, Admin and security, Help and reference. Quick start: Continue with GitHub, pick Claude Code or Codex, choose workspace, "Set it up for me", invite by GitHub username, start in Mission Control.

**`/docs/getting-started`.** Signed installers (Mac notarized, Windows timestamped), in-place self-update (builds <=0.1.17 manual once). Sign in email/Google/GitHub; GitHub tokens stored encrypted; local git creds/SSH keys not stored. Teammates get "dedicated columns with their own agents".

**`/docs/concepts/workspaces`.** Five ideas. (1) Workspace = one repo + people; org contains workspaces; roles per workspace; private by default, "Nothing in Amoeba is ever public". (2) Session = one task, one branch, one plan; each participant has a lane (own conversation with own agent) side by side; watching is read-only with visible presence, "no invisible lurking". (3) Mission Control: "GitHub shows the past. Mission Control shows the present." Card per live session (task, status, who, whose account the turn uses, plan progress, files touched); alerts strip shows only actionable items (approval waiting, takeover offer, collision); History keeps transcript chunks within retention plus final diff and plan. (4) Ownership: "Work belongs to people. Agents just execute it." A person without an agent can hold, hand back and finish work. Every turn has exactly one visible sponsor; the composer states whose account it uses. (5) Brain: notes pinned to files/commits; flagged when a merge moves the code; the next nearby agent rewrites; humans can edit/retire.

**`/docs/agents/providers`.** BYO CLI per member; "Amoeba does not resell those tokens". Brain also processes prompt-derived coordination context, "including overlap and task-summary processing by Anthropic". Onboarding detects CLIs and wires hooks and coordination tools in one click; unsupported provider shown dimmed with reason. Composer states consequence and payer before dispatch ("Prompt your agent. Uses your Claude account."); intent chosen explicitly, never inferred. Steer: add guidance mid-turn to YOUR OWN agent only (spends your account); if the turn ends first, the text returns to the composer, never dropped or billed. Take over: ends a teammate's turn at a safe checkpoint, starts a new turn on your account, agent announces "Resuming at step 8 of 11"; simultaneous takeovers resolve to one winner, loser offered to join. Parallel subagents: spawn from composer or comment into a worktree from a session snapshot; parent never pauses; child streams to a rail; only a clean candidate passing required checks integrates, exactly once. Recovery: usage limit flips session to awaiting takeover and shows age of last synced snapshot; coordination server down means agent works solo and reconnects ("fails open"); an interrupted push/deploy is never auto-retried, a person records the outcome.

**`/docs/collaboration/live-sessions`.** Join (own lane) or watch (read-only); join checks role, free seat, push access, available agent in the background. Overlap: compares branch, open file paths, planned file paths, task descriptions vs active sessions; "overlapping" (same file) vs "adjacent" (related plan/task); warning carries teammate and session context; exact-path locks are advisory, session-scoped, "not a filesystem write barrier"; if hook or Brain is down the prompt continues on cached context. Plans: one per session, owners and statuses per step; progress on cards comes from the plan; select a teammate's steps and offer to take them (unstarted/unowned transfer instantly, started asks owner). Comments: anchor to session, transcript moment, file range or diff hunk; can become a plan step, suggestion, or a prompt to your own agent; a comment alone costs no provider usage; resolving never deletes; moved code gets the comment labelled. Handoffs: deliberate, or involuntary (usage limit, closed laptop, vacation); taker gets branch as of last sync, plan, fresh memories; works for non-engineers.

**`/docs/git/repositories`.** "Git stays the source of truth." Code moves on plain git under your credentials; server holds metadata only (sessions, plans, presence, memory). Worktrees per joined session/subagent; honest line: "A worktree is not a container or security boundary." Manual branch switch inside a worktree pauses the session with a banner. Full desktop editor with agent in a bottom panel, native conversation or the CLI's own terminal ("passes every byte through"). Live review: watch diffs land, comment on a range or hunk; gated actions (push, network call, external command) produce an approval card naming action, files, requester; any editor can answer, first valid response wins. Sync: session branch syncs between machines as snapshots "checked three ways before they apply"; conflict keeps both versions with a "2 versions" chip; no silent overwrite; finishing is ordinary commits and a PR.

**`/docs/admin/members`.** Roles: Viewer (read only); Commenter (+comments, suggestions, hold work: claim, accept assignment, hand back, mark done; no agent needed); Editor (+start/join sessions, prompt, steer own turn, take over, spawn subagents, answer approvals, manage plans, assign work, invite); Owner (+membership, roles, settings, deletion). Role changes enforced on the server immediately. Agents start in request-permission mode; approval authorizes that exact action once, enforced on the machine that runs it. Storage: Brain holds workspace/session records, plans, locks, memories, comments, activity and encrypted transcript chunks "after built-in pattern-based secret redaction". Verbatim: "Amoeba holds the encryption keys, so this is not end-to-end encryption." Transcript retention default 90 days, configurable per org; other coordination records do not expire. Pilots: "contact us and tell us your team size and stack."

**`/docs/help/troubleshooting`.** Window title always shows connection state. Named failure states: "Sync paused", "2 versions", "Outcome unknown", "Workspace not set up on this machine". Shortcuts: Cmd/Ctrl-K palette, Esc, Enter dispatch, Shift+Enter newline, Shift+Tab cycles permission mode (passes through in terminal mode). MCP tools installed into the CLIs: fetch team live context, propose a work split, claim plan steps, assign board work, send a message to another agent, record a memory (each self-documents "including when not to use it").

**`/about`, `/privacy`, `/terms`.** Security (about#security): installers signed; transit encryption; transcript chunks and GitHub tokens app-encrypted before DB write; other records provider-storage-encrypted; "Gated actions require editor-role approval"; security@useamoeba.com. Privacy (eff. Oct 6 2026): "does not train or fine-tune models on your prompts, code or transcripts"; subprocessors Railway, Stripe, Anthropic, OpenAI; US hosting, SCCs for EU/UK; 30-day access/deletion response; account deletion anonymises identity and redacts transcripts; cookieless first-party analytics with daily-rotating IP hash. Terms: user owns code, prompts, outputs; age 16+; as-is; liability capped at 12 months' payments; managed usage non-refundable except billing errors; Delaware law. No SOC2/ISO claims anywhere.

**`/contact`.** Discord only ("Message the founders"). **`/login`**: Google, GitHub, email+password, forgot password.

**`/download`.** v0.1.43, Oct 1 2026. Mac (arm64), Windows x64 and ARM64, Linux x64 AppImage with auto-update.

**`/blog`** (10 posts, 1-3 min reads, Apr 17 to Aug 14 2026; all are thin marketing/limits explainers, candid about limits): overlap warnings (limits: "cannot guarantee zero duplicated work"); shared session; any-harness; local-first + shadow refs; approval gates ("owner, admin and member roles, permissions per repository"; nothing reaches a shared branch without approval; note the blog's 3 roles disagree with the docs' 4 roles); shared project memory; parallel subagents; quick start; worktrees (safety caveats); usage-limit handoff (passes prompts, diff and plan, logged in Brain).

**`/changelog`** (strongest signal of what is actually built, v0.1.5 to v0.1.43). Notable: 0.1.6 Claude+Codex configured for shared-Brain coordination; 0.1.7 comment on a line launches an agent that knows repo/file/lines/context; 0.1.9 native notifications when agent finishes or needs attention; 0.1.16 agent from comment runs inline in session; 0.1.20 thinking/tool calls/replies stream into room live, composer names exact model; 0.1.33-0.1.34 custom OpenAI-compatible providers (list dir, regex search, edit, shell; Request mode asks before edits and commands), model pill with searchable picker and effort slider; 0.1.37 teammates see unfinished output live, up to 20 workspace agents, shows each teammate's provider and model, ACP/Hermes catalog discovery, OpenCode launch; 0.1.38 voice dictation, manual file editing; 0.1.40 reasoning effort for custom models, editable keybindings, selected-code comments; 0.1.41 Windows ARM64; 0.1.42 (Sep 30) "Live working-file sync with editing avatars and conflict recovery", per-workspace Git auto-sync batched every 5 s, AMOEBA.md workspace settings and prep commands before Build; 0.1.43 Escape interrupts, invite into a selected session, `/session` and `/resume`, shared-file conflicts in sidebar tab. Observation: live shared-file editing shipped only on Sep 30, so Amoeba's "multiplayer editor" is days old and is file sync (snapshots), not a CRDT.

---

## 2. Feature matrix (Amoeba vs Zevet)

Legend: HAVE = Zevet has it; PART = partial; MISS = missing; BETTER = Zevet ahead. "Amoeba claims" = from their docs; not verified in product.

| Capability | Amoeba (claimed) | Zevet | Verdict |
|---|---|---|---|
| Shared live editor | file snapshot sync, avatars (0.1.42, 2 weeks old) | CodeMirror + Yjs CRDT, AES-256-GCM, hub blind | BETTER (but two-machine edit unproven, README) |
| Agent cursors / line presence | not claimed beyond "editing avatars" | planned/built (gap plan A) | HAVE |
| Steer teammate's agent | NO: steer is own-turn only; "take over" instead | on/ask/off policy, sealed, outcome shown (D-058) | BETTER |
| Take over a running turn | yes, safe checkpoint, one winner, "Resuming at step 8" | not present as a feature | MISS |
| Handoff on usage limit | yes (awaiting takeover, snapshot age) | quota strip D-034, Auto ladder D-018 (fails over credentials, not people) | PART |
| Anchored comments | session/transcript/range/hunk; comment becomes plan step or agent prompt | comments.tsx; code anchors done (gap C); transcript/diff-hunk anchors and comment-to-agent unverified | PART |
| Comment launches an agent with exact context | yes (0.1.7, 0.1.16) | unverified | MISS (verify) |
| Shared context into agents | MCP tools + Brain | activity block via system prompt, activity.md (D-058) | HAVE (no agent-callable tools) |
| Agent-callable coordination MCP (get team context, propose split, claim step, message another agent, record memory) | yes | D-009 MCP server exposes the screen to an agent, gated by a person; no peer-to-peer agent messaging | PART |
| Overlap warning BEFORE a prompt runs (branch, planned paths, task text) | yes, "overlapping/adjacent" | collision lanes + desktop notifications on actual file touch; no pre-prompt or plan-based check | PART |
| Advisory file locks | yes, session-scoped | none | MISS |
| Plans with step owners and statuses | yes, one per session; progress on cards | none seen | MISS |
| Mission Control board of sessions | cards: task, status, whose account, plan progress, files; actionable-only alerts strip | board with lanes, agents, files, sessions.tsx, strip.tsx | HAVE (no plan progress, no sponsor display, no alerts-only strip) |
| Visible payer per turn ("uses your Claude account") | yes | credentials by (provider, kind), personal vs team (D-018); per-turn payer label unverified | PART |
| Shared Brain / pinned memory with staleness flags | yes, files+commits, flagged when code moves | knowledge.tsx, vault concept; per-file pinned notes with staleness unverified | PART |
| Roles (Viewer, Commenter, Editor, Owner) | 4 roles, server-enforced, per workspace | owner + members (D-014/D-020), team policy owner-only; no viewer/commenter tiers | MISS |
| Hold work without an agent (non-engineers) | yes | no work-assignment object | MISS |
| Approval cards for gated actions, first valid answer wins | yes, enforced on running machine | permits.tsx + permit-grants (local); teammates answering each other's approvals: unverified | PART |
| Worktrees per session / subagent | yes | agent-worktree.js, D-042 | HAVE |
| Subagent integrates only if checks pass, exactly once | yes | subagents-panel exists; integrate-on-green gate unverified | PART |
| Parallel agent graph | no | graphviews.tsx / mapviews.tsx (gap E) | HAVE |
| Live prompt boxes of teammates | not claimed | promptboxes.tsx | HAVE |
| Spawn on teammate's machine | no | built | BETTER |
| Mixed providers in one session | Claude Code, Codex (OpenCode, Cursor, Hermes/ACP, custom OpenAI-compatible per changelog) | Claude Code, Codex, OpenCode, Zevet model, Gemini/Muse adapters, router (D-048) | HAVE/BETTER |
| Model catalogue + price list, managed usage at cost+5% | 187 models, 20% frontier discount, Stripe | credential ladder, free-only router; no resale | MISS (deliberate? see section 4) |
| Reasoning-effort slider / model picker | yes | model-choice.tsx, composercontrols | HAVE |
| E2E encryption | NO, and says so | document, steer encrypted with key hub cannot derive; hub still holds team secret on disk (README honest) | BETTER |
| Retention controls | transcript default 90 days, org-configurable | hub has retention compaction (server.mjs ~376); no admin UI | PART |
| Secret redaction on transcripts | pattern-based, before storage | unverified | MISS (verify) |
| Fail-open when server down | explicit | hook exits 0, never stdout (README) | HAVE |
| Signed installers + signed updates | Apple notarized, Azure Trusted Signing | Ed25519 signed channels D-026, sign/notarize scripts | HAVE |
| Platforms | mac arm64, Win x64 + ARM64, Linux AppImage | mac, Windows; Linux builder target exists, unshipped (app-update.js comment) | PART |
| Native notifications on finish/needs-attention | yes | collision notifications; finish/needs-attention unverified | PART |
| Command palette, keybindings | Cmd-K, editable bindings | palette.tsx; editable bindings unverified | HAVE/PART |
| Voice dictation | 0.1.38 | voicedialog.tsx, zevet-voice | HAVE |
| In-app terminal, editor, git source control | full editor (VS Code fork lineage: changelog mentions "stock VS Code window") | editor + console; full git UI not a goal | PART |
| Team chat | claimed on homepage | none seen; steer + agent mentions | MISS |
| Resume provider sessions (/resume) | yes | per-console session id (D-040) | HAVE |
| Sign-in | email, Google, GitHub | Google, GitHub, Microsoft, invite keys | HAVE |
| Free tier / pricing | free early access; cost+5% managed | n/a | n/a |
| Public docs, changelog, blog, FAQ, privacy, terms | full set, polished | README/DECISIONS only; no public marketing/docs site | MISS |
| Interactive web demo | yes (homepage) | none | MISS |

---

## 3. Build order (ranked, not including what Zevet already built)

Zevet's structural edge to protect in every item: encrypted relay the hub cannot read, local-first, many engines (Claude Code, Codex, OpenCode, Zevet model), cross-person steering. Amoeba's own security page says Brain data is not E2E and Anthropic processes prompt-derived content; that is the contrast to lean on.

### Wave 1: close the visible coordination gaps (days to ~2 weeks each)

1. **Pre-prompt overlap check (plan- and branch-aware), plus advisory path locks.** (M)
   Why: Amoeba's headline feature; ours fires only after a file is touched. Compare branch, open paths, planned paths, task text against active agents; label "overlapping" vs "adjacent"; show teammate and session. Locks advisory and surfaced as a board chip, never a write barrier (same honesty as Amoeba's blog). Deps: hub already has all activity; needs a pre-prompt hook in the desktop composer (not the hook, so rule 1 stays intact). Zevet edge: runs on ciphertext-free metadata only (paths, no prompt text sent to a third-party LLM). Do NOT send prompts to Anthropic for "adjacency"; use local embeddings (`desktop/embedder.js` already exists) so it stays local-first.

2. **Take over / handoff of a running turn.** (M)
   Why: Amoeba's best story ("hit limit, teammate continues with full context, announces where it resumes"). We have steering and quota awareness (D-034) but no baton. Deps: agent session id per console (D-040), worktree sync, steer channel (D-058). Build: "Take over" button on teammate agent -> ask/on/off policy reuses steer policy; new turn on taker's account with transcript + diff summary; one winner. Edge: sealed with doc key, policy-gated, works across engines (Amoeba is Claude/Codex only).

3. **Plans with step owners and plan progress on board cards.** (M)
   Why: Amoeba's cards show progress "from the plan, never a guess"; we show activity, not intent. Deps: an agent-readable plan file (reuse TodoWrite/plan events from hooks) before a bespoke plan editor. Start read-only: derive steps from the agent's own todo list; add owner and "offer to take" later. Edge: engine-agnostic derivation.

4. **Comment upgrades: anchor to transcript turns and diff hunks; "comment -> agent with exact lines" and "comment -> plan step".** (S-M)
   Why: changelog shows this loop (0.1.7, 0.1.16, 0.1.40) is a core UX. Code-anchored comments already exist (gap C). Verify what comments.tsx does before scoping. Deps: item 3 for comment-to-step.

5. **Visible sponsor/payer on every dispatch and teammate card.** (S)
   Why: Amoeba's "Prompt your agent. Uses your Claude account." plus "whose account the current turn uses". We have a credential ladder (D-018) but must expose which credential a turn used, especially for steer and take-over. Cheap trust win; fits the ship rule (outcome visible to staff).

6. **Public site: landing, docs, changelog, security page, interactive demo.** (M)
   Why: Amoeba ships a polished set (about, FAQ, privacy, terms, 10 blog posts, changelog every 2-3 days). We have none; D-003 made the repo public but not discoverable. Reuse DECISIONS D-records as the changelog source. Security page is where we win: say exactly what the hub can and cannot read (README already writes this honestly). Zevet edge: encryption and local-first as headline.

### Wave 2: roles, memory, safety (2-6 weeks)

7. **Roles: Viewer / Commenter / Editor / Owner, server-enforced, per team (later per workspace).** (M-L)
   Why: needed for any team larger than founders and for non-engineer participation. Today it is owner + member. Deps: hub accounts (hub/accounts.mjs), audit log exists. Enforce at hub, reject next action immediately (Amoeba claims this). Gate steer policy, spawn-on-teammate-machine, and take-over by role (Editor+).

8. **Cross-machine approval cards: any Editor can answer a teammate agent's permission prompt; first valid answer wins; "Outcome unknown" state for interrupted actions.** (M-L)
   Why: Amoeba's "answer their approval requests" is real team leverage; we have local permits.tsx. Needs the sealed channel from D-058 and a clear rule that approval authorizes that exact action once and is enforced on the executing machine. Security-sensitive: ship default off, per-team policy like steer. Record a D-record.

9. **Agent-callable coordination tools (MCP): get team context, claim step, message another agent, record memory.** (M)
   Why: Amoeba's MCP set is how its agents coordinate without a human; ours are passive (system-prompt snapshot, activity.md refreshed per minute). D-009's MCP server exists; add tools. Deps: items 3 and 10. Risk: prompt injection from teammate-authored content, same class as D-058; keep text framed as data and capped.

10. **Pinned memory with staleness flags (per-file notes tied to commit/hash; flagged when code moves; humans can edit/retire).** (M)
    Why: Amoeba's Brain pitch; knowledge.tsx and the vault already exist, so this may be mostly wiring. Zevet edge: notes encrypted with the doc key (Amoeba's are readable by Amoeba and processed by Anthropic). Verify what knowledge.tsx currently stores before scoping.

11. **Subagent integrate-on-green, exactly once.** (S-M, verify first)
    Why: Amoeba's rule: only a clean candidate that passes required checks integrates, a failed one leaves the parent untouched. Check whether subagents-panel/agent-worktree already do this.

### Wave 3: reach and polish (opportunistic)

12. **Linux AppImage + Windows ARM64.** (S-M) Builder target already exists (app-update.js notes it); mostly CI and an update path. Amoeba ships both; matters for dev teams on Linux.
13. **Retention admin UI + secret redaction on stored transcripts/activity.** (M) Hub has TTL compaction; add per-team setting and pattern redaction before relay/storage (redaction cannot run on ciphertext hub-side, so do it client-side before sealing: an edge over Amoeba's server-side redaction).
14. **Native notifications for "agent finished / needs attention" (not just collisions), editable keybindings.** (S)
15. **Team chat / task board for non-agent work ("hold work without an agent").** (L) Only after roles; low priority.
16. **Model catalogue page with cost per task.** (S-M) A read-only list of what the router/ladder can use, with costs; no resale.
17. **Session sharing flow: "invite into a selected session", join-with-checks (role, seat, push access, agent available) with a single actionable error.** (S-M) Cheap UX parity (0.1.43, live-sessions doc).

Before any of waves 1-3: prove two-machine shared editing (README admits never run on two computers). Amoeba shipped file sync 2 weeks ago; a live demo on two real machines is worth more than any item above.

---

## 4. Deliberately do NOT copy

- **Server-readable transcripts "encrypted at rest with keys we hold".** Amoeba is explicit it is not E2E and routes prompt-derived content through Anthropic for overlap and summaries. Keep the hub blind; do overlap/summaries locally.
- **Managed model resale at cost+5% and Stripe metering.** Amoeba's own changelog "retired pricing, quota, billing controls" on Sep 17 yet pricing pages still sell it: churn and liability. Our BYO credential ladder is enough; revisit only with demand.
- **Shadow refs pushed to the user's remote** as the sync channel: pollutes the customer's repo and needs push access; also their sync was "continuous snapshots" that took until Sep 30 to ship. Our open-files-only sync is narrower and safer; keep it.
- **LLM-judged "adjacent" overlap via a third-party model.** Use local embeddings.
- **Customer logo wall with no evidence.** Unverified claim; do not make one.
- **Intent inferred or auto-dispatched actions.** Amoeba itself says intent is never inferred; keep steer/take-over explicit and policy-gated, default `ask`.
- **Auto-accept for any remote-prompt feature first.** Same lesson as D-058 and the update channel.
- **A custom full IDE/git client.** Amoeba is a VS Code-lineage app; chasing source control, terminal and editor parity is a treadmill. Zevet's wedge is the board, agents and the encrypted shared buffer.
- **Advisory locks sold as protection.** Copy the honesty (their blog says locks are advisory, "cannot guarantee zero duplicated work"), not an overclaim.
