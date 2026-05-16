---
name: cross-session
description: Communicate with another ClaudeClaw session — drop a latent note into a peer channel's inbox (`/api/send`) or actually hand off a prompt to a peer agent and have its reply land on a platform (`/api/trigger`). Use when the user asks to "tell the Discord agent", "ping me on Telegram when X finishes", "ask the #dev channel to look at this", "forward this to the other chat", "leave a note for global session", etc. Important quirks: Telegram has no per-chat channel (all traffic funnels to `global`), so `telegram:<chatId>` is NOT a valid target — to surface a message in a Telegram chat you must trigger `global` with `replyTo={platform:"telegram",chatId:…}`. `/api/send` never produces a platform-visible message on its own; it only seeds the next turn's prompt prefix.
---

# Cross-Session Communication

You're inside a ClaudeClaw v2 daemon that runs one `claude` CLI session per channel (global / discord:<id> / slack:<id> / line:<id>) plus a couple of message platforms (Telegram, Discord, Slack, LINE). All sessions share the same project working directory but have isolated conversation history. You can reach peer sessions via two local HTTP endpoints — but their semantics are narrower than the names suggest. Read this skill before using either one.

## The two endpoints — what they *actually* do

### `POST /api/send` — append to inbox file (latent note)

Implementation is one line: `appendInbox(target, { kind:"external", from:fromLabel, text })`. That writes a JSON line into `.claude/claudeclaw/inbox/<safeKey>.jsonl`. **Nothing else happens.**

That file is only read when the channel matching `<safeKey>` is about to paste a *new* turn into its tmux session — at that point the entries are folded into a "channel activity since your last turn" block prepended to the prompt body. Then the file is deleted.

Consequences:
- **No platform message is sent.** This endpoint never produces a Telegram/Discord/Slack/LINE message on its own.
- If the target is not an active channel (or never becomes one), the inbox file just sits there forever as a dead letter.
- **Telegram targets are dead letters.** All inbound Telegram traffic in v2 — DM or group — is routed to the `global` channel; there is no per-chat Telegram channel. So `/api/send target=telegram:<id>` writes to `.claude/claudeclaw/inbox/telegram_<id>.jsonl` which nobody ever drains.

Use `/api/send` only when:
- you genuinely want to leave a note that will be folded into the next *real* turn on a known-active channel (`global`, or a discord/slack/line channel that has live traffic)
- you don't need the recipient agent to wake up or respond immediately
- you don't need anything to appear on a chat platform

### `POST /api/trigger` — paste a prompt into a peer channel's session

Implementation: `resolveChannel(target)` → `channel.handleIncoming({ text, fromLabel, replyTo })`. This actually queues a turn on that channel's agent. The agent processes the prompt; any assistant text emissions are routed to `replyTo` (if set) for delivery to a chat platform, or logged-only if `replyTo` is null.

Consequences:
- **The target must resolve.** `resolveChannel` accepts: `global`, `discord:<id>`, `slack:<id>`, `line:<id>`. **Telegram is NOT in this list.** `/api/trigger target=telegram:<id>` returns HTTP 404 `{ "error": "target ... not resolvable" }`.
- For a discord/slack/line target, that channel inherently knows its platform binding, so the agent's reply lands on that channel even without setting `replyTo`.
- For `target=global`, the global agent has no implicit platform binding — its reply will only reach a platform if you supply `replyTo` with the right `{platform, chatId/channelId/…}`.

Use `/api/trigger` when:
- you want a peer agent to actually run something and respond
- you want the response to be visible on a chat platform
- you're delegating real work to a session that has the right context for it

## How to actually ping Telegram

The only path:

```bash
port=$(jq -r '.web.port // 4632' .claude/claudeclaw/settings.json 2>/dev/null || echo 4632)
curl -s -X POST "http://127.0.0.1:${port}/api/trigger" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg p '<prompt for the global agent>' --argjson chat <chatId> \
        '{target:"global", prompt:$p, fromLabel:"cross-session",
          replyTo:{platform:"telegram",chatId:$chat,messageId:null}}')"
```

This makes the `global` agent run `<prompt>`, then sends its reply to Telegram chat `<chatId>`. There is no daemon-side "just send this exact text to chat X" bypass — the agent always reads + composes the outgoing message.

If you want the most lightweight possible ping, hand the agent a one-line prompt like `Reply to the user with exactly: "✓ build done"` — the agent costs you one turn but produces the visible Telegram message.

## How to actually message a Discord / Slack / LINE channel

That channel HAS its own session, so trigger it directly:

```bash
curl -s -X POST "http://127.0.0.1:${port}/api/trigger" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg t 'discord:<channelId>' --arg p '<prompt>' \
        '{target:$t, prompt:$p, fromLabel:"cross-session"}')"
```

Discord channels are multiparty so the agent there decides whether to actually reply (NO_REPLY logic applies). If you need the message guaranteed to surface, phrase the prompt as an unambiguous instruction.

## Target grammar — accept/reject matrix

| target form                    | `/api/send` (inbox)         | `/api/trigger` (agent)        |
| ------------------------------ | --------------------------- | ----------------------------- |
| `global`                       | ✓ drained next global turn  | ✓ runs on global agent        |
| `discord:<channelId>`          | ✓ drained on next turn there| ✓ runs on that channel        |
| `slack:<channelId>[:<threadTs>]` | ✓ drained on next turn    | ✓ runs on that channel        |
| `line:<sourceId>`              | ✓ drained on next turn      | ✓ runs on that channel        |
| `telegram:<chatId>`            | ✗ **dead letter**           | ✗ **404 not resolvable**      |

To enumerate live channels, hit `GET /api/sessions`.

## Conventions

- **Port discovery**: `port=$(jq -r '.web.port // 4632' .claude/claudeclaw/settings.json 2>/dev/null || echo 4632)`
- **`fromLabel`**: identify origin. e.g. `"telegram:<chatId>"`, `"discord:<channelId>"`, `"claude-code:<cwd-basename>"`, or `"cross-session"` as a generic.
- **Build JSON with `jq -n`**, not string concat, so the prompt/message is escaped safely.
- **Manual triggers are noise for someone.** Don't fire on the user's behalf without them asking — these produce real chat messages humans will see.
- **Don't loop.** If you receive something via this channel, don't reflexively reply back through the same path.
- **Watch `.claude/claudeclaw/logs/daemon-v2-*.log`** if a dispatch silently fails or an agent reply doesn't surface.

## Slash command equivalents

The plugin ships these for human use:

- `/claudeclaw2:send <target> <message>` — wraps `/api/send`
- `/claudeclaw2:trigger <target> <prompt>` — wraps `/api/trigger`

These inherit the same accept/reject matrix above. When the user types one of them, run it as-is. When you're acting on your own intent, build the curl call directly so you can attach the right `replyTo`.
