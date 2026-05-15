# TODO

v1 features we intentionally didn't port (yet). Each entry is short on
purpose — when you pick one up, expand it into a real spec.

## Voice transcription (whisper)

v1 transcribed Telegram voice messages before prompting the agent. Two
paths in v1's `src/whisper.ts`:

- Remote OpenAI-compatible STT API (`settings.stt.baseUrl`) — ~30 LOC.
- Local `whisper.cpp` binary auto-downloaded into
  `.claude/claudeclaw/whisper/` (~455 LOC, ~350 MB asset download on
  first use).

v2 currently delivers voice files as `[Attached voice · Ns: <path>]`
prompt prefix lines and leaves transcription up to the agent (Bash +
its own tools). If transcription becomes a hot path, port the remote
STT path first.

## LINE bot

v1 had `src/commands/line.ts` (~827 LOC). Not started in v2. Would
slot in as `src/platforms/line.ts` mirroring the Telegram/Discord/Slack
shape — long-poll/webhook + sendMessage + reactions where available.

## Proxy command

v1 had `src/commands/proxy.ts` (~501 LOC). Purpose: TBD — needs a read
before deciding whether to port.

## Web UI history viewer

v1's `src/ui/` (~262 LOC server + page assets) browsed session jsonl
files in the browser. v2's `src/web.ts` only exposes a status table and
`/api/*`. If we want history browsing, render the jsonl with the same
`parseLine` semantics from `src/jsonl.ts`.

## Outbound stickers

`[react:<emoji>]` is in. `[sticker:<id>]` is not. Telegram has
`sendSticker`; Discord supports up to 3 sticker IDs per message;
Slack does not have stickers. Useful but never urgent.

## Inbound reaction events

Bot doesn't observe when users add reactions to messages — currently
`allowed_updates` on Telegram only requests `message` / `edited_message`.
Wiring `message_reaction` would let the agent treat user reactions as
synthetic input ("Hans reacted 🌸 to my reply about X — acknowledge").
Discord + Slack have equivalent event types.

## MCP tools for cron management

Today the agent manages jobs by writing markdown files itself (see the
schema in `src/compose.ts`'s `CRON_JOBS_HINT`). A typed MCP server would
give it `CronCreate(name, schedule, target, prompt)` etc with proper
arg validation. Lower-priority — the file-based path works.

## Cron persistence on missed ticks

If the daemon is down at a scheduled minute, the job doesn't fire and
isn't caught up. v1 had similar behaviour; if catch-up is wanted, add
a `lastFiredAt` per job and replay on startup.

## Init-watch unknowns

The startup-prompt pattern table in `src/init-watch.ts` covers what we
saw in the spike (`bypassPermissions` warning). The Claude Code CLI's
compact/sync dialogs were never reproduced, so their patterns are
placeholders. Verify next time one fires in production.
