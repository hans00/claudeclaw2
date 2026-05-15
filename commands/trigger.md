---
description: Run the agent on a target channel with a specific prompt (two-way)
---

Trigger an agent run on the target channel. Unlike `/claudeclaw2:send` (one-way notification), this actually pastes the prompt into the target channel's session and the agent will process and respond.

## Args

Parse `$ARGUMENTS` as `<target> <prompt...>`.

`<target>` grammar (same as send):
- `global`
- `telegram:<chatId>`
- `discord:<channelId>`
- `slack:<channelId>[:<threadTs>]`
- `line:<sourceId>`

## Call

Read `.claude/claudeclaw/settings.json` for `web.port` (default 4632):

```bash
curl -s -X POST http://127.0.0.1:<port>/api/trigger \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg t '<target>' --arg p '<prompt>' '{target:$t, prompt:$p, fromLabel:"cli"}')"
```

The response includes `{ ok: true, dispatched: true }` once the prompt is queued. The agent's reply lands on the target platform (Telegram message, Discord channel post, etc) — NOT in your local terminal.

## Rules

- The receiving session may take 10+ seconds to respond — don't wait, just confirm dispatch.
- The target channel is lazy-spawned if it doesn't exist yet (only for `global` + `discord:*` / `slack:*` / `line:*`). The first dispatch to a new channel takes longer because it's also booting a tmux session.
