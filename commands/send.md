---
description: Deliver a plain-text notification into another channel's inbox (one-way)
---

Post a one-way notification to a cross-session target via the daemon's `/api/send` endpoint. The receiving channel's inbox is drained the next time it processes a real user message — so this is "drop a note for them" not "have them respond now".

If you want the target to actually process the message as a prompt and respond, use `/claudeclaw2:trigger` instead.

## Args

Parse `$ARGUMENTS` as `<target> <message...>`.

`<target>` grammar:
- `global` — the cross-platform DM sink
- `telegram:<chatId>` — numeric, may be negative for groups
- `discord:<channelId>` — 18–20 digit snowflake
- `slack:<channelId>` or `slack:<channelId>:<threadTs>`
- `line:<sourceId>` — userId, groupId, or roomId

## Call

Read `.claude/claudeclaw/settings.json` for `web.port` (default 4632), then:

```bash
curl -s -X POST http://127.0.0.1:<port>/api/send \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg t '<target>' --arg m '<message>' '{target:$t, text:$m, fromLabel:"cli"}')"
```

Use `jq -Rs .` or equivalent to safely JSON-escape multi-line messages.

## Rules

- One-way only. Do NOT promise that the recipient will respond.
- Never send sensitive content (tokens, secrets) to a shared channel without confirmation.
- If the daemon's web API isn't enabled, fall back to writing directly to `.claude/claudeclaw/inbox/<safeKey>.jsonl` as a JSON line: `{"ts":"<iso>","kind":"external","from":"(cli)","text":"<message>"}`.
