#!/usr/bin/env bash
# Supervisor wrapper for ClaudeClaw v2 daemon.
# Exit code 75 (EX_TEMPFAIL) from the daemon means "restart requested" —
# any other non-zero code causes a 2-second delay before restart.
# Exit code 0 means a clean stop; the loop exits.
#
# Usage: ./scripts/run-daemon.sh [project-dir]
#   project-dir defaults to $PWD

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_SCRIPT="$SCRIPT_DIR/../src/daemon.ts"
PROJECT_DIR="${1:-$(pwd)}"

cd "$PROJECT_DIR"
echo "[supervisor] starting daemon (project=$PROJECT_DIR)"

while true; do
  bun "$DAEMON_SCRIPT" && code=0 || code=$?
  if [ "$code" -eq 0 ]; then
    echo "[supervisor] daemon exited cleanly — stopping"
    break
  elif [ "$code" -eq 75 ]; then
    echo "[supervisor] daemon requested restart (exit 75) — restarting…"
  else
    echo "[supervisor] daemon exited with code $code — restarting in 2s…"
    sleep 2
  fi
done
