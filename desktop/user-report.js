// A problem report the person chose to send: what they typed plus the tail of the app log,
// as one Sentry event tagged source:user-report. Electron-free so node --test can run it.
// Redaction is sentry.js's scrubText, applied here too so the payload is clean before it is handed over.
"use strict";

const fs = require("node:fs");
const { scrubText, lastLines } = require("./sentry.js");

const MAX_TEXT = 2000;
const LOG_LINES = 200;
const MAX_LINE = 400;

/** Bounded read of a file's end (never loads a whole log). */
function readTail(file, maxBytes = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } catch (err) {
    return `[unavailable: ${err.code || err.message}]`;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function build({ text, version = "", log = "", home } = {}) {
  const t = scrubText(String(text || "").trim(), home).slice(0, MAX_TEXT);
  if (!t) return null;
  const tail = lastLines(log, LOG_LINES)
    .split("\n")
    .map((l) => scrubText(l, home).slice(0, MAX_LINE))
    .join("\n");
  return {
    message: `user report: ${t.split("\n")[0].slice(0, 120)}`,
    level: "error",
    tags: { source: "user-report" },
    extra: { report: t, version: String(version), logTail: tail },
  };
}

/** Sends the report; `{ ok: false }` when there was nothing to send. */
function send(sentryMain, input) {
  const r = build(input);
  if (!r) return { ok: false };
  const { message, ...opts } = r;
  sentryMain.captureMessage(message, opts);
  return { ok: true };
}

module.exports = { build, send, readTail, MAX_TEXT, LOG_LINES, MAX_LINE };
