---
description: Append a latent note to a peer channel's inbox (one-way, no platform message)
---

Append a JSON line to a peer channel's inbox file via the daemon's `/api/send` endpoint.

**What this actually does:** the daemon writes `.claude/claudeclaw/inbox/<safeKey>.jsonl`. The next time that exact channel pastes a *real* user turn into its tmux session, the inbox entries are folded into the prompt prefix as a "channel activity since your last turn" block and then the file is deleted. **No platform message is sent by this call.** If the target channel never receives another real turn, the inbox just sits there.

If you want to actually post a message that a human will see on Telegram/Discord/Slack/LINE, use `/claudeclaw2:trigger` instead. See the `cross-session` skill for the full mental model.

## Args

Parse `$ARGUMENTS` as `<target> <message...>`.

Valid `<target>` (must match an active channel for the note to ever be read):
- `global` — drained on the global session's next turn
- `discord:<channelId>` — drained on that channel's next turn
- `slack:<channelId>[:<threadTs>]`
- `line:<sourceId>`
- `telegram:<chatId>` — **dead letter**: Telegram traffic funnels to the `global` channel in v2, so this target is never drained. Use `target=global` if you want a Telegram-related note to be seen by the next turn.

## Call

```bash
port=$(jq -r '.web.port // 4632' .claude/claudeclaw/settings.json 2>/dev/null || echo 4632)
curl -s -X POST "http://127.0.0.1:${port}/api/send" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg t '<target>' --arg m '<message>' \
        '{target:$t, text:$m, fromLabel:"cli"}')"
```

Use `jq -Rs .` or equivalent to safely JSON-escape multi-line messages.

## Rules

- This call is silent — it never produces a visible platform message on its own.
- Never send sensitive content (tokens, secrets) through this path.
- If the daemon's web API is disabled, fall back to writing directly: `echo '{"ts":"<iso>","kind":"external","from":"cli","text":"<message>"}' >> .claude/claudeclaw/inbox/<safeKey>.jsonl` where `<safeKey>` is the target with non-alphanumerics replaced by `_`.
