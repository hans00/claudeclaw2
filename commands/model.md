---
description: Show / switch the Claude model — lists configured agentic modes when called without args
---

Help the user pick a Claude model for this channel. Behaviour splits on whether `$ARGUMENTS` is supplied.

## Setup

Read `.claude/claudeclaw/settings.json` (relative to cwd). Fields you need:

- `model` — explicit non-agentic default (may be empty)
- `agentic.enabled`, `agentic.defaultMode`
- `agentic.modes[]` — each has `name`, `model`, `keywords`, `phrases?`
- `agentic.hysteresis.stickyWindowMinutes` and `stickyWindowTurns`

If the file doesn't exist or is unreadable, tell the user to run `/claudeclaw2:start` first and stop.

## If `$ARGUMENTS` is non-empty

Treat the trimmed arg as a model id (e.g. `claude-opus-4-7`, `claude-sonnet-4-6`, or a configured mode name like `planning`).

If the arg matches a mode `name`, substitute its `model`. Otherwise pass the arg through as-is.

Then run the built-in `/model <resolved>` slash command so Claude Code performs the actual switch. Send a single-line confirmation back to the user — no preamble, no extras.

If the daemon is running and the user is in a bridged session (Telegram/Discord/Slack/LINE), the daemon's own `/model` interceptor handles this path already — your command body only runs in *local* Claude Code where the daemon's interception doesn't apply.

## If `$ARGUMENTS` is empty

Build a compact menu from settings:

- For each mode in `agentic.modes`, format as: `<name> → <model> — <first 5 keywords>`
- If `model` is set, also include it as `(explicit default)`

If you have access to `AskUserQuestion`, present the modes as choices and run `/model <chosen.model>` after selection. Otherwise just list them and tell the user to invoke `/claudeclaw2:model <name>` to pick one.

Mention the hysteresis sticky window so the user knows their pick will be respected by agentic routing for ~`stickyWindowMinutes` minutes / `stickyWindowTurns` turns.

## Rules

- Keep output short. One paragraph + the menu, max.
- Don't dump the full settings file or all keywords. Truncate.
- If `agentic.enabled` is false, say "agentic routing is off — the explicit `model` is what gets used" and skip the modes list.
