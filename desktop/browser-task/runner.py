"""Browser Use driver for Masora's `browser.task` (contract: docs/contracts/browser-task.md).

    runner.py run      stdin: {"task": <claim>, "config": {...}}   stdout: ONE JSON object (the report fields)
    runner.py --login  --profile DIR [--url URL] [--chrome PATH]   opens the SAME profile headed; person-initiated only

Everything the model or the page says stays in this process. The report carries only the closed vocabulary.
"""
import asyncio
import hashlib
import json
import os
import re
import sys
import tempfile
import time
from urllib.parse import urlparse, urlsplit

PINNED_BROWSER_USE = "0.13.10"
# Actions that read/write local files, run page JS, open a search engine or upload: not part of a fenced task.
EXCLUDED_ACTIONS = ["search", "upload_file", "save_as_pdf", "write_file", "replace_file", "read_file", "evaluate"]
VERBS = {  # Browser Use action name -> contract verb; anything unlisted is "other"
    "navigate": "navigate", "go_back": "navigate", "click": "click", "input": "type", "send_keys": "type",
    "select_dropdown": "select", "scroll": "scroll", "find_text": "scroll", "wait": "wait", "extract": "extract",
}
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()  # "no screenshot": the hash of nothing
INTERNAL_URLS = {"about:blank", "about:srcdoc", "chrome://newtab/", "chrome://new-tab-page/", "chrome-error://chromewebdata/"}


def strip_url(url):
    """scheme://host/path -- query and fragment never leave this process."""
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}{p.path}"[:2000]


_UNSAFE = re.compile(r"[\x00-\x20\x7f\x5c]")  # control chars, space, tab/newline/CR and backslash (\x5c): Chrome and urlsplit disagree on these
_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
_HOST = re.compile(rf"{_LABEL}(?:\.{_LABEL})*")
_NUMBER = re.compile(r"\d+|0x[0-9a-f]*")  # WHATWG "ends in a number": the last label is decimal or 0x-hex
_AUTHORITY = re.compile(r"([^:]*)(?::\d{0,5})?")


def clean_host(host, loopback=False):
    """A plain DNS name: ASCII labels, not a number or IP literal, not localhost. `loopback` admits exactly 127.0.0.1 (test fixture)."""
    if loopback and host == "127.0.0.1":
        return True
    if not host or len(host) > 253 or not _HOST.fullmatch(host) or _NUMBER.fullmatch(host.rsplit(".", 1)[-1]):
        return False
    return host != "localhost" and not host.endswith(".localhost")


def judge_url(url, loopback=False):
    """(scheme, host) of a URL we are willing to judge, else None. Fail closed: anything odd is None."""
    if not isinstance(url, str) or _UNSAFE.search(url):
        return None
    try:
        p = urlsplit(url)
        p.port  # raises on a bad port
    except ValueError:
        return None
    m = _AUTHORITY.fullmatch(p.netloc)
    if not m or not p.netloc.isascii() or "@" in p.netloc or "%" in p.netloc:  # userinfo, percent-encoded host, IPv6 literal ([ has no match above)
        return None
    host = m.group(1).lower().rstrip(".")
    return (p.scheme.lower(), host) if clean_host(host, loopback) else None


class Fence:
    """host == domain, or a subdomain of it on a label boundary. https only (plain http for the 127.0.0.1 test fixture, `loopback`).
    `bad` lists the allowed-domain entries that are not plain DNS names; a fence with any is never used."""

    def __init__(self, domains, loopback=False):
        self.loopback = loopback
        self.domains = [str(d).lower().strip(".") for d in domains]
        self.bad = [d for d in self.domains if not clean_host(d, loopback)]

    def allows(self, url):
        if url in INTERNAL_URLS:
            return True
        j = judge_url(url, self.loopback)
        if not j or self.bad:
            return False
        scheme, host = j
        if scheme != "https" and not (self.loopback and scheme == "http" and host == "127.0.0.1"):
            return False
        return any(host == d or host.endswith("." + d) for d in self.domains)

    def real(self, url):
        """In the fence AND a real page (not an internal placeholder)."""
        return url not in INTERNAL_URLS and self.allows(url)


class Guard:
    """First violation wins. `event` is awaited by the driver, which then kills the run."""

    def __init__(self):
        self.reason = None
        self.event = asyncio.Event()
        self.off_url = None

    def trip(self, reason):
        if self.reason is None:
            self.reason = reason
            self.event.set()


class MeteredLLM:
    """Wraps the real model: measures cost, refuses once the task is over, never lets a secret value through."""

    def __init__(self, inner, guard, max_usd, usd_in=0.0, usd_out=0.0, secrets=()):
        self.inner, self.guard, self.max_usd = inner, guard, max_usd
        self.usd_in, self.usd_out = usd_in, usd_out
        self.secrets = [s for s in secrets if s]
        self.cost = 0.0
        self.model = inner.model
        self._verified_api_keys = True

    provider = property(lambda s: s.inner.provider)
    name = property(lambda s: s.inner.name)
    model_name = property(lambda s: s.inner.model)

    def __getattr__(self, item):  # anything else Browser Use reads off the model
        return getattr(self.inner, item)

    async def ainvoke(self, messages, output_format=None, **kw):
        if self.guard.reason:
            raise RuntimeError("task already stopped")
        text = " ".join(str(getattr(m, "content", m)) for m in messages)
        if any(s in text for s in self.secrets):  # defence in depth: sensitive_data should have masked it
            self.guard.trip("error")
            raise RuntimeError("a secret value reached a prompt")
        if self.max_usd is not None and self.cost >= self.max_usd:
            self.guard.trip("cost_cap")
            raise RuntimeError("cost cap")
        res = await self.inner.ainvoke(messages, output_format, **kw)
        u = res.usage
        tin, tout = (u.prompt_tokens, u.completion_tokens) if u else (len(text) // 4, 500)
        self.cost += (tin * self.usd_in + tout * self.usd_out) / 1e6
        if self.max_usd is not None and self.cost > self.max_usd:
            self.guard.trip("cost_cap")
        return res


CLIENTS = {"openai": "ChatOpenAI", "anthropic": "ChatAnthropic", "openrouter": "ChatOpenRouter", "google": "ChatGoogle", "ollama": "ChatOllama"}


def pick_model(cfg, allowed_providers):
    """First configured model entry whose `provider` the claim allows (null = any) and whose client we know, or None."""
    for m in cfg.get("models") or []:
        if (allowed_providers is None or m.get("provider") in allowed_providers) and m.get("client") in CLIENTS:
            return m
    return None


def prices(entry):
    """(usd_per_mtok_in, usd_per_mtok_out) or None. BOTH must be stated (0 for a free model): a cap we cannot measure is no cap."""
    vals = [(entry or {}).get("usd_per_mtok_in"), (entry or {}).get("usd_per_mtok_out")]
    ok = all(isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 for v in vals)
    return tuple(float(v) for v in vals) if ok else None


def make_llm(m):
    """The Browser Use chat model for a config entry. Keys come from env vars the Node side sets."""
    import browser_use as bu
    kw = {"model": m["model"]}
    if m.get("base_url"):
        kw["base_url"] = m["base_url"]
    if m.get("api_key_env"):
        kw["api_key"] = os.environ.get(m["api_key_env"]) or None
    return getattr(bu, CLIENTS[m["client"]])(**kw)


class SecretsError(Exception):
    pass


def load_secrets(path):
    """{domain: {placeholder: value}}. No file = no secrets. A legacy flat {placeholder: value} file is refused, never applied to every domain."""
    if not path or not os.path.exists(path):
        return {}
    try:
        raw = json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise SecretsError(f"secrets file unreadable: {type(e).__name__}")
    ok = isinstance(raw, dict) and all(isinstance(d, str) and isinstance(v, dict) and all(isinstance(k, str) and isinstance(x, str) for k, x in v.items()) for d, v in raw.items())
    if not ok:
        raise SecretsError('secrets file must be {"<domain>": {"<placeholder>": "<value>"}}; a flat {"<placeholder>": "<value>"} file is no longer accepted -- nest each entry under the domain it belongs to')
    return {d.lower().strip("."): dict(v) for d, v in raw.items()}


def scope_secrets(secrets, fence):
    """{url pattern: {placeholder: value}} for sensitive_data. A key serves an allowed domain only if it covers ALL of it
    (key == domain or the domain is a subdomain of the key); a credential for any other domain is not passed on at all."""
    scheme = "http*" if fence.loopback else "https"
    scoped = {}
    for d in fence.domains:
        mine = {}
        for key, entries in secrets.items():
            if clean_host(key, fence.loopback) and (d == key or d.endswith("." + key)):
                mine.update(entries)
        if mine:
            scoped[f"{scheme}://{d}"] = scoped[f"{scheme}://*.{d}"] = mine
    return scoped


def steps_from(history, fence):
    steps = []
    for h in history.history:
        if not h.model_output:
            continue
        for i, act in enumerate(h.model_output.action):
            d = act.model_dump(exclude_unset=True)
            name = next(iter(d), "other")
            if name == "done":
                continue
            url = h.state.url
            if not fence.real(url) and name == "navigate":
                url = (d[name] or {}).get("url", "")
            if not fence.real(url):
                continue  # an internal placeholder page: nothing to report
            steps.append({"verb": VERBS.get(name, "other"), "url": strip_url(url),
                          "ok": i < len(h.result) and h.result[i].error is None})
    return steps


def navigation_url(method, p):
    """The URL a CDP event says a page (or frame, or popup) is going to / is at, else None. Only top-level-ish documents."""
    if method == "Network.requestWillBeSent" and p.get("type") == "Document":
        return p["request"]["url"]
    if method == "Page.frameNavigated":
        return p["frame"]["url"]
    if method in ("Target.targetCreated", "Target.targetInfoChanged") and p["targetInfo"]["type"] == "page":
        return p["targetInfo"]["url"]
    return None


def report(status, steps, final_url, sha, reason, cost):
    return {"status": status, "steps": steps, "final_url": final_url, "screenshot_sha256": sha,
            "reason": reason, "cost_usd": round(cost, 6)}


async def run_task(task, cfg, llm=None, on_observe=None):
    """Returns the report dict. `llm` and `on_observe(method, url)` are test seams: a ready model that skips make_llm; a view of the fence tap.
    Every refusal below happens before a page opens."""
    start_url = strip_url(task["start_url"])
    fence = Fence(task["allowed_domains"], loopback=bool(cfg.get("fixture_loopback")))  # the Node side never sets fixture_loopback
    refuse = lambda reason: report("failed", [], start_url, EMPTY_SHA256, reason, 0.0)
    if fence.bad:
        print(f"runner: allowed_domains entries that are not plain DNS names: {fence.bad}", file=sys.stderr)
        return refuse("error")
    if not fence.allows(task["start_url"]):
        return refuse("off_domain")
    entry = None
    if llm is None:
        entry = pick_model(cfg, task.get("allowed_providers"))
        if entry is None:
            return refuse("model_not_allowed")
    price = prices(entry if entry else cfg.get("price"))
    if price is None:
        print("runner: the model entry needs usd_per_mtok_in and usd_per_mtok_out (0 for a free model): the cost cap cannot be measured", file=sys.stderr)
        return refuse("error")
    try:
        secrets = load_secrets(cfg.get("secrets_file"))
    except SecretsError as e:
        print(f"runner: {e}", file=sys.stderr)
        return refuse("error")
    llm = llm or make_llm(entry)

    from browser_use import Agent, ActionResult, BrowserProfile, BrowserSession, Tools

    guard = Guard()
    scoped = scope_secrets(secrets, fence)
    scheme = "http*" if fence.loopback else "https"
    meter = MeteredLLM(llm, guard, task.get("max_usd"), price[0], price[1],
                       [v for entries in secrets.values() for v in entries.values()])  # every value, in scope or not

    tools = Tools(exclude_actions=EXCLUDED_ACTIONS)

    @tools.action("Call this when the page asks for a login you cannot complete. It ends the task.")
    async def needs_login():
        guard.trip("login_required")
        return ActionResult(extracted_content="stopped: login required")

    session = BrowserSession(browser_profile=BrowserProfile(
        headless=True, user_data_dir=cfg["profile_dir"], keep_alive=True,  # alive past run(): the screenshot; session.kill() below ends it
         enable_default_extensions=False,
        executable_path=cfg.get("chrome_path"), downloads_path=cfg["temp_dir"], accept_downloads=False,
        allowed_domains=[p for d in fence.domains for p in (f"{scheme}://{d}", f"{scheme}://*.{d}")]))
    agent = Agent(
        task=task["instruction"], llm=meter, browser_session=session, tools=tools,
        sensitive_data=scoped or None, use_vision=False, use_judge=False, enable_planning=False,
        directly_open_url=False, max_actions_per_step=1, max_failures=3, file_system_path=cfg["temp_dir"],
        initial_actions=[{"navigate": {"url": task["start_url"], "new_tab": False}}],
        register_should_stop_callback=lambda: _async_value(guard.reason is not None),
        extend_system_message=f"You may only visit {', '.join(fence.domains)}. Never type a credential you were not given as a placeholder.",
    )
    history = None
    sha, final = EMPTY_SHA256, None
    killed = False

    async def kill():
        nonlocal killed
        if killed:
            return
        killed = True
        try:
            await asyncio.wait_for(session.kill(), 20)  # browser_use/browser/session.py:734, BrowserStopEvent(force=True): the browser process goes
        except Exception:
            pass

    def observe(url):
        if not fence.allows(url) and guard.off_url is None:
            guard.off_url = url
            guard.trip("off_domain")

    try:
        await session.start()
        reg = session.cdp_client._event_registry  # ponytail: private; cdp-use keeps ONE callback per event, so registering would unseat Browser Use's own. Tap the dispatcher instead.
        deliver = reg.handle_event

        async def tap(method, params, session_id=None):
            try:
                url = navigation_url(method, params)
                if url is not None:
                    if on_observe:
                        on_observe(method, url)
                    observe(url)
            except Exception:
                guard.trip("error")  # an event we cannot read is not one we can vouch for
            return await deliver(method, params, session_id)

        reg.handle_event = tap
        work = asyncio.ensure_future(agent.run(max_steps=task["max_steps"]))
        trip = asyncio.ensure_future(guard.event.wait())
        await asyncio.wait({work, trip}, timeout=cfg.get("timeout_s", 1800), return_when=asyncio.FIRST_COMPLETED)
        if guard.reason and guard.reason != "login_required":
            await kill()  # the page must stop NOW; the agent task may take (or refuse) its time to cancel
        if not work.done():
            if guard.reason is None:
                guard.trip("error")  # wall-clock timeout
                await kill()
            work.cancel()
            await asyncio.wait({work}, timeout=10)
        else:
            history = work.result() if not work.cancelled() and not work.exception() else None
        trip.cancel()
        if guard.reason is None or guard.reason == "login_required":
            try:
                cur = await session.get_current_page_url()
                final = cur if fence.real(cur) else None
                sha = hashlib.sha256(await session.take_screenshot()).hexdigest()
            except Exception as e:
                print(f"runner: no screenshot ({type(e).__name__}: {e})", file=sys.stderr)
    except Exception as e:
        print(f"runner: {type(e).__name__}: {e}", file=sys.stderr)
        guard.trip("error")
    finally:
        await kill()

    steps = steps_from(history, fence) if history else []
    if guard.reason is None:
        if history is None or not history.is_done():
            guard.trip("max_steps" if history and history.number_of_steps() >= task["max_steps"] else "error")
        elif history.is_successful() is False:
            guard.trip("error")
    final = final or (steps[-1]["url"] if steps else start_url)
    return report("failed" if guard.reason else "done", steps, strip_url(final), sha, guard.reason, meter.cost)


def run_sync(task, cfg, llm=None):
    """asyncio.run() waits forever on a Browser Use background task that ignores cancel; this does not close the loop (the process exits next)."""
    return asyncio.new_event_loop().run_until_complete(run_task(task, cfg, llm))


async def _async_value(v):
    return v


async def login(profile, url, chrome):
    from browser_use import BrowserProfile, BrowserSession
    s = BrowserSession(browser_profile=BrowserProfile(headless=False, user_data_dir=profile, keep_alive=True,
                                                      enable_default_extensions=False, executable_path=chrome))
    await s.start()
    if url:
        await s.navigate_to(url)
    gone = 0
    while gone < 3:  # until the person closes the window
        await asyncio.sleep(1)
        try:
            gone = gone + 1 if not await s.get_tabs() else 0
        except Exception:
            break


def main(argv):
    os.environ.update(ANONYMIZED_TELEMETRY="false", BROWSER_USE_CLOUD_SYNC="false", BROWSER_USE_LOGGING_LEVEL="warning")
    out, sys.stdout = sys.stdout, sys.stderr  # stray prints from any library must not corrupt the one JSON line
    with tempfile.TemporaryDirectory(prefix="zevet-browser-task-") as tmp:
        os.environ["BROWSER_USE_CONFIG_DIR"] = tmp  # Browser Use writes nothing under the home dir
        if "--login" in argv:
            a = dict(zip(argv[1::2], argv[2::2]))
            asyncio.run(login(a["--profile"], a.get("--url"), a.get("--chrome")))
            return 0
        start_url = "https://invalid.invalid/"
        try:
            req = json.load(sys.stdin)
            start_url = strip_url(req["task"]["start_url"])
            result = run_sync(req["task"], {**req["config"], "temp_dir": tmp})
        except Exception as e:
            print(f"runner: {type(e).__name__}: {e}", file=sys.stderr)
            result = report("failed", [], start_url, EMPTY_SHA256, "error", 0.0)
    out.write(json.dumps(result) + "\n")
    out.flush()
    os._exit(0)  # ponytail: skip interpreter teardown, which can hang on those same tasks


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
