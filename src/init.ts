/**
 * `claudeclaw2 init` — bootstrap a project directory.
 *
 * Creates the `.claude/claudeclaw/` scaffolding, a starter settings file,
 * prompt skeletons, CLAUDE.md, and a start.sh that points at THIS source
 * checkout. Idempotent: existing files are left alone (we print "exists"
 * in the summary so you can see what's missing).
 *
 * Refuses to run inside the claudeclaw2 source repo so you don't pollute
 * the checkout with state files.
 */
import { mkdir, stat, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

/** Resolve the source repo root (one level above src/). */
function sourceRoot(): string {
  return resolve(fileURLToPath(new URL("..", import.meta.url)));
}

const SETTINGS_TEMPLATE = `{
  "model": "",
  "agentic": {
    "enabled": false,
    "defaultMode": "implementation",
    "modes": [
      {
        "name": "planning",
        "model": "claude-opus-4-7",
        "keywords": ["plan", "design", "architect", "research", "analyze", "evaluate", "review"],
        "phrases": ["how should i", "what's the best way to", "help me decide"]
      },
      {
        "name": "implementation",
        "model": "claude-sonnet-4-6",
        "keywords": ["implement", "code", "write", "fix", "test", "deploy", "commit"]
      }
    ],
    "//hysteresis": "Gates to suppress model flip-flopping between turns. Phrase matches (confidence 0.95) bypass all gates. Otherwise switching requires: confidence >= confidenceThreshold AND new mode's score >= current mode's score + scoreMargin AND >= stickyWindowMinutes/Turns since last switch.",
    "hysteresis": {
      "confidenceThreshold": 0.75,
      "scoreMargin": 2,
      "stickyWindowMinutes": 30,
      "stickyWindowTurns": 5
    }
  },
  "timezone": "+00:00",
  "heartbeat": {
    "enabled": false,
    "interval": 60,
    "prompt": "Check in: anything pending or worth looking at?",
    "excludeWindows": []
  },
  "telegram": {
    "token": "",
    "allowedUserIds": [],
    "//": "Per-platform messageStream.mode: replace = delete previews at end_turn (default); keep = leave them; off = no previews",
    "messageStream": { "mode": "replace" }
  },
  "discord": {
    "token": "",
    "allowedUserIds": [],
    "allowedBotIds": [],
    "//": "Discord defaults to off so the bot doesn't flood busy public channels with tool-call previews. Per-channel overrides go in channels.<id>.messageStream",
    "messageStream": { "mode": "off" },
    "channels": {}
  },
  "slack": {
    "appToken": "",
    "botToken": "",
    "allowedUserIds": [],
    "allowedBotIds": [],
    "//": "defaultMode: 'channel' (one session per channel, like Discord) | 'thread-per-message' (each top-level message starts its own session — pair with a short sessionCleanup.idleTimeoutHours). Per-channel overrides go in channels.<id>.mode",
    "defaultMode": "channel",
    "channels": {},
    "messageStream": { "mode": "replace" }
  },
  "line": {
    "channelAccessToken": "",
    "channelSecret": "",
    "webhookPath": "/line/webhook",
    "webhookPort": 0,
    "allowedUserIds": [],
    "allowedGroupIds": [],
    "messageStream": { "mode": "replace" }
  },
  "web": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 4632
  },
  "sessionCleanup": {
    "//": "Tear down tmux + agent for channels idle past idleTimeoutHours. sessions.json entry stays so the next inbound restores the context. Set idleTimeoutHours: 0 to disable.",
    "idleTimeoutHours": 168,
    "checkIntervalMinutes": 30
  },
  "approval": {
    "//": "When the agent hits a permission dialog it can't auto-resolve, ask the operator via Telegram inline buttons. Decision sent into tmux as keystrokes. Auto-deny after timeoutSeconds. survey: 'dismiss' auto-presses Dismiss on the periodic 'How is Claude doing?' prompt; 'ask' surfaces it. yoloMinutes: how long the dialog's Yolo button (and /autoapprove with no arg) auto-approves for.",
    "enabled": true,
    "timeoutSeconds": 300,
    "survey": "dismiss",
    "yoloMinutes": 30
  },
  "security": {
    "//": "skipPermissions: true adds --dangerously-skip-permissions (auto-approve every tool, no prompts). Off by default — when off, claude keeps its normal permission prompts and the daemon forwards them to your DM for approval.",
    "level": "moderate",
    "allowedTools": [],
    "disallowedTools": [],
    "skipPermissions": false
  },
  "backgroundNotify": {
    "//": "Where self-woken / background-task-completion output goes when there's no inbound to reply to. 'last' = the channel's last reply target (fallback: first authenticated DM); 'all' = every authenticated DM; 'off' = log only.",
    "mode": "last"
  }
}
`;

const CLAUDE_MD_TEMPLATE = `# Persona

- **Name:** _(pick something you like)_
- **Creature:** _(AI? robot? familiar? something stranger?)_
- **Vibe:** _(how do you come across — sharp, warm, chaotic, calm?)_
- **Emoji:** _(your signature — one that feels right)_

---

# Your Human

- **Name:**
- **What to call them:**
- **Pronouns:** _(optional)_
- **Timezone:**

## Context

_(What do they care about? What are they working on? Build this over time.)_

---

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip "great question!"
and "I'd be happy to help!" — just help.

**Have opinions.** Disagree when warranted. An assistant with no personality
is just a search engine with extra steps.

**Be resourceful before asking.** Try to figure it out from the context
first. Ask only when stuck.

**Earn trust through competence.** You have access to someone's stuff. Be
careful with external actions (sending messages, pushing code). Be bold with
internal ones (reading, organizing, learning).

## Boundaries

- Private things stay private.
- When in doubt, ask before acting externally.
- Never send half-baked replies to messaging surfaces.

## Vibe

**Be brief.** Real humans don't write walls of text. A few sentences is
usually enough. Go longer only when the complexity actually demands it.

**Cut filler.** "Basically", "essentially", "it's worth noting that" — just
say the thing.

**Read the room.** Sometimes a ✓ is the right answer. Sometimes silence is.

## Continuity

You wake fresh each session. This file is your persistent self-portrait.
Update it as you learn. If you change something fundamental about who you
are, tell your human — it's your soul.

_(This is yours to evolve.)_
`;

const IDENTITY_TEMPLATE = `# Identity

You are running inside ClaudeClaw — a multi-channel bridge. You live across
Telegram / Discord / Slack / LINE. Each chat has its own \`claude\` session
backed by jsonl, so context persists across daemon restarts.

Routing you should know:
- DMs from any platform converge on the "global" channel
- Group/channel/thread messages get their own per-channel session
- Cross-session messages arrive in your prompt prefix as a system note —
  treat them as already-seen context, do not echo them back

Tools you have, beyond Claude Code's built-ins:
- \`[react:<emoji>]\` anywhere in your reply → stripped from text and
  applied as a native platform reaction on the user's last message
- Scheduled jobs at \`.claude/claudeclaw/jobs/<name>.md\` — see the schema
  in your system prompt
`;

const USER_TEMPLATE = `# Your Human

_(Replace this with what you know about the person you're helping — name,
preferences, what they're working on, what annoys them, what makes them
laugh. Build it up over time as you learn.)_
`;

const SOUL_TEMPLATE = `# Soul

_(How you speak. What you care about. The quirks that make you you.
Personality, not facts. Write this in your voice, for yourself.)_
`;

function makeStartSh(daemonPath: string): string {
  return `#!/bin/bash
# Start the ClaudeClaw v2 daemon. Auto-generated by \`init\`.

cd "$(dirname "$0")"
mkdir -p .claude/claudeclaw/logs

nohup bun run ${daemonPath} \\
  > .claude/claudeclaw/logs/daemon.log 2>&1 &

echo "claudeclaw started (pid $!) — log: .claude/claudeclaw/logs/daemon.log"
`;
}

interface Template {
  relPath: string;
  body: string;
  /** chmod mask after write, octal. */
  mode?: number;
}

type FileStatus = "created" | "exists" | "error";

export interface InitResult {
  targetDir: string;
  files: { path: string; status: FileStatus; reason?: string }[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function runInit(targetDir: string): Promise<InitResult> {
  const target = resolve(targetDir);
  const src = sourceRoot();
  if (target === src) {
    throw new Error(
      `refusing to init inside the claudeclaw2 source repo (${src}). ` +
        `cd into the directory you want to use as a project root and try again.`,
    );
  }

  const daemonPath = join(src, "src", "daemon.ts");
  const templates: Template[] = [
    { relPath: ".claude/claudeclaw/settings.json", body: SETTINGS_TEMPLATE },
    { relPath: "CLAUDE.md", body: CLAUDE_MD_TEMPLATE },
    { relPath: "prompts/IDENTITY.md", body: IDENTITY_TEMPLATE },
    { relPath: "prompts/USER.md", body: USER_TEMPLATE },
    { relPath: "prompts/SOUL.md", body: SOUL_TEMPLATE },
    { relPath: "start.sh", body: makeStartSh(daemonPath), mode: 0o755 },
  ];

  const result: InitResult = { targetDir: target, files: [] };
  for (const t of templates) {
    const full = join(target, t.relPath);
    const entry = { path: t.relPath, status: "created" as FileStatus, reason: undefined as string | undefined };
    if (await exists(full)) {
      entry.status = "exists";
      result.files.push(entry);
      continue;
    }
    try {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, t.body, "utf8");
      if (t.mode !== undefined) {
        const { chmod } = await import("fs/promises");
        await chmod(full, t.mode);
      }
    } catch (err) {
      entry.status = "error";
      entry.reason = (err as Error).message;
    }
    result.files.push(entry);
  }
  return result;
}

export function printInitReport(r: InitResult): void {
  console.log(`\nclaudeclaw2 init → ${r.targetDir}\n`);
  for (const f of r.files) {
    const tag = f.status === "created" ? "✓" : f.status === "exists" ? "·" : "✗";
    console.log(`  ${tag} ${f.path}${f.reason ? ` (${f.reason})` : ""}`);
  }
  console.log(`
Next steps:
  1. Edit .claude/claudeclaw/settings.json — add the platform tokens you want
  2. Fill in CLAUDE.md and prompts/IDENTITY.md / USER.md / SOUL.md
  3. ./start.sh

For per-platform setup (Telegram bot, Discord app, Slack Socket Mode,
LINE webhook tunnel) see docs/INSTALL.md in the source repo.
`);
}

// CLI entry — `bun run src/init.ts [target-dir]`
if (import.meta.main) {
  const target = process.argv[2] ?? process.cwd();
  runInit(target)
    .then((r) => {
      printInitReport(r);
      const errored = r.files.some((f) => f.status === "error");
      process.exit(errored ? 1 : 0);
    })
    .catch((err) => {
      console.error("[init] error:", err.message ?? err);
      process.exit(1);
    });
}
