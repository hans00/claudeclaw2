# Install (clean slate)

Step-by-step setup when you don't have a v1 ClaudeClaw to migrate from.
If you do, see [MIGRATE.md](MIGRATE.md) instead — the auto-migration
will get you running in one command.

## 1. Prerequisites

ClaudeClaw v2 is just a Bun process that orchestrates real Claude Code
sessions inside tmux. You need:

| Tool | Why | Install |
|------|-----|---------|
| `bun` | runtime | `curl -fsSL https://bun.sh/install \| bash` |
| `tmux` | hosts each agent process | `brew install tmux` / `apt install tmux` |
| `claude` (Claude Code CLI) | the agent itself | https://docs.claude.com/claude-code |

Verify:

```bash
bun --version       # ≥ 1.3
tmux -V             # ≥ 3.0
claude --version    # any recent build
```

## 2. Clone the source

```bash
git clone https://github.com/hans00/claudeclaw2.git ~/Projects/claudeclaw2
cd ~/Projects/claudeclaw2
bun install
```

You can put the source anywhere. The generated `start.sh` will hardcode
this path, so pick somewhere stable.

## 3. Create a project directory

A "project directory" is the working directory the daemon runs from. It
holds your `settings.json`, `CLAUDE.md`, persona prompts, and the
runtime state (sessions, logs, inbox, attachments). Claude Code sessions
inherit this as their cwd, so any project-level skills/hooks/CLAUDE.md
discovery works naturally.

```bash
mkdir -p ~/my-claudeclaw
cd ~/my-claudeclaw

bun run ~/Projects/claudeclaw2/src/cli.ts init
```

That writes:

```
~/my-claudeclaw/
├── CLAUDE.md                        ← your persona + your human + context
├── start.sh                         ← points at the source checkout
├── prompts/
│   ├── IDENTITY.md                  ← what you are inside ClaudeClaw
│   ├── USER.md                      ← who your human is
│   └── SOUL.md                      ← how you speak
└── .claude/claudeclaw/
    └── settings.json                ← tokens, allowlists, scheduler config
```

Existing files are never overwritten. Re-running `init` is safe.

## 4. Fill in the persona

Open `CLAUDE.md` and pick a name/vibe/emoji. Then drop notes about
yourself (who the human is, what they care about) into `prompts/USER.md`,
and your voice into `prompts/SOUL.md`. These are all loaded into the
agent's system prompt at session spawn.

Tip: the agent itself can edit these files — once running, you can ask it
to "update prompts/USER.md with what you've learned so far".

## 5. Set up platforms

Pick what you actually need. Empty tokens disable a platform silently —
you don't have to configure all four.

### Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather): `/newbot`, pick
   a name + username, save the token.
2. Open `.claude/claudeclaw/settings.json`:
   ```json
   "telegram": {
     "token": "<paste the bot token>",
     "allowedUserIds": [<your-numeric-telegram-id>]
   }
   ```
3. Find your numeric id by DMing [@userinfobot](https://t.me/userinfobot)
   or sending any message to the new bot and checking
   `.claude/claudeclaw/logs/daemon.log`.

Privacy mode: `/setprivacy` in BotFather → `Disable` if you want the
bot to see all messages in groups, not just `/`-commands.

### Discord

1. Create an app at https://discord.com/developers/applications
2. **Bot** tab → reset/copy the token → put in `discord.token`.
3. **Enable Message Content Intent** (privileged) — required for v2 to
   read message bodies.
4. **OAuth2 → URL Generator** → check `bot` scope + the permissions you
   want (send messages, read message history, add reactions). Open the
   URL to invite the bot to your server.
5. Settings:
   ```json
   "discord": {
     "token": "<bot token>",
     "allowedUserIds": ["<your-discord-id>"],
     "channels": {
       "<channel-id>": { "enabled": true, "requireMention": false, "ignoreOtherMentions": true }
     }
   }
   ```
6. Per-channel: `requireMention: true` makes the bot only respond when
   `@-mentioned`. `ignoreOtherMentions: true` keeps it quiet when other
   people are talking to each other.

DMs to the bot route to the `global` channel automatically — no extra
config.

### Slack

1. Create a Slack app at https://api.slack.com/apps with **Socket Mode**
   enabled.
2. **Bot Token Scopes** (minimum): `chat:write`, `im:history`,
   `channels:history`, `groups:history`, `files:read`, `reactions:write`.
3. **App-Level Token** with `connections:write` scope.
4. **Event Subscriptions** → enable → subscribe to `message.channels`,
   `message.im`, `message.groups`.
5. Settings:
   ```json
   "slack": {
     "appToken": "xapp-...",
     "botToken": "xoxb-...",
     "allowedUserIds": ["U..."]
   }
   ```

### LINE

LINE Messaging API uses webhooks, so it needs a public HTTPS endpoint.
The simplest route is a [`cloudflared`](https://github.com/cloudflare/cloudflared)
tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:5001
# → outputs a https://*.trycloudflare.com URL
```

1. Create a LINE Messaging API channel in the
   [LINE Developers console](https://developers.line.biz/console/).
2. **Messaging API** → issue a channel access token (long-lived).
3. **Basic settings** → copy the channel secret.
4. **Messaging API → Webhook URL** → paste your tunnel URL +
   the configured `webhookPath`, e.g.
   `https://abc-123.trycloudflare.com/line/webhook`. Enable "Use
   webhook" and verify.
5. Settings:
   ```json
   "line": {
     "channelAccessToken": "<long token>",
     "channelSecret": "<secret>",
     "webhookPath": "/line/webhook",
     "webhookPort": 5001,
     "allowedUserIds": ["U..."]
   }
   ```

`webhookPort: 0` keeps LINE disabled.

## 6. Start

```bash
./start.sh
tail -f .claude/claudeclaw/logs/daemon.log
```

Healthy startup looks roughly like:

```
[daemon] no persisted sessions to restore
[telegram] started long-poll
[discord] connecting to gateway…
[cron] scheduler started (first tick in 12s)
[heartbeat] disabled
[web] listening on http://127.0.0.1:4632
[daemon] ready (project=/home/you/my-claudeclaw)
[discord] READY as <bot name> (<id>)
```

Open http://127.0.0.1:4632 for the dashboard.

Send a message from a platform → daemon spawns a tmux session, runs
`claude --session-id <uuid>` inside it, pastes your prompt, tails the
session jsonl, posts the agent's reply back to you.

## 7. Verify

```bash
# CLI helpers
bun run ~/Projects/claudeclaw2/src/cli.ts status
bun run ~/Projects/claudeclaw2/src/cli.ts send global "hello from cli"

# tmux sessions
tmux ls
# claudeclaw-global: 1 windows (created …)
```

## 8. Stop

```bash
bun run ~/Projects/claudeclaw2/src/cli.ts stop
# or
kill -TERM $(cat .claude/claudeclaw/daemon.pid)
```

The tmux sessions intentionally survive the daemon process so context is
preserved across restarts. To wipe everything:

```bash
tmux kill-server                  # nuke all tmux sessions (everywhere)
rm .claude/claudeclaw/sessions.json
rm -rf .claude/claudeclaw/inbox .claude/claudeclaw/attachments
```

## Troubleshooting

**`init-watch timed out` on session spawn.** Usually means a startup
prompt you haven't accepted yet — most often the `Bypass Permissions`
warning on first ever Claude Code run. The init-watch handles it, but
if a Claude Code version added a new prompt we don't recognize, the
daemon logs the last pane content. Open an issue with that block.

**Bot doesn't reply in a group/channel.** Check `requireMention` and
`ignoreOtherMentions` in `settings.json`. By default groups need
explicit `@-mentions`.

**Session jsonl not found.** The first turn hasn't completed yet —
Claude Code only writes the jsonl after it processes the first message.
This is normal during initial spawn; the tailer is already watching.

**Daemon restarts but loses memory.** Verify the daemon is reading the
same `sessions.json` (i.e. running from the same cwd). The auto-migrate
output `migrated N entries` only fires once; subsequent restarts say
`skipping: v2 sessions.json already populated`.
