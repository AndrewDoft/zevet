# Contract: `browser.task` on the Zevet side (B5 BROWSER track)

Wire shapes (claim, report, closed vocabulary) are Masora's: `masora2` `docs/contracts/browser-task.md`.
This note is the Browser Use half: every call the runner makes, and where it was verified.

Code: `desktop/masora-browser-tasks.js` (poller, ledger, report builder), `desktop/browser-task/runner.py`
(driver), `desktop/browser-task/requirements.txt` (pin), tests `test/masora-browser-tasks.test.mjs`,
`test/browser-task-runner.test.mjs` -> `desktop/browser-task/test_runner.py`.

## Pinned version

**`browser-use==0.13.10`**, released 2026-09-04 (the newest release at least two weeks old on 2026-10-09;
0.13.11 came out 2026-10-07). MIT per the project; PyPI shows no licence field, so the licence file in the repo
is the authority and was not re-read this session. Release page: <https://github.com/browser-use/browser-use/releases>
(v0.13.10: pins every dependency exactly; commit `5c892e0`). PyPI: <https://pypi.org/pypi/browser-use/json>.
Installed into a throwaway venv under `%TEMP%` (outside the repo) with `pip install browser-use==0.13.10`
(pulls `cdp-use 1.4.5`, `pydantic 2.13.5`, `openai 2.26.0`, `anthropic 0.76.0`), imported, and driven end to end
by the tests (headless Chromium 153 from the Playwright cache). Python >= 3.11.

## Docs fetched this session (2026-10-09)

- <https://docs.browser-use.com/customize/browser/all-parameters> -- `headless`, `keep_alive`, `user_data_dir`,
  `allowed_domains` (patterns: `example.com`, `*.example.com`, `http*://example.com`).
- <https://docs.browser-use.com/customize/agent/all-parameters> -- `sensitive_data`, `calculate_cost`, `browser`/`browser_session`.
- <https://docs.browser-use.com/open-source/examples/templates/sensitive-data.md> -- "The LLM only sees placeholders
  (`x_user`, `x_pass`)"; "Real values are injected directly into form fields after the LLM call"; per-domain form
  `{'https://example.com': {...}}`; `use_vision=False` "to prevent screenshot leaks".
- <https://docs.browser-use.com/open-source/development/monitoring/costs.md> -- `calculate_cost=True`, `history.usage`.
- <https://docs.browser-use.com/open-source/supported-models.md> -- `ChatOpenAI(base_url=...)`, `ChatAnthropic`,
  `ChatGoogle`, `ChatOllama`, `ChatOpenRouter`, all importable from `browser_use`.
- <https://docs.browser-use.com/llms.txt> (index).

The docs do not document `Agent.run(max_steps=)`, the LLM protocol or the security watchdog; those come from the
installed source (paths relative to `site-packages/`), read, not assumed:

| Used | Source |
|---|---|
| `Agent(task, llm, browser_session, tools, sensitive_data, use_vision, use_judge, enable_planning, directly_open_url, max_actions_per_step, max_failures, file_system_path, initial_actions, register_should_stop_callback, extend_system_message)` | `browser_use/agent/service.py:136-206` |
| `await agent.run(max_steps=N)` -> `AgentHistoryList` | `agent/service.py:2503` |
| `history.is_done()`, `.is_successful()`, `.number_of_steps()`, `.history[i].model_output.action`, `.result[i].error`, `.state.url` | `agent/views.py:727, 734, 885, 488, 307, 116` |
| `BrowserProfile(headless, user_data_dir, keep_alive, enable_default_extensions, executable_path, downloads_path, accept_downloads, allowed_domains)` | `browser_use/browser/profile.py:359, 425, 430, 455, 557, 628, 640, 648` |
| `BrowserSession.start/kill/take_screenshot/get_current_page_url/get_tabs`, `.cdp_client` | `browser/session.py:727, 734, 4033, 2426, 2348, 1339` |
| `Tools(exclude_actions=[...])`, `@tools.action(description)` -> custom `needs_login` | `tools/service.py:444`, `tools/registry/service.py:291` |
| model protocol `BaseChatModel` (`model`, `provider`, `name`, `ainvoke(messages, output_format)`) | `llm/base.py:36` |
| `ChatInvokeCompletion`, `ChatInvokeUsage(prompt_tokens, completion_tokens, ...)` | `llm/views.py` |
| `ChatOpenAI/ChatAnthropic/ChatOpenRouter/ChatGoogle/ChatOllama` | `browser_use/__init__.py` lazy table |
| security watchdog (BU's own fence, reactive: `NavigateToUrlEvent` pre-check; completed navigation -> `about:blank`; new tab closed) | `browser/watchdogs/security_watchdog.py:35-92` |
| `BROWSER_USE_CONFIG_DIR`, `ANONYMIZED_TELEMETRY`, `BROWSER_USE_CLOUD_SYNC` | `browser_use/config.py:58-96` |
| CDP event dispatch, ONE callback per method (`register` replaces) | `cdp_use/cdp/registry.py:14-44`, `cdp_use/client.py:336` |

## What the runner does with them

- **Fence, two layers.** (1) Browser Use's own `allowed_domains` (`https://d`, `https://*.d`). (2) Ours, authoritative:
  `Fence.allows` (host == domain or subdomain on a label boundary; https only; no credentials in the URL; plain
  http only for host `127.0.0.1`, the test fixture). It is fed by tapping `EventRegistry.handle_event` so it sees
  every `Network.requestWillBeSent` of type Document (redirects included), `Page.frameNavigated`,
  `Target.targetCreated`/`targetInfoChanged` for pages (popups, new tabs). **Why a tap, not `register`**: cdp-use keeps
  one callback per event, so `register.Target.targetInfoChanged(...)` unseats Browser Use's session manager
  (observed: the agent's tab stayed `about:blank`). The tap uses the private `_event_registry`; a Browser Use upgrade
  must re-run the runner tests. First violation -> reason `off_domain`, the run is cancelled and the browser killed.
  A tap that cannot read an event also aborts (`error`).
- **Limit of "fail closed".** Navigation is observed and aborted, not intercepted: a click that goes off-domain has
  its first request issued before the abort lands. Browser Use's own pre-check blocks agent-initiated `navigate`
  before it starts. Sub-resources (images, scripts) are not fenced; third-party *documents* (an embedded iframe) are,
  so a page that embeds one aborts the task.
- **`max_steps`.** `agent.run(max_steps=N)` with `max_actions_per_step=1`, so a step is one action and the step log
  cannot exceed N. Not done by then -> `max_steps`. Masora re-checks.
- **Cost.** `MeteredLLM` wraps the model: tokens from `ChatInvokeUsage` x `usd_per_mtok_in/out` from the model's
  config entry (default 0: free models). Over `max_usd` -> `cost_cap`; no further call is made.
- **Secrets.** Values live in a local file (`secrets_file`, default `<zevetHome>/browser-secrets.json`,
  `{"placeholder": "value"}`); the instruction names the placeholder. They go to `sensitive_data` scoped per allowed
  domain, `use_vision=False`. `MeteredLLM` additionally refuses any message list containing a secret value
  (task fails `error`). Test: the page echoes the submitted value back and no prompt contains it.
- **Excluded actions** (not part of a fenced task): `search`, `upload_file`, `save_as_pdf`, `write_file`,
  `replace_file`, `read_file`, `evaluate`. Added action `needs_login` -> reason `login_required`.
- **Disk.** `BROWSER_USE_CONFIG_DIR`, downloads and the agent file system point into one temp dir removed on exit;
  `enable_default_extensions=False` (no extension downloads); telemetry and cloud sync off. The profile
  (`<zevetHome>/browser-profile`) is the only persistent state, and it is dedicated, never the person's Chrome.
  The screenshot is taken in memory; only its SHA-256 is reported. No screenshot -> SHA-256 of nothing.
- **Login.** `runner.py --login --profile DIR [--url U] [--chrome P]` opens the same profile headed. Person-initiated
  only; nothing calls it. Not exercised by any test (tests open no window).
- **Model.** From `config.models` (written by the Node side from `<zevetHome>/browser-task.json`) the first entry whose
  `provider` is in the claim's `allowed_providers` (null = any). None -> `failed` / `model_not_allowed` before any page
  opens. See INSUF-B5-BROWSER-2 in `INSUFFICIENCIES.md`: Zevet has no in-process model path.
- **Output.** stdout carries exactly one JSON object; Python's `sys.stdout` is pointed at stderr while it runs.
  The Node side rebuilds the report field by field anyway (`buildReport`) and repeats Masora's re-check.

## Deviations from the Masora contract

None in the wire. Behavioural notes: report URLs have query and fragment dropped on this side too; a failed task
that never reached a page reports `final_url` = the (stripped) `start_url` and the empty-input SHA-256, because
both fields are required.
