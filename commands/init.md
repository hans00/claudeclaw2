---
description: Agent-guided setup wizard — scaffolds and configures a ClaudeClaw project
---

Walk the user through a fresh ClaudeClaw v2 install. Follow these steps in order, and STOP between phases to confirm rather than charging through.

## Phase 0 — Sanity checks (BLOCKING)

1. Run `pwd` and `echo "$HOME"`.
   - If `pwd` equals `$HOME`, STOP. Tell the user: "ClaudeClaw should not be initialized in your home directory. Please `cd` to a project directory (e.g. `~/claudeclaw`) and re-run `/claudeclaw2:init`." Do not continue.

2. Verify runtime dependencies:
   ```bash
   which bun || true
   which tmux || true
   which claude || true
   ```
   - If any are missing, tell the user what to install:
     - bun: `curl -fsSL https://bun.sh/install | bash`
     - tmux: `brew install tmux` or `apt install tmux`
     - claude: https://docs.claude.com/claude-code
   - If `bun` is missing, offer to install it for them. Wait for confirmation before running the curl command.

## Phase 1 — Scaffold

3. Run the init scaffolder:
   ```bash
   bun run ${CLAUDE_PLUGIN_ROOT}/src/cli.ts init
   ```
   - This writes `.claude/claudeclaw/settings.json`, `CLAUDE.md`, `prompts/{IDENTITY,USER,SOUL}.md`, and `start.sh`. Existing files are left alone.
   - Show the user the output. Lines starting with `✓` are new files; `·` means already present.

4. Detect existing v1 state (only if you see ANY of these):
   - `.claude/claudeclaw/session.json` exists (v1 global)
   - `.claude/claudeclaw/sessions.json` has a top-level `threads` key (v1 shape)
   - `.claude/claudeclaw/daemon.pid` references a running process
   If yes, switch to `/claudeclaw2:migrate` instead and STOP. Do not double-init.

## Phase 2 — Persona

5. Read `CLAUDE.md` and `prompts/{IDENTITY,USER,SOUL}.md`. If they're still the template placeholders, ask the user:
   - A name they want their agent to be called.
   - A short vibe descriptor (warm, sharp, playful, calm, etc.).
   - A signature emoji.
   - What they go by (and timezone).
   Use Edit to replace the placeholders. Keep this round short — the user can iterate later.

## Phase 3 — Pick platforms

6. Ask the user which platforms to enable. Show:
   ```
   Which platforms do you want to set up? You can skip any and add later.
     [a] Telegram   — easiest, long-poll, no tunnel needed
     [b] Discord    — Gateway WS, needs MESSAGE_CONTENT privileged intent
     [c] Slack      — Socket Mode, needs xapp + xoxb tokens
     [d] LINE       — webhook, needs public HTTPS (cloudflared tunnel)
   ```
   Loop through each selected platform (one at a time) and walk them through:

### Telegram (if chosen)
- Tell them to create a bot via [@BotFather](https://t.me/BotFather) (`/newbot`) and paste the token.
- Tell them to DM [@userinfobot](https://t.me/userinfobot) for their numeric user id.
- Edit `.claude/claudeclaw/settings.json`:
  - `telegram.token` ← their token
  - `telegram.allowedUserIds` ← `[<their numeric id>]`

### Discord (if chosen)
- Tell them to create an app at https://discord.com/developers/applications
- **Important**: in the Bot tab, enable **Message Content Intent** (privileged).
- Get the bot token. Use OAuth2 → URL Generator → `bot` scope + permissions: Send Messages, Read Message History, Add Reactions.
- Edit `discord.token` and `discord.allowedUserIds` in settings.

### Slack (if chosen)
- Tell them to create a Slack app with **Socket Mode** enabled at https://api.slack.com/apps.
- Bot token scopes (minimum): `chat:write`, `im:history`, `channels:history`, `groups:history`, `files:read`, `reactions:write`.
- App-level token with `connections:write`.
- Subscribe to events: `message.channels`, `message.im`, `message.groups`.
- Edit `slack.appToken`, `slack.botToken`, `slack.allowedUserIds`.

**Ask which channel-routing mode they want** (`slack.defaultMode`, or per channel under `slack.channels.<id>.mode`):

  - `channel` (default) — every message in a channel (including thread replies) shares one session. Behaves like Discord. Good for casual / personal channels where the whole conversation history is one context.

  - `thread-per-message` — every top-level message in the channel starts its own session; thread replies join that thread's session. Matches a typical office workflow where each thread is a self-contained task or topic.

If they pick `thread-per-message`, **strongly recommend** dropping `sessionCleanup.idleTimeoutHours` from the default 168h (7 days) to something short like `2`–`8` hours. Each top-level message spawns a new tmux session; without aggressive cleanup, busy channels will leave dozens of dead sessions sitting around.

Note: idle-cleaned sessions auto-restore via `claude --resume` on the next inbound message in the same channel/thread — the `sessions.json` entry persists across cleanup, so context isn't lost.

### LINE (if chosen)
- Tell them they need a publicly reachable HTTPS endpoint. Easiest:
  ```bash
  cloudflared tunnel --url http://127.0.0.1:5001
  ```
- Create a LINE Messaging API channel and copy the long-lived channel access token + channel secret.
- Webhook URL: `<their tunnel URL>/line/webhook`.
- Edit `line.channelAccessToken`, `line.channelSecret`, `line.webhookPort: 5001`, `line.allowedUserIds`.

## Phase 4 — Web dashboard

7. Confirm `web.enabled: true` and `web.port: 4632` in settings (these are the defaults). Tell the user the dashboard will be at http://127.0.0.1:4632.

## Phase 5 — Smoke test

8. Start the daemon:
   ```bash
   ./start.sh
   ```
9. Wait ~6 seconds, then `tail -n 30 .claude/claudeclaw/logs/daemon.log` and show output. Look for `[daemon] ready` and the platform-specific connect lines.
10. Tell the user to send a test message from each configured platform and confirm a reply arrives.

## Phase 6 — Done

11. Tell the user:
    - To stop: `/claudeclaw2:stop` or `bun run ${CLAUDE_PLUGIN_ROOT}/src/cli.ts stop`
    - To restart after config edits: `/claudeclaw2:stop && /claudeclaw2:start`
    - Dashboard: http://127.0.0.1:4632
    - Logs: `.claude/claudeclaw/logs/daemon.log`
12. Suggest `/claudeclaw2:status` as a quick health check.

**Rules:**
- Never paste tokens to chat in plaintext — only ask the user to put them into the settings file directly.
- Don't auto-fill `allowedUserIds`/`allowedGroupIds` with random values. If the user doesn't know their id, walk them through finding it.
- If anything fails mid-setup, capture the failing log section and explain what's wrong before retrying.
