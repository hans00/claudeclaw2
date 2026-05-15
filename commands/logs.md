---
description: Show recent daemon log lines
---

Show the daemon log:

```bash
tail -n 80 .claude/claudeclaw/logs/daemon.log
```

If `$ARGUMENTS` is non-empty, treat it as a number of lines to tail instead of 80, capped at 5000.

Highlight any line containing `ERROR`, `failed`, `fatal`, or `init-watch timed out` so the user sees them clearly. If everything looks healthy, say so explicitly.
