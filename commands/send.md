---
description: Send a real platform message to a target chat/channel + echo to the owning session's inbox
---

Deliver a real message via the target platform's API. The text shows up on the other side immediately (Telegram notification, Discord post, etc.). The session that owns inbound traffic from that target also gets an inbox echo so on its next turn it sees "you sent X earlier".

If you want a peer agent to think and respond rather than delivering verbatim text, use `/claudeclaw2:trigger` instead.

## Args

Parse `$ARGUMENTS` as `<target> <message...>`.

Valid `<target>`:
- `telegram:<chatId>` — DM chatIds are positive (echo lands on `global`); group chatIds are negative (echo lands on `telegram:<chatId>`)
- `discord:<channelId>`
- `slack:<channelId>[:<threadTs>]` (echo drops the thread suffix — inbox is per-channel)
- `line:<sourceId>`
- `global` — **rejected**; pick a specific platform target

## Call

```bash
port=$(jq -r '.web.port // 4632' .claude/claudeclaw/settings.json 2>/dev/null || echo 4632)
curl -s -X POST "http://127.0.0.1:${port}/api/send" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg t '<target>' --arg m '<message>' \
        '{target:$t, text:$m, fromLabel:"cli"}')"
```

Use `jq -Rs .` to safely JSON-escape multi-line messages.

Response: `{ ok: true, target, inboxOwner }`. `inboxOwner` tells you which session received the echo.

## Rules

- This sends a real message — humans see it immediately. Confirm sensitive content before sending.
- Never send tokens/secrets through this path.
- The inbox echo means the originating session will see "you sent X" next turn — that's intentional, so the session doesn't get confused about traffic it generated.
