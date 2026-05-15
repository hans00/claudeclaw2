---
description: Start the ClaudeClaw v2 daemon for this project
---

Start the daemon. Follow these steps:

1. **Block home-directory starts (CRITICAL)**: Run `pwd` and `echo "$HOME"`. If `pwd` equals `$HOME`, STOP and tell the user to `cd` into a project directory.

2. **Check for an existing daemon**:
   ```bash
   if [ -f .claude/claudeclaw/daemon.pid ]; then
     pid=$(cat .claude/claudeclaw/daemon.pid)
     if kill -0 "$pid" 2>/dev/null; then
       echo "already running (pid $pid)"; exit 0
     fi
     rm .claude/claudeclaw/daemon.pid
   fi
   ```
   If a daemon is already running, just report `(pid X) already running` and stop.

3. **Run the launcher**. Prefer the project's `start.sh` if it exists (it bakes in the right paths). Otherwise:
   ```bash
   mkdir -p .claude/claudeclaw/logs
   nohup bun run ${CLAUDE_PLUGIN_ROOT}/src/daemon.ts \
     > .claude/claudeclaw/logs/daemon.log 2>&1 &
   ```

4. **Smoke test** after ~6 seconds:
   ```bash
   sleep 6
   tail -n 30 .claude/claudeclaw/logs/daemon.log
   ```
   Confirm you see `[daemon] ready (project=...)`. Report the pid from `.claude/claudeclaw/daemon.pid`.

5. If anything looks wrong (missing settings.json, port already in use, claude not on PATH), surface the relevant log lines and propose a fix instead of declaring success.
