# 🦞 ClaudeClaw v2

A multi-channel bridge for Claude Code. Run one persistent agent per chat
(Telegram / Discord / Slack / LINE), backed by real `claude` CLI sessions
inside tmux — so every Claude Code feature (skills, hooks, plugins, MCP,
slash commands) is available out of the box.

```
┌─ Telegram ─┐
│  Discord   │──► Channel Daemon (Bun/TS) ──► per-channel tmux session
│  Slack     │      • routes I/O                running `claude --resume`
│  LINE      │      • tails jsonl                writes to your project
└─ Web API ──┘      • cron + heartbeat           and ~/.claude/projects/
```

## Why v2

v1 wrapped the Claude Agent SDK and re-implemented features Claude Code
already has. v2 runs Claude Code as-is inside tmux and just plays
post-office:

- All Claude Code features come for free (skills, hooks, plugins, MCP)
- Per-channel state is durable via the CLI's own session jsonl
- Cross-session messaging is plain files in `.claude/claudeclaw/inbox/`
- Restart is safe: tmux outlives the daemon, context never lost
- Smaller surface, fewer abstractions to maintain

Design background and spike findings live in [`docs/redesign.md`](docs/redesign.md).

## Features

- **Platforms**: Telegram (long-poll), Discord (Gateway WS), Slack (Socket
  Mode), LINE (webhook) — all with text, media download, and reactions
- **Cross-platform DM sink**: Telegram + Discord/Slack/LINE DMs all share
  one "global" session, just like v1
- **Per-channel sessions**: each Discord channel, Slack thread, LINE group
  gets its own `claude --session-id` so context never bleeds across
- **Cron**: `.md` files with frontmatter (schedule, target, replyTo) —
  agent can manage them itself via Write/Read
- **Heartbeat**: periodic ambient prompt with quiet-hours support
- **Model routing**: per-turn `/model` switch based on keyword classifier
  (planning → opus, implementation → sonnet, etc.)
- **Reactions**: agent emits `[react:🌸]` in its reply, daemon strips and
  applies as a native platform reaction
- **Web dashboard**: status, transcripts, jobs, logs (`http://127.0.0.1:4632`)
- **HTTP API**: `/api/send`, `/api/trigger` for cross-session messaging
- **CLI**: `bun run src/cli.ts {status,send,trigger,stop,init}`

## Quick start

Prerequisites: [`bun`](https://bun.sh), [`tmux`](https://github.com/tmux/tmux),
and the [Claude Code CLI](https://docs.claude.com/claude-code) on your PATH.

```bash
# 1. Clone + install
git clone https://github.com/hans00/claudeclaw2.git ~/Projects/claudeclaw2
cd ~/Projects/claudeclaw2
bun install

# 2. Initialize a project directory
mkdir -p ~/my-project && cd ~/my-project
bun run ~/Projects/claudeclaw2/src/cli.ts init

# 3. Fill in tokens
$EDITOR .claude/claudeclaw/settings.json
$EDITOR CLAUDE.md prompts/*.md

# 4. Start
./start.sh
# logs at .claude/claudeclaw/logs/daemon.log
# web dashboard at http://127.0.0.1:4632
```

## Migrating from v1

If you already run v1 ClaudeClaw, see [`docs/MIGRATE.md`](docs/MIGRATE.md).
The short version:

```bash
# stop v1
kill -TERM $(cat .claude/claudeclaw/daemon.pid)

# point your start.sh at v2's daemon
sed -i 's#.*plugins/marketplaces/claudeclaw/src/index.ts.*#nohup bun run ~/Projects/claudeclaw2/src/daemon.ts \\\n  > .claude/claudeclaw/logs/daemon.log 2>\&1 \&#' start.sh

# start — v2 auto-migrates v1 state on first boot
./start.sh
```

First boot reads v1's `session.json` + `sessions.json.threads.*` and
rewrites `.claude/claudeclaw/sessions.json` in v2 shape. The originals
are renamed to `*.v1-backup` rather than deleted.

## Docs

- [`docs/INSTALL.md`](docs/INSTALL.md) — clean-slate setup, per-platform
  (Telegram / Discord / Slack / LINE) configuration
- [`docs/MIGRATE.md`](docs/MIGRATE.md) — v1 → v2 migration
- [`docs/redesign.md`](docs/redesign.md) — architecture + spike findings
- [`docs/TODO.md`](docs/TODO.md) — v1 features not (yet) ported

## Layout

```
src/
  tmux.ts          tmux CLI wrappers (paste, send-keys, capture-pane, …)
  jsonl.ts         tail + parser for claude session files
  sessions.ts      .claude/claudeclaw/sessions.json (durable)
  inbox.ts         cross-session message queue (durable)
  channel.ts       per-channel state machine (spawning/idle/running/interrupting)
  compose.ts       --append-system-prompt + security args builder
  init-watch.ts    detect ready signal + auto-handle startup prompts
  cron.ts          5-field cron evaluator
  jobs.ts          .md job loader + scheduler
  heartbeat.ts     periodic ambient prompt
  reactions.ts     [react:<emoji>] extractor
  model-router.ts  per-turn agentic model classifier
  statusline.ts    writes .claude/claudeclaw/state.json for the plugin
  attachments.ts   shared media download + prompt prefix builder
  migrate.ts       v1 → v2 state migration
  init.ts          `cli init` template writer
  web.ts           HTTP API + HTML dashboard
  config.ts        .claude/claudeclaw/settings.json loader
  daemon.ts        main entry — wires everything
  cli.ts           subcommands (status/send/trigger/stop/init)
  platforms/
    telegram.ts    long-poll + chunked send + reactions
    discord.ts     Gateway WebSocket + REST + reactions
    slack.ts       Socket Mode + Web API + reactions
    line.ts        webhook + REST + reactions
docs/              architecture / install / migrate / TODO
scripts/
  integration-test.ts  spawns tmux + claude end-to-end
```

## License

MIT. See [LICENSE](LICENSE) (TBD).
