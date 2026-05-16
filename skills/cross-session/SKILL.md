---
name: cross-session
description: Communicate with another ClaudeClaw session (different Telegram chat, Discord channel, Slack channel, LINE source, or the global DM sink). Use when the user asks to "tell the Discord agent", "ping me on Telegram when X finishes", "ask the #dev channel to look at this", "forward this to the other session", "send a message to <chat/channel>", or any request that crosses session boundaries. Two endpoints exist on the local daemon — `/api/send` (one-way notification, drops into the target's inbox) and `/api/trigger` (two-way handoff, makes the target agent actually run the prompt). Pick the right one based on whether the user wants a response from the other end.
---

# Cross-Session Communication

You're running inside a ClaudeClaw v2 daemon that manages multiple `claude` CLI sessions — one per chat/channel — across Telegram, Discord, Slack, LINE, and a shared `global` sink. Each session has its own conversation history and working state, but they share the same project working directory. You can talk to peer sessions via a tiny local HTTP API exposed by the daemon.

## When to reach for this skill

Use it whenever the requested action touches a session that **isn't the one you're currently running in**:

- "Tell Hans on Telegram once the build passes" → notify another session
- "Have the Discord #dev agent look at issue 42" → hand off to another session
- "Send a heads-up to the Slack ops channel" → notify
- "Forward this summary to the other chat" → notify
- "Ask the global session to run the migration" → hand off

If everything you need to do stays inside your current channel, don't use this — just respond normally.

## The two endpoints

### `POST /api/send` — one-way notification

Drops a plain-text note into the target channel's inbox file. The target agent does **not** wake up or respond. The note will be folded into the prefix of the next *real* user message that channel receives, so the recipient sees it as context.

Use when:
- You want to leave a breadcrumb for the human on the other side ("done — see results in `out/`")
- You want to tell another session something it should know next time it runs, but you don't need it to act now

### `POST /api/trigger` — two-way handoff

Pastes the prompt into the target channel's session as if a user had typed it. The target agent runs it, and its reply lands **on the target platform** (Discord channel post, Telegram message, etc.), NOT back in your terminal.

Use when:
- You're delegating real work: "the Discord agent has the right working directory for this — let it do it"
- The target should produce visible output for someone watching that channel
- The user explicitly wants the other session to do something and reply there

## Discovering the port

```bash
port=$(jq -r '.web.port // 4632' .claude/claudeclaw/settings.json 2>/dev/null || echo 4632)
```

If the daemon's web server is disabled (`.web.enabled === false`), the `/api/send` path can still be approximated by appending a JSON line to `.claude/claudeclaw/inbox/<safeKey>.jsonl`. `/api/trigger` has no offline fallback — it requires the daemon running.

## Target grammar

`<target>` strings (used in both endpoints):

| form                                    | meaning                                                |
| --------------------------------------- | ------------------------------------------------------ |
| `global`                                | the cross-platform DM sink + local Claude Code session |
| `telegram:<chatId>`                     | numeric chat id; negative for groups                   |
| `discord:<channelId>`                   | 18–20 digit snowflake                                  |
| `slack:<channelId>`                     | a Slack channel                                        |
| `slack:<channelId>:<threadTs>`          | a specific Slack thread within a channel               |
| `line:<sourceId>`                       | a LINE userId / groupId / roomId                       |

The daemon already knows which channels are alive — check `GET /api/sessions` if you need to enumerate.

## Calling shape

Always build the JSON body with `jq -n` so the prompt/message is escaped safely. Don't string-concatenate user input.

### Send

```bash
curl -s -X POST "http://127.0.0.1:${port}/api/send" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg t '<target>' --arg m '<message>' \
        '{target:$t, text:$m, fromLabel:"cross-session"}')"
```

Response: `{"ok":true,"delivered":"inbox","target":"…"}`.

### Trigger

```bash
curl -s -X POST "http://127.0.0.1:${port}/api/trigger" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg t '<target>' --arg p '<prompt>' --arg l 'cross-session' \
        '{target:$t, prompt:$p, fromLabel:$l}')"
```

Response: `{"ok":true,"dispatched":true,"target":"…"}`. The response comes back **immediately** — it's a queue insertion, not a synchronous run. The target may take 10+ seconds to actually reply, especially if its tmux session is being spawned for the first time.

## Conventions

- **`fromLabel`**: set this to something that identifies *where the message came from* — e.g. `"telegram:<chatId>"`, `"discord:<channelId>"`, `"claude-code:<cwd-basename>"`. The target agent uses it to understand who's pinging it.
- **Manual triggers belong to humans, not you.** Don't fire cross-session requests on the user's behalf without them asking. They produce visible noise (real chat messages) and have a small cost.
- **Don't loop.** If you receive a message that looks like it came from another session via this skill, do not reflexively reply through the same channel — that's how infinite ping-pongs start.
- **Watch the daemon log** at `.claude/claudeclaw/logs/daemon-v2-*.log` if a dispatch silently fails — the failure usually surfaces there before HTTP returns an error.

## Slash command equivalents

The plugin ships these as user-facing slash commands (so the human can invoke them too):

- `/claudeclaw2:send <target> <message>`
- `/claudeclaw2:trigger <target> <prompt>`

You can use the slash commands when the user explicitly types them. When you're acting on your own initiative based on the user's intent, use the curl calls above directly.
