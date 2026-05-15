---
description: Stop the ClaudeClaw v2 daemon
---

Stop the running daemon:

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/cli.ts stop
```

Report the output. If you see `no pid file`, the daemon wasn't running.

Note: tmux sessions intentionally outlive the daemon so conversation context survives restarts. To clean those up too:

```bash
tmux ls | grep claudeclaw- | cut -d: -f1 | xargs -r -n1 tmux kill-session -t
```

Only do that if the user explicitly asks — it wipes the agent state for every channel.
