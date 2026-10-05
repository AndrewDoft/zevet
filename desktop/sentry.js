// Error reporting: one module owning what goes to Sentry and what never does.
//
// Every capture in this app funnels through here rather than calling
// `@sentry/electron` directly at the call site, for one reason: privacy
// scrubbing and tagging must be the SAME rule everywhere, and "the same rule"
// only holds if there is one place it is written. Andrew's own credentials
// (a personal Anthropic key, an oauth token, a stray path under his home
// directory) must never reach Sentry's servers even by accident, from any of
// main, preload, or an agent's stderr.
//
// DEPENDENCY INJECTION, same reasoning as credential-usage.js's `fetchImpl`:
// a real Sentry client talks to the network and requires Electron's `app` to
// exist, so a test suite that wants to prove the SCRUBBING rule and the
// AGENT-FAILURE shape correct, without either of those, injects a fake
// recorder instead. `require("@sentry/electron/main")` only ever happens at
// the caller (main.js, preload.js) — this file never imports it, so it stays
// importable and testable under plain `node --test`.
"use strict";

const os = require("node:os");

const DSN = "https://bddea6442d55e332f6937eae0fc8e8a4@o4512166977339392.ingest.us.sentry.io/4512166992216064";

/** `zevet@0.2.85`, so Sentry groups issues by release rather than lumping
 *  every version's crashes into one bucket. */
function releaseName(version) {
  return `zevet@${version}`;
}

/**
 * Every pattern is applied to every string in an event, independent of where
 * it appears -- a leaked key does not announce which field it is in, and
 * scrubbing by field name would miss one that ended up in a message or a
 * stack frame's context line instead of the field it usually lives in.
 */
const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{10,}/g, "[redacted:sk]"],
  [/ghp_[A-Za-z0-9]{20,}/g, "[redacted:ghp]"],
  [/gho_[A-Za-z0-9]{20,}/g, "[redacted:gho]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted:github_pat]"],
  [/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]"],
  // A key/token/secret assigned a long opaque value anywhere in free text —
  // env dumps, error messages that echo a header, a pasted curl command.
  // Only the value is dropped; the field name survives, which is the part
  // worth keeping for diagnosis.
  [
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?token|client[_-]?secret)\s*[:=]\s*"?)([A-Za-z0-9._-]{12,})/gi,
    "$1[redacted]",
  ],
];

/**
 * `str` with every known secret shape and this machine's home directory
 * scrubbed. The home directory goes first and as a literal substring, not a
 * regex: a real path can contain characters (spaces, parentheses on
 * Windows) that would need escaping to use safely as a pattern, and a
 * literal match is exactly what is wanted here — this exact string, nothing
 * it merely resembles.
 */
function scrubText(str, home = os.homedir()) {
  if (typeof str !== "string" || !str) return str;
  let out = str;
  if (home) {
    // Both slash directions: a path can arrive normalized either way (a
    // stack frame from Node vs. one quoted inside a shell command).
    for (const h of new Set([home, home.replace(/\\/g, "/")])) {
      if (h) out = out.split(h).join("~");
    }
  }
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauth) out = out.split(oauth).join("[redacted:oauth]");
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Deep-walk anything JSON-shaped (a Sentry event is exactly that by the time
 *  beforeSend sees it), scrubbing every string leaf. Never mutates `value`. */
function deepScrub(value, home) {
  if (typeof value === "string") return scrubText(value, home);
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, home));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepScrub(v, home);
    return out;
  }
  return value;
}

/**
 * The `beforeSend` hook: scrubs the whole event, and drops the two fields
 * that would carry PII even with `sendDefaultPii: false` set (an IP address
 * attached by something upstream of this hook, and cookies on a captured
 * request) -- belt and braces, since `sendDefaultPii` governs what the SDK
 * itself attaches, not what a raw HTTP context object might already hold.
 */
function beforeSend(event) {
  const scrubbed = deepScrub(event);
  if (scrubbed.user) delete scrubbed.user.ip_address;
  if (scrubbed.request) {
    delete scrubbed.request.cookies;
    if (scrubbed.request.headers) delete scrubbed.request.headers.cookie;
  }
  return scrubbed;
}

/**
 * Wires `sentryMain.init` (the real call is `@sentry/electron/main`'s,
 * injected by the caller) with the privacy posture every event must carry:
 * no default PII, this app's own scrubbing, and the tags that make an event
 * attributable to a release, a platform and a teammate.
 */
function initMain({ sentryMain, dsn = DSN, release, tags = {}, environment } = {}) {
  sentryMain.init({
    dsn,
    release,
    environment,
    sendDefaultPii: false,
    beforeSend,
    initialScope: (scope) => {
      scope.setTags(tags);
      return scope;
    },
  });
  return sentryMain;
}

/** The last `n` lines of `text` ("" for none), joined back with newlines. */
function lastLines(text, n = 40) {
  const lines = String(text || "").split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

/**
 * An agent/provider run that ended in an error or a nonzero exit, and is NOT
 * a JS exception -- codex's "provider error 400" and friends. `argv` is the
 * invocation zevet built (agent-console.js's own `invocationFor`, same
 * options); it never contains the prompt, which never reaches argv in the
 * first place (see agent-console.js's own security posture note). `stderr`
 * is truncated here, not by the caller, so every call site gets the same cap
 * without having to remember it.
 */
function captureAgentFailure(sentryMain, { agent, model, argv, code, stderr, message } = {}) {
  const text = message || `${agent || "agent"} exited ${code === null || code === undefined ? "(no code)" : code}`;
  return sentryMain.captureMessage(text, {
    level: "error",
    tags: { agent: String(agent || ""), kind: "agent_failure" },
    extra: {
      model: typeof model === "string" ? model : "",
      argv: Array.isArray(argv) ? argv : [],
      code: code === undefined ? null : code,
      stderrTail: lastLines(stderr, 40),
    },
  });
}

const OFFLINE = /^(fetch failed|the operation was aborted|this operation was aborted|.*\b(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b)/i;

/** An auto-update failure: a download, signature check, or install step that
 *  threw or reported an error. */
function captureUpdateFailure(sentryMain, { stage, error } = {}) {
  const text = String(error && error.message ? error.message : error);
  // Being offline (undici's "fetch failed", a timed-out check) is not an outage: a warning, one group.
  if (OFFLINE.test(text)) {
    return sentryMain.captureMessage(`auto-update failed: ${text}`, {
      level: "warning",
      tags: { kind: "update_failure", stage: String(stage || ""), "update.offline": "true" },
      fingerprint: ["auto-update", "offline"],
    });
  }
  const err = error instanceof Error ? error : new Error(String(error && error.message ? error.message : error));
  return sentryMain.captureException(err, { tags: { kind: "update_failure", stage: String(stage || "") } });
}

/** ZEVET_SENTRY_TEST=1 verification: one deliberate event, unmistakable in
 *  the Sentry project as a test rather than a real failure. */
function sendTestMessage(sentryMain) {
  return sentryMain.captureMessage("zevet sentry test");
}

/**
 * Wraps agent-console.js's `startConsole` so every caller — Code's launches
 * and Chat's, claude/codex/opencode alike — reports a failed run without
 * each call site having to remember to. One wrapper, applied once where
 * `agentConsole` is required, rather than duplicated at every launch site
 * (desktop/main.js has five of them).
 *
 * "Failed" is an exit that was neither a clean 0 nor a stop this app asked
 * for (`evt.stopped`, set by `startConsole`'s own `stop()` — a person
 * closing a console is not a bug report). stderr is accumulated per run from
 * the `stderr` events startConsole already emits, and handed to
 * `captureAgentFailure` untouched — it is diagnostics text the CLI itself
 * printed, never a prompt or a file's contents.
 */
function withAgentFailureCapture(startConsoleFn, { sentryMain, invocationFor } = {}) {
  return function instrumentedStartConsole(opts) {
    const o = opts || {};
    const stderrChunks = [];
    const userOnEvent = typeof o.onEvent === "function" ? o.onEvent : () => {};
    let argv;
    try {
      argv = invocationFor ? invocationFor(o.agent, o) : undefined;
    } catch {
      argv = undefined; // best-effort context; never blocks the actual launch
    }
    return startConsoleFn({
      ...o,
      onEvent(evt) {
        if (evt && evt.type === "stderr" && typeof evt.text === "string") {
          stderrChunks.push(evt.text);
        }
        if (evt && evt.type === "exit" && !evt.stopped && (evt.error || (evt.code !== 0 && evt.code !== null))) {
          captureAgentFailure(sentryMain, {
            agent: o.agent,
            model: o.model,
            argv,
            code: evt.code,
            stderr: stderrChunks.join(""),
            message: evt.error ? `${o.agent} failed to start: ${evt.error}` : undefined,
          });
        }
        userOnEvent(evt);
      },
    });
  };
}

module.exports = {
  DSN,
  releaseName,
  SECRET_PATTERNS,
  scrubText,
  deepScrub,
  beforeSend,
  initMain,
  lastLines,
  captureAgentFailure,
  captureUpdateFailure,
  sendTestMessage,
  withAgentFailureCapture,
};
