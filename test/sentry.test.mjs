// desktop/sentry.js: privacy scrubbing and the agent-failure capture path.
//
// No real @sentry/electron here on purpose — this module never imports it
// (see its own header comment), so every test drives it with a fake
// recorder standing in for the real client, the same DI shape
// credential-usage.js uses for `fetchImpl`.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sentry = require(path.join(ROOT, "desktop", "sentry.js"));

test("stuck payload capture sends only update diagnostics through the existing Sentry path", () => {
  const s = fakeSentry();
  const details = { channel: "stable", high_seq: 2131, running_build: "0.2.131", stable_build: "0.2.139", last_status: { status: "none" }, secret: "must-not-be-sent" };
  assert.equal(sentry.capturePayloadStuck(s, details), "fake-event-id");
  assert.equal(s.calls.captureMessage.length, 1);
  const { message, opts } = s.calls.captureMessage[0];
  assert.match(message, /24 hours/);
  assert.equal(opts.tags.kind, "payload_stuck");
  assert.deepEqual(opts.extra, { channel: "stable", high_seq: 2131, running_build: "0.2.131", stable_build: "0.2.139", last_status: { status: "none" } });
  assert.deepEqual(opts.fingerprint, ["payload-update-stuck"]);
});

function fakeSentry() {
  const calls = { captureMessage: [], captureException: [] };
  return {
    calls,
    captureMessage: (message, opts) => {
      calls.captureMessage.push({ message, opts });
      return "fake-event-id";
    },
    captureException: (err, opts) => {
      calls.captureException.push({ err, opts });
      return "fake-event-id";
    },
  };
}

describe("scrubText: known secret shapes never survive", () => {
  test("provider key prefixes are redacted", () => {
    assert.equal(sentry.scrubText("key is sk-abcdefghij1234"), "key is [redacted:sk]");
    assert.equal(sentry.scrubText("token ghp_ABCDEFGHIJ0123456789"), "token [redacted:ghp]");
    assert.equal(sentry.scrubText("token gho_ABCDEFGHIJ0123456789"), "token [redacted:gho]");
    assert.equal(sentry.scrubText("token github_pat_ABCDEFGHIJ0123456789KLMN"), "token [redacted:github_pat]");
  });

  test("a Bearer header is redacted, keeping the scheme word", () => {
    assert.equal(sentry.scrubText("authorization: Bearer abc.def-123_XYZ"), "authorization: Bearer [redacted]");
  });

  test("a key/token/secret assignment loses only its value", () => {
    assert.equal(sentry.scrubText('api_key: "aaaaaaaaaaaaaaaaaaaa"'), 'api_key: "[redacted]"');
    assert.equal(sentry.scrubText("oauth_token=bbbbbbbbbbbbbbbbbbbb"), "oauth_token=[redacted]");
  });

  test("CLAUDE_CODE_OAUTH_TOKEN's literal value is scrubbed even with no known shape", () => {
    const before = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "totally-unshaped-secret-value";
    try {
      assert.equal(
        sentry.scrubText("engine2 token: totally-unshaped-secret-value in argv"),
        "engine2 token: [redacted:oauth] in argv",
      );
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = before;
    }
  });

  test("the home directory becomes ~, both slash directions", () => {
    const home = "C:\\Users\\andre";
    assert.equal(sentry.scrubText("at C:\\Users\\andre\\repo\\file.js:1:1", home), "at ~\\repo\\file.js:1:1");
    assert.equal(sentry.scrubText("at C:/Users/andre/repo/file.js", home), "at ~/repo/file.js");
  });

  test("ordinary text is untouched", () => {
    assert.equal(sentry.scrubText("hello world"), "hello world");
  });

  test("non-string input passes through", () => {
    assert.equal(sentry.scrubText(42), 42);
    assert.equal(sentry.scrubText(null), null);
    assert.equal(sentry.scrubText(undefined), undefined);
  });
});

describe("deepScrub walks the whole event", () => {
  test("nested strings in objects and arrays are scrubbed; other types survive", () => {
    const home = "/Users/andre";
    const input = {
      message: "sk-aaaaaaaaaa1234 leaked at /Users/andre/x.js",
      count: 3,
      ok: true,
      frames: [{ text: "Bearer aaaaaaaaaaaaaaaa" }, { text: "fine" }],
      nested: { deeper: { still: "gho_aaaaaaaaaaaaaaaaaaaaa" } },
    };
    const out = sentry.deepScrub(input, home);
    assert.equal(out.message, "[redacted:sk] leaked at ~/x.js");
    assert.equal(out.count, 3);
    assert.equal(out.ok, true);
    assert.equal(out.frames[0].text, "Bearer [redacted]");
    assert.equal(out.frames[1].text, "fine");
    assert.equal(out.nested.deeper.still, "[redacted:gho]");
    // the input is not mutated
    assert.equal(input.message.startsWith("sk-"), true);
  });
});

describe("beforeSend", () => {
  test("scrubs message text and strips IP and cookies", () => {
    const event = {
      message: "failed for ghp_AAAAAAAAAAAAAAAAAAAA",
      user: { id: "u1", ip_address: "1.2.3.4" },
      request: { cookies: "session=x", headers: { cookie: "session=x", accept: "json" } },
    };
    const out = sentry.beforeSend(event);
    assert.equal(out.message, "failed for [redacted:ghp]");
    assert.equal(out.user.ip_address, undefined);
    assert.equal(out.user.id, "u1", "non-PII fields survive");
    assert.equal(out.request.cookies, undefined);
    assert.equal(out.request.headers.cookie, undefined);
    assert.equal(out.request.headers.accept, "json", "non-cookie headers survive");
  });
});

describe("lastLines", () => {
  test("keeps only the tail", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n");
    const out = sentry.lastLines(text, 40);
    assert.equal(out.split("\n").length, 40);
    assert.equal(out.split("\n")[0], "line10");
    assert.equal(out.split("\n").at(-1), "line49");
  });

  test("fewer lines than the cap is returned whole", () => {
    assert.equal(sentry.lastLines("a\nb", 40), "a\nb");
  });

  test("empty input is empty output, not a crash", () => {
    assert.equal(sentry.lastLines(""), "");
    assert.equal(sentry.lastLines(undefined), "");
  });
});

describe("releaseName", () => {
  test("zevet@<version>", () => {
    assert.equal(sentry.releaseName("0.2.85"), "zevet@0.2.85");
  });
});

describe("captureAgentFailure", () => {
  test("reports the agent, model, argv and a truncated stderr tail", () => {
    const s = fakeSentry();
    const stderr = Array.from({ length: 50 }, (_, i) => `err${i}`).join("\n");
    sentry.captureAgentFailure(s, { agent: "codex", model: "gpt-6-astra", argv: ["exec", "-m", "gpt-6-astra", "-"], code: 1, stderr });
    assert.equal(s.calls.captureMessage.length, 1);
    const { message, opts } = s.calls.captureMessage[0];
    assert.match(message, /codex/);
    assert.equal(opts.level, "error");
    assert.deepEqual(opts.tags, { agent: "codex", kind: "agent_failure" });
    assert.equal(opts.extra.model, "gpt-6-astra");
    assert.deepEqual(opts.extra.argv, ["exec", "-m", "gpt-6-astra", "-"]);
    assert.equal(opts.extra.code, 1);
    assert.equal(opts.extra.stderrTail.split("\n").length, 40, "stderr must be capped to 40 lines");
    assert.equal(opts.extra.stderrTail.split("\n")[0], "err10");
  });

  test("a custom message overrides the generated one", () => {
    const s = fakeSentry();
    sentry.captureAgentFailure(s, { agent: "codex", message: "codex failed to start: ENOENT" });
    assert.equal(s.calls.captureMessage[0].message, "codex failed to start: ENOENT");
  });

  test("missing argv/model/stderr do not throw", () => {
    const s = fakeSentry();
    assert.doesNotThrow(() => sentry.captureAgentFailure(s, { agent: "opencode", code: 1 }));
    assert.deepEqual(s.calls.captureMessage[0].opts.extra.argv, []);
    assert.equal(s.calls.captureMessage[0].opts.extra.model, "");
  });
});

describe("captureUpdateFailure", () => {
  test("wraps a non-Error into one and tags the stage", () => {
    const s = fakeSentry();
    sentry.captureUpdateFailure(s, { stage: "download", error: "network reset" });
    assert.equal(s.calls.captureException.length, 1);
    const { err, opts } = s.calls.captureException[0];
    assert.ok(err instanceof Error);
    assert.match(err.message, /network reset/);
    assert.deepEqual(opts.tags, { kind: "update_failure", stage: "download" });
  });

  test("offline is a warning message, not an exception", () => {
    for (const msg of ["fetch failed", "This operation was aborted", "getaddrinfo ENOTFOUND usemasora.com"]) {
      const s = fakeSentry();
      sentry.captureUpdateFailure(s, { stage: "auto-update", error: msg });
      assert.equal(s.calls.captureException.length, 0, msg);
      assert.equal(s.calls.captureMessage[0].opts.level, "warning");
      assert.deepEqual(s.calls.captureMessage[0].opts.fingerprint, ["auto-update", "offline"]);
    }
  });

  test("real failures stay exceptions", () => {
    for (const msg of ["the feed is not validly signed: bad signature", "sha256 mismatch for zevet-0.2.90.exe"]) {
      const s = fakeSentry();
      sentry.captureUpdateFailure(s, { stage: "auto-update", error: msg });
      assert.equal(s.calls.captureMessage.length, 0, msg);
      assert.equal(s.calls.captureException.length, 1, msg);
    }
  });

  test("a real Error is passed through as-is", () => {
    const s = fakeSentry();
    const real = new Error("boom");
    sentry.captureUpdateFailure(s, { stage: "install", error: real });
    assert.equal(s.calls.captureException[0].err, real);
  });
});

describe("sendTestMessage", () => {
  test("sends the exact verification string", () => {
    const s = fakeSentry();
    sentry.sendTestMessage(s);
    assert.equal(s.calls.captureMessage[0].message, "zevet sentry test");
  });
});

describe("withAgentFailureCapture", () => {
  /** A fake startConsole: records the opts it was called with and lets the
   *  test drive `onEvent` directly, exactly like a real console would. */
  function fakeStartConsole() {
    let seenOpts;
    return {
      fn: (opts) => {
        seenOpts = opts;
        return { ok: true, id: "c1" };
      },
      opts: () => seenOpts,
    };
  }

  test("a clean exit (code 0) is not reported", () => {
    const s = fakeSentry();
    const fake = fakeStartConsole();
    const wrapped = sentry.withAgentFailureCapture(fake.fn, { sentryMain: s, invocationFor: () => ["exec", "-"] });
    const events = [];
    wrapped({ agent: "codex", model: "m", onEvent: (e) => events.push(e) });
    fake.opts().onEvent({ type: "exit", code: 0 });
    assert.equal(s.calls.captureMessage.length, 0);
    assert.deepEqual(events, [{ type: "exit", code: 0 }], "the caller's own onEvent must still see every event");
  });

  test("a stop the app asked for is not reported, even with a nonzero code", () => {
    const s = fakeSentry();
    const fake = fakeStartConsole();
    const wrapped = sentry.withAgentFailureCapture(fake.fn, { sentryMain: s, invocationFor: () => [] });
    wrapped({ agent: "codex", onEvent: () => {} });
    fake.opts().onEvent({ type: "exit", code: 1, stopped: true });
    assert.equal(s.calls.captureMessage.length, 0);
  });

  test("a nonzero exit is reported with accumulated stderr and the built argv", () => {
    const s = fakeSentry();
    const fake = fakeStartConsole();
    const wrapped = sentry.withAgentFailureCapture(fake.fn, {
      sentryMain: s,
      invocationFor: (agent, o) => ["exec", "-m", o.model, "-"],
    });
    wrapped({ agent: "codex", model: "gpt-6-astra", onEvent: () => {} });
    const onEvent = fake.opts().onEvent;
    onEvent({ type: "stderr", text: "stream error: provider error 400\n" });
    onEvent({ type: "exit", code: 1 });
    assert.equal(s.calls.captureMessage.length, 1);
    const { opts } = s.calls.captureMessage[0];
    assert.deepEqual(opts.extra.argv, ["exec", "-m", "gpt-6-astra", "-"]);
    assert.match(opts.extra.stderrTail, /provider error 400/);
    assert.equal(opts.extra.code, 1);
  });

  test("a spawn that never started (evt.error, code null) is reported as a start failure", () => {
    const s = fakeSentry();
    const fake = fakeStartConsole();
    const wrapped = sentry.withAgentFailureCapture(fake.fn, { sentryMain: s, invocationFor: () => [] });
    wrapped({ agent: "opencode", onEvent: () => {} });
    fake.opts().onEvent({ type: "exit", code: null, error: "ENOENT" });
    assert.equal(s.calls.captureMessage.length, 1);
    assert.match(s.calls.captureMessage[0].message, /opencode failed to start: ENOENT/);
  });

  test("invocationFor throwing does not break the launch or lose the failure report", () => {
    const s = fakeSentry();
    const fake = fakeStartConsole();
    const wrapped = sentry.withAgentFailureCapture(fake.fn, {
      sentryMain: s,
      invocationFor: () => {
        throw new Error("should never reach the real launch");
      },
    });
    const result = wrapped({ agent: "codex", onEvent: () => {} });
    assert.equal(result.ok, true, "the console must still start");
    fake.opts().onEvent({ type: "exit", code: 1 });
    assert.equal(s.calls.captureMessage.length, 1);
    assert.deepEqual(s.calls.captureMessage[0].opts.extra.argv, []);
  });

  test("no onEvent supplied by the caller does not throw", () => {
    const s = fakeSentry();
    const fake = fakeStartConsole();
    const wrapped = sentry.withAgentFailureCapture(fake.fn, { sentryMain: s, invocationFor: () => [] });
    wrapped({ agent: "codex" });
    assert.doesNotThrow(() => fake.opts().onEvent({ type: "exit", code: 1 }));
  });
});
