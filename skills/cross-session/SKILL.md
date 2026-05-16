---
name: cross-session
description: Reach another ClaudeClaw session — either send a real platform message (`/api/send`, which also leaves an inbox echo on the session that owns that chat) or trigger another session's AI turn with a prompt (`/api/trigger`). Use when the user asks to "tell the Discord agent", "ping me on Telegram when X finishes", "ask the #dev channel to look at this", "forward this to the other chat", "drop a note for global", etc. Telegram routing: DMs converge on `global`, groups get their own `telegram:<chatId>` channel.
---

# Cross-Session Communication

ClaudeClaw v2 runs one `claude` CLI session per channel:

- `global` — shared by all platform DMs and local Claude Code
- `telegram:<groupChatId>` — per Telegram group/supergroup
- `discord:<channelId>` — per Discord channel
- `slack:<channelId>` — per Slack channel
- `line:<sourceId>` — per LINE non-DM source

Sessions share the same project directory but have isolated conversation history. Two HTTP endpoints let you reach them.

## The two endpoints — what each one does

### `POST /api/send` — outgoing platform message + inbox echo

Sends a real message out to the target chat/channel via that platform's API (`bot.sendMessage` for Telegram, `webhook` for Discord, etc.). **The human on the other end sees it on their phone/computer immediately.**

Side effect: an entry is appended to the inbox of the session that *owns* inbound traffic from this target — so when that session is next triggered, it sees a system note saying "you sent ... earlier" and won't be confused about where the message came from. The inbox owner map:

| target form                          | platform message goes to              | inbox echo lands on  |
| ------------------------------------ | ------------------------------------- | -------------------- |
| `telegram:<positiveChatId>` (DM)     | that Telegram chat                    | `global`             |
| `telegram:<negativeChatId>` (group)  | that Telegram group                   | `telegram:<chatId>`  |
| `discord:<channelId>`                | that Discord channel                  | `discord:<channelId>`|
| `slack:<channelId>[:<threadTs>]`     | that Slack channel/thread             | `slack:<channelId>`  |
| `line:<sourceId>`                    | that LINE recipient                   | `line:<sourceId>`    |
| `global`                             | rejected — no platform binding        | —                    |

Use `/api/send` when:
- you want to **notify someone right now** ("✓ build done", "alert: rate-limit hit")
- you don't need the recipient agent to respond — you composed the exact text yourself
- you want the originating session to remember it sent this (the inbox echo)

### `POST /api/trigger` — run a peer session's AI turn

Pastes the prompt into a peer channel's `claude` CLI session as if a user had typed it. That session's agent runs a turn, and its assistant text gets routed to a chat platform via `replyTo` (auto-derived from the target key when not supplied).

| target form                         | resolves? | reply lands on                       |
| ----------------------------------- | --------- | ------------------------------------ |
| `global`                            | ✓         | nowhere unless `replyTo` is given    |
| `telegram:<groupChatId>` (group)    | ✓         | that Telegram group (auto-derived)   |
| `discord:<channelId>`               | ✓         | that Discord channel (auto-derived)  |
| `slack:<channelId>[:<threadTs>]`    | ✓         | that Slack channel/thread            |
| `line:<sourceId>`                   | ✓         | that LINE recipient                  |
| `telegram:<positiveChatId>` (DM)    | spawns phantom channel — don't use | — |

Use `/api/trigger` when:
- you want a peer agent to actually **think and respond** to a prompt
- the recipient should see an agent-composed reply, not a verbatim message
- you're delegating real work to a session that has the right context

## Calling shapes

### Discover the port

```bash
port=$(jq -r '.web.port // 4632' .claude/claudeclaw/settings.json 2>/dev/null || echo 4632)
```

### Send (real platform message)

```bash
curl -s -X POST "http://127.0.0.1:${port}/api/send" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg t '<target>' --arg m '<message>' \
        '{target:$t, text:$m, fromLabel:"cross-session"}')"
```

Response: `{"ok":true,"target":"…","inboxOwner":"…"}`. The `inboxOwner` tells you which session got the echo.

To ping a Telegram DM (e.g. Hans's chat 116013788):

```bash
curl -s -X POST "http://127.0.0.1:${port}/api/send" \
  -H "Content-Type: application/json" \
  -d '{"target":"telegram:116013788","text":"✓ build done","fromLabel":"cross-session"}'
```

This delivers the Telegram message immediately AND leaves an inbox echo on `global` so next time `global` runs a turn it sees "you sent ✓ build done to telegram:116013788 earlier".

### Trigger (peer AI turn)

```bash
curl -s -X POST "http://127.0.0.1:${port}/api/trigger" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg t '<target>' --arg p '<prompt>' \
        '{target:$t, prompt:$p, fromLabel:"cross-session"}')"
```

The API auto-derives `replyTo` from the target when you don't supply one, so for `discord:<id>` / `slack:<id>` / `line:<id>` / `telegram:<groupId>` the agent's reply lands on the right platform by default.

For `target=global` you usually want the reply on a specific platform — add `replyTo`:

```bash
... '{target:"global", prompt:"…", fromLabel:"cross-session",
       replyTo:{platform:"telegram",chatId:<chatId>}}'
```

Response is `{"ok":true,"dispatched":true,"target":"…"}` immediately — it's a queue insertion. The agent may take 10+ seconds before the reply actually appears, especially if the channel's tmux is spawning for the first time.

## Picking between send and trigger

| user intent                                                | use         |
| ---------------------------------------------------------- | ----------- |
| "ping me on Telegram when X finishes"                      | **send** (you compose the exact text) |
| "tell Hans the deploy is done"                             | **send**    |
| "post the test results to #dev"                            | **send**    |
| "ask the Discord agent to investigate this stack trace"    | **trigger** |
| "have the global session run the migration script"         | **trigger** |
| "make the line bot summarise today's logs"                 | **trigger** |

**Rule of thumb:** if you can write the exact message you want delivered, use `send`. If you need the recipient agent to think before responding, use `trigger`.

## Conventions

- **`fromLabel`**: identify origin. e.g. `"claude-code:<cwd-basename>"`, `"telegram:<chatId>"`, `"discord:<channelId>"`, or a generic `"cross-session"`.
- **Build JSON with `jq -n`**, not string concat, so the prompt/message is escaped safely.
- **Manual sends are noise for someone.** Don't fire on the user's behalf without them asking — these produce real chat messages humans see.
- **Don't loop.** If you just received something via cross-session, don't reflexively send/trigger back through the same path.
- **Watch `.claude/claudeclaw/logs/daemon-v2-*.log`** if a send or trigger silently fails.

## Slash command equivalents

The plugin ships these for human use:

- `/claudeclaw2:send <target> <message>` — wraps `/api/send`
- `/claudeclaw2:trigger <target> <prompt>` — wraps `/api/trigger`

When the user explicitly types a slash command, run it as-is. When you're acting on the user's intent, call the API directly so you can shape `fromLabel` and (for trigger to `global`) `replyTo` properly.
