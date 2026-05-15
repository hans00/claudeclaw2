---
description: Show ClaudeClaw daemon status, sessions, and upcoming scheduled jobs
---

Report current daemon state. Do all of the following and summarize at the end:

1. **Daemon process**:
   ```bash
   pid=$(cat .claude/claudeclaw/daemon.pid 2>/dev/null)
   if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "running pid=$pid"; else echo "stopped"; fi
   ```

2. **Web API** (if reachable — use port from `.claude/claudeclaw/settings.json` `web.port`, default 4632):
   ```bash
   curl -s http://127.0.0.1:4632/api/status
   curl -s http://127.0.0.1:4632/api/sessions
   ```
   Pretty-print the JSON.

3. **State snapshot** (`.claude/claudeclaw/state.json`): show heartbeat next-fire countdown and each job's next-fire time. Compute the deltas from current time.

4. **tmux sessions**:
   ```bash
   tmux ls 2>/dev/null | grep '^claudeclaw-'
   ```

5. **Recent log tail**:
   ```bash
   tail -n 20 .claude/claudeclaw/logs/daemon.log
   ```

Format clearly — group by daemon / sessions / jobs / logs. Flag anything that looks unhealthy (pid file present but process gone, log lines containing "ERROR" or "fatal", etc).
