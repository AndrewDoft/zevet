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
node --test "test/**/*.test.mjs" 2>&1 | tee /tmp/zevet-gate.log
status=${PIPESTATUS[0]}

echo
grep -E "^ℹ (tests|pass|fail|skipped|todo) " /tmp/zevet-gate.log | tail -5

if [ "$status" -ne 0 ]; then
  echo
  echo "GATE RED (node --test exited $status) — do not commit, do not deploy."
  sed -n '/^✖ failing tests:/,$p' /tmp/zevet-gate.log | head -40
  exit 1
fi

# A suite that ran zero tests exits 0. That is not green, it is empty.
count=$(grep -E "^ℹ tests " /tmp/zevet-gate.log | tail -1 | tr -dc '0-9')
if [ -z "$count" ] || [ "$count" -lt 1 ]; then
  echo "GATE RED — the runner reported no tests at all."
  exit 1
fi

echo "GATE GREEN — $count tests."
