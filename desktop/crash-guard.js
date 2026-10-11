"use strict";

/**
 * No uncaught error may reach Electron's default "A JavaScript error occurred in the main process" dialog: it is a
 * modal on a person's desktop for something they cannot act on. Masora showed one (2026-10-11) for `write EPIPE`
 * from console.error after the stdio pipe closed.
 *
 *   - stdout/stderr 'error' events (EPIPE and friends) are swallowed: a closed pipe loses a log line, nothing else.
 *     The file logs are what carry the record.
 *   - uncaughtException / unhandledRejection are written to the log and the process carries on. A trial payload's
 *     own crash guard (bootstrap.js) is a second listener and still fails the boot on one.
 *
 * Shell code (loaded by the asar entry), so a payload cannot change it. Everything is injected for the test.
 */

const PIPE_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED", "EIO", "ECONNRESET"]);
const isPipeError = (err) => Boolean(err && PIPE_CODES.has(err.code));

function installCrashGuard({ proc = process, log, streams } = {}) {
  const write = typeof log === "function" ? log : () => {};
  const safe = (msg) => { try { write(msg); } catch { /* the guard must not throw */ } };
  let pipeNoted = false;
  const zevetGuardStream = (err) => {
    if (isPipeError(err)) {
      if (!pipeNoted) { pipeNoted = true; safe(`stdio pipe closed (${err.code}); console output is now dropped`); }
      return;
    }
    safe(`stdio error: ${err && err.stack || err}`);
  };
  const zevetGuardUncaught = (err) => {
    if (isPipeError(err)) return zevetGuardStream(err);
    safe(`uncaughtException: ${err && err.stack || err}`);
  };
  const zevetGuardRejection = (reason) => safe(`unhandledRejection: ${reason && reason.stack || reason}`);

  let list = streams;
  if (!list) {
    // Touching process.stdout can itself throw where there is no console at all.
    list = [];
    for (const name of ["stdout", "stderr"]) { try { list.push(proc[name]); } catch { /* no such stream */ } }
  }
  const attached = list.filter((s) => s && typeof s.on === "function");
  for (const s of attached) s.on("error", zevetGuardStream);
  proc.on("uncaughtException", zevetGuardUncaught);
  proc.on("unhandledRejection", zevetGuardRejection);
  return function uninstall() {
    for (const s of attached) s.removeListener("error", zevetGuardStream);
    proc.removeListener("uncaughtException", zevetGuardUncaught);
    proc.removeListener("unhandledRejection", zevetGuardRejection);
  };
}

module.exports = { installCrashGuard, isPipeError };
