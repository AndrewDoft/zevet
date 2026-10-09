"""Tests for runner.py: plain asserts, headless Chromium, a local fixture site, a scripted fake model.

    python test_runner.py <name>     run one test (exit 0 = pass)      python test_runner.py --list
Needs `browser-use==<PINNED>` importable and a Chromium (ZEVET_BROWSER_CHROME, else Playwright's, else Chrome).
Binds 127.0.0.1 only; opens no window; stops everything it starts.
"""
import asyncio
import faulthandler
import glob
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.update(ANONYMIZED_TELEMETRY="false", BROWSER_USE_CLOUD_SYNC="false", BROWSER_USE_LOGGING_LEVEL="error")
import runner  # noqa: E402

SECRET = "hunter2-Zq9"
SECRET2 = "other-Wx7-private"
BS = chr(92)  # a backslash
HITS = []
STAMPS = []  # (monotonic time, server port, path) of every request
FREE = {"usd_per_mtok_in": 0.0, "usd_per_mtok_out": 0.0}


class Site(BaseHTTPRequestHandler):
    other_port = 0  # the second origin, reached as `localhost` (not in allowed_domains)

    def log_message(self, *a):
        pass

    def handle(self):
        try:
            super().handle()
        except ConnectionError:
            pass  # the browser was killed mid-request

    def _send(self, body, code=200, headers=()):
        self.send_response(code)
        self.send_header("content-type", "text/html")
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body.encode())

    def do_GET(self):
        HITS.append(self.path)
        STAMPS.append((time.monotonic(), self.server.server_port, self.path))
        o = f"http://localhost:{self.other_port}/"
        if self.server.server_port == self.other_port:  # the off-limits origin keeps navigating by itself
            return self._send("<script>setInterval(()=>{location.href='/?'+Math.random()},50)</script>")
        if self.path == "/hub":  # keeps talking to its own origin; the link opens the off-limits one in a new tab
            return self._send("<script>setInterval(()=>fetch('/tick?'+Math.random()),50)</script>"
                              f'<a href="{o}" target="_blank">elsewhere</a>')
        if self.path == "/redir":
            return self._send("", 302, [("location", o)])
        if self.path == "/form":
            return self._send('<form method="post" action="/result"><input name="u" type="text" placeholder="User"><input name="p" type="password" placeholder="Pass">'
                              '<button type="submit">Go</button></form>')
        if self.path == "/nologin":
            return self._send("<h1>Please sign in</h1>")
        self._send(f'<h1>Home</h1><a href="/form">form</a> <a href="{o}">elsewhere</a> <a href="/redir">redirect</a>')

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n).decode()
        HITS.append("POST /result " + body)
        self._send(f"<h1>Saved</h1><p>echo: {body}</p>")


def serve(port=0):
    s = ThreadingHTTPServer(("127.0.0.1", port), Site)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


class FakeLLM:
    """Scripted model. `plan(call_no, text) -> action dict`; records every message list it is sent."""
    provider, name, model_name = "fake", "fake", "fake"

    def __init__(self, plan, model="fake", tokens=10):
        self.plan, self.model, self.tokens, self.calls = plan, model, tokens, []

    async def ainvoke(self, messages, output_format=None, **kw):
        from browser_use.llm.views import ChatInvokeCompletion, ChatInvokeUsage
        text = "\n".join(str(m.content) for m in messages)
        self.calls.append(text)
        usage = ChatInvokeUsage(prompt_tokens=self.tokens, prompt_cached_tokens=None, prompt_cache_creation_tokens=None,
                                prompt_image_tokens=None, completion_tokens=self.tokens, total_tokens=2 * self.tokens)
        if output_format is None:
            return ChatInvokeCompletion(completion="ok", usage=usage)
        act = self.plan(len(self.calls), text)
        out = output_format.model_validate({"evaluation_previous_goal": "-", "memory": "-", "next_goal": "-", "action": [act]})
        return ChatInvokeCompletion(completion=out, usage=usage)


def link_index(text, label):
    m = re.search(r"\[(\d+)\]<a[^>\n]*>\s*" + label, text.rsplit("Interactive elements:", 1)[-1])
    assert m, f"no link {label!r} in:\n{text[-1200:]}"
    return int(m.group(1))


def index_of(text, pattern):
    m = re.search(r"\[(\d+)\]<[^>\n]*" + pattern, text.rsplit("Interactive elements:", 1)[-1])
    assert m, f"no element matching {pattern!r} in the browser state:\n{text[-1500:]}"
    return int(m.group(1))


def chrome():
    p = os.environ.get("ZEVET_BROWSER_CHROME")
    if p:
        return p
    found = glob.glob(os.path.expandvars(r"%LOCALAPPDATA%\ms-playwright\chromium-*\chrome-win*\chrome.exe")) \
        + glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome"))
    return sorted(found)[-1] if found else None


def task_for(port, **over):
    t = {"task_id": "t", "start_url": f"http://127.0.0.1:{port}/", "instruction": "do it", "allowed_domains": ["127.0.0.1"],
         "max_steps": 6, "max_usd": 2.0, "allowed_providers": None}
    t.update(over)
    return t


def run(task, llm, secrets=None, on_observe=None, **cfg):
    d = tempfile.mkdtemp(prefix="zevet-bt-test-")
    try:
        sec = os.path.join(d, "secrets.json")
        json.dump({"127.0.0.1": {"pw": SECRET}} if secrets is None else secrets, open(sec, "w"))
        c = {"profile_dir": os.path.join(d, "profile"), "chrome_path": chrome(), "temp_dir": d, "secrets_file": sec,
             "timeout_s": 120, "fixture_loopback": True, "price": FREE, **cfg}
        return asyncio.new_event_loop().run_until_complete(runner.run_task(task, c, llm, on_observe))
    finally:
        shutil.rmtree(d, ignore_errors=True)


def with_sites(fn):
    other, main = serve(), serve()
    Site.other_port = other.server_address[1]
    HITS.clear()
    STAMPS.clear()
    try:
        return fn(main.server_address[1])
    finally:
        main.shutdown(), other.shutdown()


# ---- tests -----------------------------------------------------------------------------------------------------------

def test_fence_boundaries():
    f = runner.Fence(["app.example.com"])
    assert f.allows("https://app.example.com/x?y=1")
    assert f.allows("https://a.b.app.example.com/")
    assert not f.allows("https://evilapp.example.com/"), "label boundary"
    assert not f.allows("https://app.example.com.evil.io/")
    assert not f.allows("https://example.com/")
    assert not f.allows("http://app.example.com/"), "https only"
    assert not f.allows("https://user:pw@app.example.com/"), "credentials in the url"
    assert not f.allows("data:text/html,hi") and not f.allows("javascript:alert(1)") and not f.allows("file:///c:/x")
    assert f.allows("about:blank")


def test_form_task_completes_and_secret_never_reaches_the_model():
    def go(port):
        base = f"http://127.0.0.1:{port}/"

        def plan(n, text):
            if n == 1:
                return {"navigate": {"url": base + "form"}}
            if n == 2:
                return {"input": {"index": index_of(text, r"placeholder=User"), "text": "alice"}}
            if n == 3:
                return {"input": {"index": index_of(text, r"placeholder=Pass"), "text": "<secret>pw</secret>"}}
            if n == 4:
                return {"click": {"index": index_of(text, r"(?:button|submit)")}}
            return {"done": {"text": "saved", "success": True}}

        llm = FakeLLM(plan)
        r = run(task_for(port, max_steps=8), llm)
        assert r["status"] == "done" and r["reason"] is None, r
        assert any("POST /result" in h and SECRET in h for h in HITS), f"the real value must reach the page: {HITS}"
        assert not any(SECRET in c for c in llm.calls), "secret value found in a prompt"
        assert any("Saved" in c for c in llm.calls), "the result page was never shown to the model"
        assert [s["verb"] for s in r["steps"]][:2] == ["navigate", "navigate"], r["steps"]
        assert all(s["url"].startswith(base) for s in r["steps"]) and r["final_url"].startswith(base)
        assert re.fullmatch(r"[0-9a-f]{64}", r["screenshot_sha256"]) and r["screenshot_sha256"] != runner.EMPTY_SHA256
        assert set(r) == {"status", "steps", "final_url", "screenshot_sha256", "reason", "cost_usd"}
        assert "?" not in json.dumps(r["steps"]) and SECRET not in json.dumps(r) and "alice" not in json.dumps(r)

    with_sites(go)


def test_off_domain_click_aborts():
    def go(port):
        r = run(task_for(port), FakeLLM(lambda n, t: {"click": {"index": link_index(t, "elsewhere")}}))
        assert r["status"] == "failed" and r["reason"] == "off_domain", r
        assert all("localhost" not in s["url"] for s in r["steps"]) and "localhost" not in r["final_url"], r

    with_sites(go)


def test_off_domain_redirect_aborts():
    def go(port):
        r = run(task_for(port), FakeLLM(lambda n, t: {"navigate": {"url": f"http://127.0.0.1:{port}/redir"}}))
        assert r["status"] == "failed" and r["reason"] == "off_domain", r
        assert "localhost" not in r["final_url"], r

    with_sites(go)


def test_start_url_outside_the_fence_never_opens():
    def go(port):
        r = run(task_for(port, start_url=f"http://localhost:{port}/"), FakeLLM(lambda n, t: {"wait": {"seconds": 1}}))
        assert r["reason"] == "off_domain" and HITS == [], (r, HITS)

    with_sites(go)


def test_max_steps_is_a_hard_stop():
    def go(port):
        llm = FakeLLM(lambda n, t: {"wait": {"seconds": 1}})
        r = run(task_for(port, max_steps=3), llm)
        assert r["status"] == "failed" and r["reason"] == "max_steps", r
        assert len(r["steps"]) <= 3 and len(llm.calls) <= 3, (len(r["steps"]), len(llm.calls))

    with_sites(go)


def test_cost_cap_stops_the_task():
    def go(port):
        llm = FakeLLM(lambda n, t: {"wait": {"seconds": 1}}, tokens=1_000_000)  # $1 in + $1 out per call at $1/Mtok
        r = run(task_for(port, max_usd=0.5, max_steps=10), llm, price={"usd_per_mtok_in": 1.0, "usd_per_mtok_out": 1.0})
        assert r["status"] == "failed" and r["reason"] == "cost_cap", r
        assert len(llm.calls) == 1 and r["cost_usd"] >= 0.5, (len(llm.calls), r)

    with_sites(go)


def test_model_not_allowed_opens_no_page():
    def go(port):
        cfg_models = [{"provider": "openai", "client": "openai", "model": "x"}]
        r = run(task_for(port, allowed_providers=["claude"]), None, models=cfg_models)
        assert r["status"] == "failed" and r["reason"] == "model_not_allowed", r
        assert HITS == [], f"a page was opened: {HITS}"
        assert r["screenshot_sha256"] == runner.EMPTY_SHA256

    with_sites(go)


def test_needs_login_reports_login_required():
    def go(port):
        r = run(task_for(port), FakeLLM(lambda n, t: {"needs_login": {}}))
        assert r["status"] == "failed" and r["reason"] == "login_required", r

    with_sites(go)


def test_secret_in_a_prompt_is_refused_by_the_meter():
    guard = runner.Guard()

    async def go():
        m = runner.MeteredLLM(FakeLLM(lambda n, t: {}), guard, 1.0, secrets=[SECRET])

        class Msg:
            content = f"password is {SECRET}"

        try:
            await m.ainvoke([Msg()], None)
        except RuntimeError:
            return
        raise AssertionError("a prompt carrying a secret was sent")

    asyncio.run(go())
    assert guard.reason == "error"


def test_fence_url_confusion():
    f = runner.Fence(["good.com"])
    assert f.allows("https://good.com/x") and f.allows("https://GOOD.com./x?a=1#f") and f.allows("https://a.good.com:8443/")
    for bad in [
        f"https://evil.com{BS}.good.com/",  # urlsplit: host `evil.com\.good.com` (suffix check passes); Chrome goes to evil.com
        f"https://good.com{BS}@evil.com/", f"https://evil.com{BS}@good.com/", f"https://good.com/a{BS}b",
        "https://good.com/a\tb", "https://good.com/a\nb", "https://good.com/a\rb", "https://good.com/a b", "https://good.com/a\x00b",
        "https://evil.com\t.good.com/", "https://evil.com\n.good.com/", " https://good.com/", "https://good.com/\x7f",
        "https://user@good.com/", "https://good.com@evil.com/", "https://user:pw@good.com/", "https://evil.com@good.com/",
        "https://%65vil.com/", "https://good.com%2eevil.com/", "https://good.com%40evil.com/",
        "https://ｇood.com/", "https://göod.com/", "https://ɡood.com/",  # fullwidth g, o-umlaut, latin script g
        "https://[::1]/", "https://good.com:99999/", "https://good.com:80:90/", "https://good.com:abc/", "https:///good.com/",
        "http://good.com/", "ftp://good.com/", "good.com/x", "", None, 5,
    ]:
        assert not f.allows(bad), f"must be off-domain: {bad!r}"
    assert not f.allows("https://good.com.evil.io/") and not f.allows("https://evilgood.com/")


def test_fence_numeric_hosts():
    for entry in ["127.1", "0x7f.1", "1.0x7f", "2130706433", "0177.0.0.1", "127.0.0.1", "10.0.0.1", "[::1]", "::1", "localhost",
                  "app.localhost", "good.com.1", "good.com.0x10", "*.good.com", "good .com", "good.com/x", "gööd.com"]:
        assert runner.Fence([entry]).bad, f"entry must be rejected: {entry!r}"
        assert not runner.Fence(["good.com", entry]).allows("https://good.com/"), f"a fence with a bad entry allows nothing: {entry!r}"
    ok = runner.Fence(["good.com", "a1.good.org", "x-y.example.co.uk", "GOOD.net."])
    assert ok.bad == [] and ok.domains[-1] == "good.net"
    f = runner.Fence(["good.com"])
    for u in ["https://127.1/", "https://0x7f.1/", "https://2130706433/", "https://0177.0.0.1/", "https://127.0.0.1/", "https://[::1]/",
              "https://localhost/", "https://good.com.1/", "https://good.com.0x7f/", "https://a.localhost/"]:
        assert runner.judge_url(u) is None and not f.allows(u), u
    assert runner.Fence(["127.0.0.1"], loopback=True).allows("http://127.0.0.1:5/"), "the test fixture's own switch"
    assert not runner.Fence(["127.0.0.1"], loopback=True).allows("http://127.1/")
    assert not runner.Fence(["127.0.0.1"]).allows("http://127.0.0.1:5/")


def test_invalid_allowed_domain_never_opens():
    def go(port):
        r = run(task_for(port, allowed_domains=["127.0.0.1", "localhost"]), FakeLLM(lambda n, t: {"wait": {"seconds": 1}}))
        assert r["status"] == "failed" and r["reason"] == "error" and HITS == [], (r, HITS)
        r = run(task_for(port), FakeLLM(lambda n, t: {"wait": {"seconds": 1}}), fixture_loopback=False)  # a numeric entry outside the test switch
        assert r["reason"] == "error" and HITS == [], (r, HITS)

    with_sites(go)


def test_scope_secrets_by_domain():
    secrets = {"example.com": {"a": "1"}, "other.org": {"b": "2"}, "sub.example.com": {"c": "3"}, "127.0.0.1": {"d": "4"}, "localhost": {"e": "5"}}
    got = runner.scope_secrets(secrets, runner.Fence(["app.example.com"]))
    assert got == {"https://app.example.com": {"a": "1"}, "https://*.app.example.com": {"a": "1"}}, got
    got = runner.scope_secrets(secrets, runner.Fence(["example.com"]))  # sub.example.com's key does not cover all of example.com
    assert set(got) == {"https://example.com", "https://*.example.com"} and got["https://example.com"] == {"a": "1"}, got
    got = runner.scope_secrets(secrets, runner.Fence(["sub.example.com", "other.org"]))
    assert got["https://sub.example.com"] == {"a": "1", "c": "3"} and got["https://other.org"] == {"b": "2"}, got
    assert "https://example.com" not in got
    for elsewhere in ["elsewhere.net", "notexample.com", "evil.com", "example.com.evil.io"]:
        assert runner.scope_secrets(secrets, runner.Fence([elsewhere])) == {}, elsewhere
    assert runner.scope_secrets(secrets, runner.Fence(["localhost"])) == {}
    both = runner.scope_secrets({"127.0.0.1": {"d": "4"}}, runner.Fence(["127.0.0.1"], loopback=True))
    assert both == {"http*://127.0.0.1": {"d": "4"}, "http*://*.127.0.0.1": {"d": "4"}}, both


def test_secrets_file_format():
    d = tempfile.mkdtemp(prefix="zevet-bt-sec-")
    p = os.path.join(d, "s.json")
    try:
        def load(text):
            open(p, "w").write(text)
            return runner.load_secrets(p)

        assert runner.load_secrets(None) == {} and runner.load_secrets(os.path.join(d, "missing.json")) == {}
        assert load('{"Example.COM.": {"pw": "x"}}') == {"example.com": {"pw": "x"}}
        for legacy in ['{"pw": "x"}', '{"pw": "x", "example.com": {"a": "b"}}', '{"example.com": {"a": 1}}', "[]", '{"example.com": "x"}', "{not json"]:
            try:
                load(legacy)
            except runner.SecretsError:
                pass
            else:
                raise AssertionError(f"accepted: {legacy}")
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_legacy_flat_secrets_file_refuses_the_task():
    def go(port):
        r = run(task_for(port), FakeLLM(lambda n, t: {"wait": {"seconds": 1}}), secrets={"pw": SECRET})
        assert r["status"] == "failed" and r["reason"] == "error" and HITS == [], (r, HITS)

    with_sites(go)


def test_secret_for_another_domain_is_unavailable():
    def go(port):
        base = f"http://127.0.0.1:{port}/"

        def plan(n, text):
            if n == 1:
                return {"navigate": {"url": base + "form"}}
            if n == 2:
                return {"input": {"index": index_of(text, r"placeholder=Pass"), "text": "<secret>pw2</secret>"}}
            if n == 3:
                return {"click": {"index": index_of(text, r"(?:button|submit)")}}
            return {"done": {"text": "saved", "success": True}}

        llm = FakeLLM(plan)
        run(task_for(port, max_steps=8), llm, secrets={"127.0.0.1": {"pw": SECRET}, "elsewhere.example": {"pw2": SECRET2}})
        assert any("POST /result" in h for h in HITS), f"the form was never submitted: {HITS}"
        assert not any(SECRET2 in h for h in HITS), f"the other domain's credential reached the page: {HITS}"
        assert not any(SECRET2 in c for c in llm.calls), "the other domain's credential reached a prompt"

    with_sites(go)


def test_missing_price_refuses_before_any_page():
    def go(port):
        llm = FakeLLM(lambda n, t: {"wait": {"seconds": 1}})
        base = {"provider": "openai", "client": "openai", "model": "x"}
        for models in [[base], [{**base, "usd_per_mtok_in": 1.0}], [{**base, "usd_per_mtok_out": 1.0}],
                       [{**base, "usd_per_mtok_in": -1, "usd_per_mtok_out": 1}], [{**base, "usd_per_mtok_in": True, "usd_per_mtok_out": 1}],
                       [{**base, "usd_per_mtok_in": "1", "usd_per_mtok_out": 1}]]:
            r = run(task_for(port), None, models=models)
            assert r["status"] == "failed" and r["reason"] == "error" and HITS == [], (models, r, HITS)
            assert isinstance(r["cost_usd"], float) and r["cost_usd"] == 0.0, r
        r = run(task_for(port), llm, price={})  # the test seam is held to the same rule
        assert r["reason"] == "error" and HITS == [] and llm.calls == [], r
        assert runner.prices({"usd_per_mtok_in": 0, "usd_per_mtok_out": 0}) == (0.0, 0.0)

    with_sites(go)


def test_every_report_carries_a_numeric_cost():
    def go(port):
        for r in [run(task_for(port, start_url=f"http://localhost:{port}/"), FakeLLM(lambda n, t: {})),
                  run(task_for(port, allowed_providers=["claude"]), None, models=[{"provider": "openai", "client": "openai", "model": "x"}]),
                  run(task_for(port), FakeLLM(lambda n, t: {"done": {"text": "ok", "success": True}}))]:
            assert isinstance(r["cost_usd"], float) and r["cost_usd"] >= 0, r

    with_sites(go)


def test_abort_kills_the_browser_before_the_agent_cancels():
    import browser_use
    from browser_use.browser.session import BrowserSession
    killed, cancelled, tripped = [], [], []
    orig_run, orig_kill, orig_trip = browser_use.Agent.run, BrowserSession.kill, runner.Guard.trip

    async def lingering_run(self, *a, **k):
        try:
            res = await orig_run(self, *a, **k)
        except asyncio.CancelledError:
            cancelled.append(time.monotonic())
            await asyncio.sleep(4)  # ignores the cancel for a while
            raise
        except Exception:
            res = None  # the run ends; the lingering task below does not
        try:
            await asyncio.sleep(4)  # a Browser Use background task that outlives the run and takes its time to cancel
        except asyncio.CancelledError:
            cancelled.append(time.monotonic())
            await asyncio.sleep(4)
            raise
        return res

    async def timed_kill(self):
        killed.append(time.monotonic())
        return await orig_kill(self)

    def timed_trip(self, reason):
        if self.reason is None:
            tripped.append(time.monotonic())
        return orig_trip(self, reason)

    browser_use.Agent.run, BrowserSession.kill, runner.Guard.trip = lingering_run, timed_kill, timed_trip
    try:
        def go(port):
            r = run(task_for(port, start_url=f"http://127.0.0.1:{port}/hub"), FakeLLM(lambda n, t: {"click": {"index": link_index(t, "elsewhere")}}))
            assert r["status"] == "failed" and r["reason"] == "off_domain", r
            assert tripped and killed and cancelled, (tripped, killed, cancelled)
            assert killed[0] < cancelled[0], "the browser must be killed before the agent task is asked to cancel"
            t0 = tripped[0]
            late = [(round(t - t0, 2), p, path) for t, p, path in STAMPS if t > t0 + 1.5]
            assert not late, f"requests kept arriving after the trip (secs after, port, path): {late[:5]}"
            assert any(p == Site.other_port for _, p, _ in STAMPS), "the off-limits origin was never reached; the test proves nothing"
            assert any(path.startswith("/tick") for _, _, path in STAMPS), "the allowed origin never ticked; the test proves nothing"

        with_sites(go)
    finally:
        browser_use.Agent.run, BrowserSession.kill, runner.Guard.trip = orig_run, orig_kill, orig_trip


def test_fence_tap_sees_real_cdp_events():
    def go(port):
        base = f"http://127.0.0.1:{port}/"
        seen = []
        llm = FakeLLM(lambda n, t: {"navigate": {"url": base + "form"}} if n == 1 else {"done": {"text": "ok", "success": True}})
        r = run(task_for(port, max_steps=4), llm, on_observe=lambda m, u: seen.append((m, u)))
        assert r["status"] == "done", r
        assert seen, "the tap received nothing: the fence is blind"
        assert {"Network.requestWillBeSent", "Page.frameNavigated"} <= {m for m, _ in seen}, seen
        assert ("Network.requestWillBeSent", base + "form") in seen, seen
        assert ("Page.frameNavigated", base + "form") in seen, seen
        assert all(u in runner.INTERNAL_URLS or u.startswith(base) for _, u in seen), seen

    with_sites(go)


NO_BROWSER = {"fence_boundaries", "fence_url_confusion", "fence_numeric_hosts", "scope_secrets_by_domain", "secrets_file_format",
              "secret_in_a_prompt_is_refused_by_the_meter", "invalid_allowed_domain_never_opens", "legacy_flat_secrets_file_refuses_the_task",
              "missing_price_refuses_before_any_page"}  # these refuse before a browser would start
TESTS = {k[5:]: v for k, v in globals().items() if k.startswith("test_")}

if __name__ == "__main__":
    if sys.argv[1:] == ["--list"]:
        print("\n".join(TESTS))
        sys.exit(0)
    name = sys.argv[1]
    faulthandler.dump_traceback_later(100, exit=True)  # a hung test fails with every thread's stack, it never hangs the suite
    if name not in NO_BROWSER and not chrome():
        print("NO CHROMIUM FOUND", file=sys.stderr)
        sys.exit(77)
    TESTS[name]()
    print("PASS", name)
