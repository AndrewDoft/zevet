#!/usr/bin/env bash
# The gate. Green here is the only thing that licenses a commit or a deploy.
#
# It exists because twice in one session a red suite was committed and shipped:
# the run was `npm test | grep ...`, and a pipeline's exit status is the LAST
# command's, so grep's cheerful 0 hid a failing suite both times. Nothing here
# pipes the runner. Its exit code is taken directly and is the gate's own.
set -uo pipefail
cd "$(dirname "$0")/.."

echo "== zevet gate =="
node --version

# tee, not a pipe, so the status below belongs to node and not to a reader.
# editor/test is a SECOND glob, not part of the first: the editor lives outside
# test/ because it has its own package.json and its own (build-time only)
# node_modules, and `test/**` does not reach it. Without this second pattern the
# committed bundle at hub/public/editor.js would be the one thing in the
# repository that nothing checks — and it is the one thing that cannot be
# checked by reading a diff, because it is 800 KiB of minified output.
#
# The editor tests need NO npm install: they read the committed bundle and
# import editor/src/language.js, which imports nothing. A fresh clone runs them.
#
# scripts/run-tests.mjs, not a raw `node --test`: it is the one place that
# reads the "cancelled" line node's own summary keeps separate from "fail" —
# a hook that threw before its tests ran (a missing Electron build is the
# common cause) — and fails loudly on it. Same npm-test entry point CI uses.
node scripts/run-tests.mjs 2>&1 | tee /tmp/zevet-gate.log
status=${PIPESTATUS[0]}

echo
grep -E "^(ℹ|#) (tests|pass|fail|cancelled|skipped|todo) " /tmp/zevet-gate.log | tail -6

if [ "$status" -ne 0 ]; then
  echo
  echo "GATE RED (test run exited $status) — do not commit, do not deploy."
  sed -n '/^✖ failing tests:/,$p' /tmp/zevet-gate.log | head -40
  exit 1
fi

# A suite that ran zero tests exits 0. That is not green, it is empty.
count=$(grep -E "^(ℹ|#) tests " /tmp/zevet-gate.log | tail -1 | tr -dc '0-9')
if [ -z "$count" ] || [ "$count" -lt 1 ]; then
  echo "GATE RED — the runner reported no tests at all."
  exit 1
fi

echo "GATE GREEN — $count tests."
