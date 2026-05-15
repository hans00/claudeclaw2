---
description: Migrate from v1 ClaudeClaw to v2 (stops v1, starts v2, verifies state carried over)
---

Walk the user through migrating a v1 install to v2.

## Phase 0 — Detect v1

1. Check for v1 markers in `.claude/claudeclaw/`:
   ```bash
   ls .claude/claudeclaw/
   cat .claude/claudeclaw/session.json 2>/dev/null
   jq -r 'keys[]' .claude/claudeclaw/sessions.json 2>/dev/null | head -5
   ```
   - If `session.json` exists AND/OR `sessions.json` has a `threads` key, you have v1 state to migrate.
   - If neither exists, suggest `/claudeclaw2:init` instead.

## Phase 1 — Stop v1

2. Find and stop the running v1 daemon:
   ```bash
   pid=$(cat .claude/claudeclaw/daemon.pid 2>/dev/null)
   if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
     kill -TERM "$pid"
     for i in $(seq 1 10); do sleep 1; kill -0 "$pid" 2>/dev/null || break; done
   fi
   ```
   Wait until the pid is gone before continuing. If it won't stop, ask the user before sending SIGKILL.

## Phase 2 — Update launcher

3. Show the user their existing `start.sh` and propose a v2-flavoured replacement:
   ```bash
   #!/bin/bash
   cd "$(dirname "$0")"
   mkdir -p .claude/claudeclaw/logs
   nohup bun run ${CLAUDE_PLUGIN_ROOT}/src/daemon.ts \
     > .claude/claudeclaw/logs/daemon.log 2>&1 &
   ```
   Use Edit to patch their file in place. Do NOT silently overwrite — show the diff and ask.

## Phase 3 — First boot (auto-migrate)

4. Run the new `./start.sh`. Wait ~6 seconds.

5. `tail -n 40 .claude/claudeclaw/logs/daemon.log`. Confirm you see:
   - `[migrate] backed up v1 threads file → .claude/claudeclaw/sessions.json.v1-backup`
   - `[migrate] migrated N entries:` with the channels listed
   - `[daemon] restored ... → claudeclaw-...`
   - `[daemon] ready ...`

6. If `[migrate] skipping: v2 sessions.json already populated` shows up, migration was already done in a previous boot — that's fine, just verify the channels are restored.

## Phase 4 — Verify

7. Check tmux for the restored sessions:
   ```bash
   tmux ls | grep claudeclaw-
   ```

8. Hit the dashboard:
   ```bash
   curl -s http://127.0.0.1:4632/api/sessions | python3 -m json.tool
   ```
   Confirm the expected channels are there with correct kind (global / discord:*).

9. Tell the user to send a message from one of the migrated platforms and verify the reply comes back.

## Phase 5 — Aftercare

10. Mention to the user:
    - Their v1 settings file is preserved — v2 reads a compatible subset.
    - `.claude/claudeclaw/{session.json,sessions.json}.v1-backup` files are kept for rollback (see `docs/MIGRATE.md` for the procedure).
    - v1 plugin can be removed once they're happy.
    - Features not yet ported are listed in `docs/TODO.md` (whisper transcription, line bot, web history viewer).

If anything in phases 3–4 fails, do NOT auto-rollback — surface the failure to the user and let them decide. The `.v1-backup` files are still there.
