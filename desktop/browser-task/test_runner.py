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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.update(ANONYMIZED_TELEMETRY="false", BROWSER_USE_CLOUD_SYNC="false", BROWSER_USE_LOGGING_LEVEL="error")
import runner  # noqa: E402

SECRET = "hunter2-Zq9"
HITS = []


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
        o = f"http://localhost:{self.other_port}/"
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


def run(task, llm, **cfg):
    d = tempfile.mkdtemp(prefix="zevet-bt-test-")
    try:
        sec = os.path.join(d, "secrets.json")
        json.dump({"pw": SECRET}, open(sec, "w"))
        c = {"profile_dir": os.path.join(d, "profile"), "chrome_path": chrome(), "temp_dir": d, "secrets_file": sec,
             "timeout_s": 120, **cfg}
        return runner.run_sync(task, c, llm)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def with_sites(fn):
    other, main = serve(), serve()
    Site.other_port = other.server_address[1]
    HITS.clear()
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


TESTS = {k[5:]: v for k, v in globals().items() if k.startswith("test_")}

if __name__ == "__main__":
    if sys.argv[1:] == ["--list"]:
        print("\n".join(TESTS))
        sys.exit(0)
    name = sys.argv[1]
    faulthandler.dump_traceback_later(100, exit=True)  # a hung test fails with every thread's stack, it never hangs the suite
    if name not in ("fence_boundaries", "secret_in_a_prompt_is_refused_by_the_meter") and not chrome():
        print("NO CHROMIUM FOUND", file=sys.stderr)
        sys.exit(77)
    TESTS[name]()
    print("PASS", name)
