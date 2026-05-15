---
description: List active ClaudeClaw channels and their state
---

Report each channel in `.claude/claudeclaw/sessions.json`. Prefer the live API if the daemon is up; fall back to the file otherwise.

## Live

```bash
curl -s http://127.0.0.1:4632/api/sessions
```

(Use the port from `settings.json` `web.port` if different from 4632.)

## File-only fallback

```bash
cat .claude/claudeclaw/sessions.json
```

For each entry, show:
- channelKey
- kind (global / discord / slack / line)
- multiparty flag
- sessionId (first 8 chars)
- state (idle / running / cold)
- lastActivityAt (formatted as relative time)

Group by kind and sort by lastActivityAt desc.

Also check tmux:
```bash
tmux ls 2>/dev/null | grep '^claudeclaw-'
```
Mismatches between sessions.json entries and live tmux sessions are worth flagging.
