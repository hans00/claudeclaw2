# ClaudeClaw Redesign — tmux-hosted Claude Code Agents

Replacing the SDK-wrapped runner with real `claude` CLI instances running inside tmux
sessions. Channel daemon handles I/O routing and observes agent state via tmux + jsonl.

## Goals

- Use Claude Code's full feature set (skills, hooks, plugins, MCP, `/commands`) by running
  the real CLI instead of wrapping the SDK ourselves.
- Decouple channel I/O from agent runtime. Channel daemon stays small and stateless about
  conversations; agent state lives in Claude Code's own session jsonl.
- Keep per-channel session isolation (Telegram global / Discord per-channel /
  Slack per-thread) as today.
- Preserve cross-session messaging (inbox) and current permission model.

## High-level Diff

|  | Current | New |
|--|---------|-----|
| Agent runtime | Claude Agent SDK via `streamClaude()` | `claude` CLI inside tmux |
| Session storage | `session.json` + `sessions.json` (sessionId tracking) | Claude Code's own jsonl + `sessions.json` (state-only) |
| Output streaming | SDK chunk events | jsonl tail + per-segment posts |
| Input | SDK `query()` call | tmux `load-buffer` + `paste-buffer -p` + Enter |
| Interrupt | SDK abort | `tmux send-keys Esc` |
| System prompt | `--append-system-prompt` per call | `--append-system-prompt` at session spawn |
| CLAUDE.md | Manually concatenated into append | Auto-discovered by Claude Code from cwd |

## Architecture

```
                    ┌─────────────────────┐
  Telegram ────────►│                     │
  Discord  ────────►│   Channel Daemon    │
  Slack    ────────►│  (Bun/TypeScript)   │
                    │                     │
                    │  • inbound routing  │
                    │  • settings allow   │
                    │  • sessions.json    │
                    │  • tmux spawn/io    │
                    │  • jsonl tail       │
                    │  • outbound post    │
                    └──────────┬──────────┘
                               │ tmux send-keys / paste-buffer
                               │ tmux capture-pane (init-watch)
                               ▼
                    ┌─────────────────────────────────┐
                    │   Agent Runtime (per channel)   │
                    │   tmux session: claudeclaw-<k>  │
                    │   running: `claude --session-id`│
                    │                                 │
                    │   writes ~/.claude/projects/    │
                    │     <cwd-hash>/<uuid>.jsonl     │
                    └─────────────────┬───────────────┘
                                      │ jsonl append
                                      ▼ (channel daemon tails)
```

All tmux sessions run with the same cwd (project root). Per-channel separation is by
`sessionId` + tmux session name, not by working directory.

## Components

### Channel Daemon

Single Bun process. Holds platform connections (Telegram bot, Discord gateway, Slack RTM),
HTTP API for cross-session triggers, and a per-channel state machine.

Responsibilities:
- Receive inbound messages, apply settings allowlist, route to channel state machine.
- Lazy spawn tmux session + `claude --session-id <uuid>` on first allowed message for a
  channel.
- Maintain queue + busy state per channel.
- Tail each channel's jsonl, emit platform messages on new assistant/tool entries.
- Drain inbox into next prompt prefix when paste-ready.
- Handle service restart: kill all tmux, restore from `sessions.json`, re-spawn with
  `--resume <uuid>`.

### Agent Runtime

Plain `claude` CLI processes, one per channel, inside detached tmux sessions. No custom
code runs here — Claude Code does everything natively.

tmux session naming: `claudeclaw-<kind>-<id-slug>` (e.g. `claudeclaw-tg-116013788`,
`claudeclaw-dc-1492947673311871069`). Deterministic; survives daemon restart.

## State

### `settings.json` (config, unchanged)

Existing structure preserved. Defines **what is allowed**: tokens, allowlists,
`discord.channels[id]` rules, security level, model config. Not modified by the daemon.

### `.claude/claudeclaw/sessions.json` (runtime state, NEW)

Created/updated by daemon. Tracks which channels have active sessions.

```json
{
  "telegram:116013788": {
    "kind": "telegram",
    "channelKey": "telegram:116013788",
    "sessionId": "07a068a8-a5bc-4322-8394-9c2501c44763",
    "tmuxSession": "claudeclaw-tg-116013788",
    "multiparty": false,
    "createdAt": "2026-05-14T17:30:00Z",
    "lastActivityAt": "2026-05-14T17:45:12Z",
    "state": "idle",
    "inflight": {
      "lastAssistantMsgId": "msg_01...",
      "lastPlatformMessageId": "1234567890"
    }
  }
}
```

State enum: `spawning | idle | running | interrupting`.

`multiparty` is derived from platform metadata at first activity:
- Telegram: `chat.type !== "private"` → multi
- Discord: guild text channel → multi; DM channel → single
- Slack: channel/thread → multi; IM → single

### `.claude/claudeclaw/inbox/<channelKey>.jsonl` (cross-session, unchanged)

Existing design carries over. Drained and prepended to next user prompt when channel
transitions from idle → running. See `src/inbox.ts`.

## Lifecycle

### First message on a new channel

```
1. inbound message → channel daemon
2. check settings.json allowlist → reject if not allowed
3. derive multiparty from platform metadata
4. sessionId = uuidv4()
5. tmux new-session -d -s <tmuxSession> -x 200 -y 50
6. tmux send-keys: `claude --session-id <uuid> <security-args> --append-system-prompt "<compose>"`
7. init-watch:
   - poll `tmux capture-pane` until ready signal OR known prompt detected
   - dismiss bypass warning if it appears (Down + Enter)
   - log unknown prompts; after timeout send Esc as unstuck attempt
8. write sessions.json entry (state=idle)
9. drain inbox + paste user prompt → state=running
```

### Subsequent message (session exists, state=idle)

```
1. inbound message → channel daemon
2. lookup sessions.json entry
3. drain inbox
4. compose prompt = inbox-block + user-message
5. tmux load-buffer + paste-buffer -p + Enter
6. state=running
7. start tailing jsonl (already running, just route new entries)
```

### Subsequent message (state=running)

Enqueue. When state returns to idle, next paste pulls from queue.

### Daemon start / service restart

```
1. read settings.json + sessions.json
2. for each sessions.json entry:
   - tmux has-session -t <tmuxSession> ?
     - yes → attach (no spawn needed, jsonl tail resumes)
     - no  → spawn fresh tmux + `claude --resume <sessionId> --append-system-prompt "..."`
            (init-watch handles any resume-time prompts)
3. resume platform connections
4. begin accepting inbound
```

### Service restart (config change)

```
1. SIGHUP or POST /api/reload
2. flush queues (or drain to disk for replay)
3. tmux kill-session on every claudeclaw-* session
4. re-read settings.json + sessions.json
5. re-spawn every session via `claude --resume <uuid> --append-system-prompt "<new compose>"`
6. Claude Code re-discovers CLAUDE.md from cwd automatically
```

CLAUDE.md changes do not require restart (Claude Code re-reads).
NO_REPLY rule change / prompts/ change / settings change → restart.

## tmux Interface

### Spawn

```bash
tmux new-session -d -s <tmuxSession> -x 200 -y 50
tmux send-keys -t <tmuxSession> "claude --session-id <uuid> <args>" Enter
```

The `-x 200 -y 50` geometry is mandatory — default 80×24 truncates Claude Code's TUI.

### Paste (multi-line)

```bash
tmux load-buffer -t <tmuxSession> <payload-file>
tmux paste-buffer -t <tmuxSession> -p     # -p enables bracketed paste
```

Verified: multi-line text enters as a single multi-line input with correct continuation
indents. Do NOT use plain `send-keys` for prompt content — newlines would submit early.

### Submit

```bash
tmux send-keys -t <tmuxSession> Enter
```

### Interrupt

```bash
tmux send-keys -t <tmuxSession> Escape
```

Confirmed via spike: cleanly aborts mid-stream and returns input box to ready state.
jsonl does not write an explicit "interrupted" marker — daemon detects via "no new
assistant entry follows the last user entry within N seconds after Esc."

### Quit (for restart)

```bash
tmux send-keys -t <tmuxSession> "/quit" Enter   # graceful, prints "Resume this session with: ..."
tmux kill-session -t <tmuxSession>              # hard, faster
```

For service restart use kill-session — context is preserved in jsonl regardless.

## jsonl Tail & Output Routing

### Discovered behavior (spike-verified)

- Entries are flushed at **logical boundaries**, not per token:
  - `stop_reason: "tool_use"` → flush thinking + tool_use entries together
  - `stop_reason: "end_turn"` → flush final text + system metadata together
  - `tool_result` (user-role entry) → flush after tool execution
- A simple text-only response produces **one flush at end_turn** (no incremental writes).
- One user turn that uses tools produces multiple flushes (one per tool boundary).
- `message.id` (msg_id) groups segments: pre-tool segments share one msg_id, post-tool
  text gets a new msg_id.
- Each line in the file is a complete valid JSON object. No partial writes observed.

### Entry → platform message mapping

```
tail -F <jsonl>
on new line:
  parse
  if type == "assistant" && content has text item:
    → post platform message with text
  elif type == "assistant" && content has tool_use:
    → post status message: "🛠 <tool_name>: <truncated input>"
  elif type == "assistant" && content has thinking:
    → skip (or optionally post as italics if Hans wants)
  elif type == "user" && content has tool_result:
    → skip (or post truncated result if useful)
  else:
    → skip (ai-title, system, file-history-snapshot, attachment, permission-mode, ...)
```

No edits — pure append-only posts. Each jsonl entry that produces a platform message
becomes its own message.

### Turn-end signal

`stop_reason: "end_turn"` on an assistant entry = turn is complete. Channel daemon sets
state=idle and drains queue.

### Platform reply target

Reply to the **last user-platform-message** that was in the queue when the turn started.

## Queue & Interrupt

```
state: spawning | idle | running | interrupting

inbound user message:
  spawning      → enqueue (will paste after init-watch completes)
  idle          → drain inbox + paste; state=running
  running       → enqueue (and if multi-party policy: auto-interrupt → state=interrupting)
  interrupting  → enqueue

turn end (end_turn observed):
  state=idle
  if queue not empty: merge per current format (sender-tagged, see below) + paste

user /stop command:
  if running:  send Esc; state=interrupting; clear queue
  if idle:     no-op

auto-interrupt (busy + new msg policy):
  send Esc; state=interrupting; keep queue (the new msg is already in it)

interrupt observed (no assistant entry within N seconds):
  state=idle; drain queue if any
```

### Queue merge format

Current ClaudeClaw production behavior carries over: append-style queue, each user message
becomes a tagged line in the next prompt. Multi-party channels include sender labels.
This is sufficient — no special merge logic needed.

## System Prompt Composition

Built once per session spawn (new or resume) and passed via `--append-system-prompt`.

```
appendParts = [
  "You are running inside ClaudeClaw.",            # brand
  loadPrompts(),                                    # prompts/IDENTITY.md, USER.md, SOUL.md
  security.level != "unrestricted" ? DIR_SCOPE_PROMPT : "",
  multiparty ? SILENT_REPLY_PROMPT : "",            # NO_REPLY rules
]
```

CLAUDE.md is intentionally **not** included — Claude Code auto-discovers it from cwd
(`/home/hans/claudeclaw`) so the project + user CLAUDE.md load natively. Avoids duplication
and gives free hot-reload on file changes.

Changes to any of the above components require service restart. Channel-context-dependent
content (e.g. SILENT_REPLY_PROMPT) is decided at spawn time from `sessions.json[entry].multiparty`.

## Permissions

Direct port of current `buildSecurityArgs()` (src/runner.ts:318). Read from
`settings.security` and apply as CLI flags at session spawn:

```
always:           --dangerously-skip-permissions
security.level:
  locked          --tools Read,Grep,Glob
  strict          --disallowedTools Bash,WebSearch,WebFetch
  moderate        (no extra flags, scoped by DIR_SCOPE_PROMPT)
  unrestricted    (no extra flags, no scoping)
allowedTools:     --allowedTools <space-joined>
disallowedTools:  --disallowedTools <space-joined>
```

`--dangerously-skip-permissions` triggers a one-time bypass-permissions warning the very
first time a user runs Claude Code on this machine. After acceptance, the choice is
remembered. Init-watch handles it.

## Init Watch

On every tmux spawn of `claude`, the daemon polls `tmux capture-pane -p` until it sees one of:

### Ready signal

```
────────────...
❯ 
────────────...
  ⏵⏵ <permission-mode label>
```

Three horizontal-rule lines + `❯` cursor + permission indicator visible together.
Once detected: channel state transitions spawning → idle.

### Known prompt patterns

| Pattern | Response | When |
|---------|----------|------|
| `WARNING: Claude Code running in Bypass Permissions mode` + `❯ 1. No, exit  /  2. Yes, I accept` | Down, Enter | First-ever run on machine |
| `Compact?` + `(y/N)` | `y` + Enter (or per settings) | Resume of long session |
| `Continue?` | Enter | Various |
| `[1] ... [2] ...` (numbered choice) | `1` + Enter (or smarter logic) | Various |

### Unknown prompt fallback

If non-ready content stays unchanged for >15s, log full pane content + send Esc. If still
non-ready after another 5s, mark spawn failed and surface error.

## Cross-Session Messaging

Existing `src/inbox.ts` design is preserved:
- `appendInbox(key, entry)` writes to `.claude/claudeclaw/inbox/<key>.jsonl`
- `drainInbox(key)` reads + unlinks, returns entries
- Channel daemon calls `drainInbox` before pasting each user prompt; formatted inbox block
  is prepended to the user message before paste.

The `trigger.ts` HTTP API (`/api/send`, `/api/trigger`) continues to route through this.
Difference: instead of calling `runUserMessage(threadId, ...)` directly, the trigger
becomes "deliver to channel's inbox + enqueue a synthetic user message into channel queue."

## Open Issues

1. **Compact dialog**: Could not reproduce in spike — needs verification with a heavy
   session before launch. The pattern in the table above is a guess.
2. **Streaming-feel UX**: Spec emits one message per jsonl entry. For very long text
   responses this means a few-second delay between user prompt and any reply. Acceptable
   per Hans; if it ever feels too slow, consider pane-tail for live previews.
3. **`--remote-control` flag**: Not investigated. Could potentially give us a programmatic
   event stream instead of jsonl-tail. Worth a 30-min spike before committing implementation.
4. **Tool result posting**: Currently spec says "skip". May want to post a truncated
   `tool_result` summary so the user sees what the tool returned, especially for Bash
   commands that produce visible output.
5. **Thinking blocks**: Currently spec says "skip". User-facing visibility of thinking
   could be useful in multi-party channels (transparency) but distracting in 1:1.

## Appendix: Spike Findings (verbatim)

Spike conducted 2026-05-14 in this repo's cwd.

- ✅ `--session-id <uuid>` creates new session deterministically
- ✅ `--resume <uuid>` resumes cleanly; `--append-system-prompt` accepted in both modes
- ✅ Multi-line `tmux load-buffer + paste-buffer -p` works; auto-continuation indent correct
- ✅ `Enter` submits; `Esc` interrupts mid-stream cleanly
- ✅ bypassPermissions warning appears once per (machine, user), not per session
- ✅ jsonl entries flush at logical boundaries (tool_use / end_turn), never per-token
- ✅ Long text reply (227 chars): 9-second silence then single-batch 4-entry flush
- ✅ Tool-use turn: 2 flush events (pre-tool segment + post-tool text), different msg_ids
- ✅ Each jsonl line is a complete JSON object; safe to parse on `tail -F`
- ✅ Ready-state pane marker: triple `────` lines + `❯` + permission indicator
- ❓ Compact / migration / sync dialogs: not reproduced; handled by pattern table + fallback
