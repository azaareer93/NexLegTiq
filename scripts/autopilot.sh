#!/usr/bin/env bash
# Runs `/autopilot --once` in a fresh headless Claude Code session per iteration (fresh context every ticket), until
# .git/nexlegtiq/autopilot-stop exists. A run that fails — usage limit reached, crash, network — waits and retries, so the
# loop resumes by itself once the limit resets. Extra arguments go to `claude` (e.g. the permission mode you run it with).
#
#   scripts/autopilot.sh --permission-mode acceptEdits      # start (in its own terminal)
#   touch .git/nexlegtiq/autopilot-stop                       # stop after the current iteration
#   tail -f .git/nexlegtiq/autopilot.log                      # watch
set -u
cd "$(git rev-parse --show-toplevel)" || exit 1
state=.git/nexlegtiq
stop="$state/autopilot-stop"
log="$state/autopilot.log"
retry=${AUTOPILOT_RETRY_SECONDS:-900} # after a failed run (usage limit, error)
idle=${AUTOPILOT_IDLE_SECONDS:-1800}  # nothing eligible, or waiting for reviews
pause=${AUTOPILOT_PAUSE_SECONDS:-30}  # between successful iterations
mkdir -p "$state"
rm -f "$stop"

while [ ! -e "$stop" ]; do
  out=$(claude -p "/autopilot --once" "$@" 2>&1)
  status=$?
  printf '%s\n' "$out" >>"$state/autopilot-runs.log"
  last=$(printf '%s\n' "$out" | grep -E '^(DONE|SKIPPED|FIXED|IDLE)' | tail -n 1)
  if [ $status -ne 0 ] || [ -z "$last" ]; then
    echo "$(date -Iseconds) RETRY exit=$status (usage limit or error); next try in ${retry}s" >>"$log"
    sleep "$retry"
  elif [ "${last%%:*}" = "IDLE" ]; then
    sleep "$idle"
  else
    sleep "$pause"
  fi
done
echo "$(date -Iseconds) STOPPED by $stop" >>"$log"
