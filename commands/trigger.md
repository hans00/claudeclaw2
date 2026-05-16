---
description: Hand a prompt to a peer channel's agent — its reply lands on the platform (two-way)
---

Queue a prompt into a peer channel's `claude` session via the daemon's `/api/trigger` endpoint. The target agent will actually process the prompt; its text reply is dispatched to a chat platform via `replyTo`.

For a latent inbox note (no platform message), use `/claudeclaw2:send` instead. See the `cross-session` skill for the mental model.

## Args

Parse `$ARGUMENTS` as `<target> <prompt...>`.

Valid `<target>` (must resolve via `deriveKindFromKey`):
- `global`
- `discord:<channelId>`
- `slack:<channelId>[:<threadTs>]`
- `line:<sourceId>`
- `telegram:<chatId>` — **NOT a valid target.** v2 has no per-chat Telegram channel; all Telegram traffic funnels to `global`. To make a Telegram chat receive a message, use `target=global` + `replyTo={platform:"telegram",chatId:<id>,messageId:null}`.

## Call

```bash
port=$(jq -r '.web.port // 4632' .claude/claudeclaw/settings.json 2>/dev/null || echo 4632)
curl -s -X POST "http://127.0.0.1:${port}/api/trigger" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg t '<target>' --arg p '<prompt>' \
        '{target:$t, prompt:$p, fromLabel:"cli"}')"
```

To direct the reply to a specific platform when targeting `global`, add `replyTo`:

```bash
... '{target:"global", prompt:$p, fromLabel:"cli",
       replyTo:{platform:"telegram",chatId:<chatId>,messageId:null}}'
```

The response is `{ ok: true, dispatched: true }` once the prompt is queued. The agent's reply lands on the target platform — NOT in your local terminal. First dispatch to a new channel takes longer because it also boots tmux + claude CLI.

## Rules

- 10s+ latency is normal; don't poll, just confirm dispatch.
- discord/slack/line channels are multiparty — the agent there may decide NO_REPLY based on its own context. If you need the message guaranteed to surface, phrase the prompt as a clear instruction.
- Never trigger silently on the user's behalf — these produce real chat traffic that humans see.
