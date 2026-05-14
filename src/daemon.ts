/**
 * ClaudeClaw v2 main entry.
 *
 * Wires the platform connector(s) + per-channel state machines and routes
 * inbound messages to lazily-spawned tmux-hosted `claude` agents. Restores
 * existing sessions on startup so daemon restarts don't reset conversations.
 */
import { randomUUID } from "crypto";
import { Channel, type ChannelCallbacks, type ReplyTarget } from "./channel";
import { loadSettings, type Settings } from "./config";
import { CronScheduler, type Job } from "./jobs";
import { backupV1GlobalIfExists, migrateFromV1 } from "./migrate";
import {
  GLOBAL_KEY,
  loadSessions,
  touchActivity,
  tmuxNameFor,
  upsertSession,
  type ChannelSession,
} from "./sessions";
import { TelegramPlatform, type InboundMessage, type TelegramRouter } from "./platforms/telegram";

class Daemon {
  private channels = new Map<string, Channel>();
  private telegram: TelegramPlatform | null = null;
  private cron: CronScheduler | null = null;
  private projectDir = process.cwd();
  private shuttingDown = false;

  constructor(private settings: Settings) {}

  async start(): Promise<void> {
    await backupV1GlobalIfExists();
    await migrateFromV1();
    await this.restoreSessions();
    await this.startTelegram();
    this.startCron();
    this.installSignalHandlers();
    console.log(`[daemon] ready (project=${this.projectDir})`);
  }

  private startCron(): void {
    this.cron = new CronScheduler({
      fire: (job) => this.fireCronJob(job),
    });
    this.cron.start();
  }

  private async fireCronJob(job: Job): Promise<void> {
    const meta = deriveKindFromKey(job.target);
    if (!meta) {
      console.error(`[daemon] cron job "${job.name}": unsupported target "${job.target}"`);
      return;
    }
    const channel = await this.ensureChannel(job.target, meta.kind, meta.multiparty);
    if (!channel) return;
    await touchActivity(job.target);
    await channel.handleIncoming({
      text: job.body,
      fromLabel: `cron:${job.name}`,
      replyTo: job.replyTo,
    });
  }

  private async restoreSessions(): Promise<void> {
    const persisted = await loadSessions();
    const keys = Object.keys(persisted);
    if (keys.length === 0) {
      console.log("[daemon] no persisted sessions to restore");
      return;
    }
    console.log(`[daemon] restoring ${keys.length} session(s)...`);
    for (const [key, session] of Object.entries(persisted)) {
      // MVP: restore global + discord:* entries. Slack arrives later.
      if (session.kind !== "global" && session.kind !== "discord") continue;
      const channel = this.makeChannel(session);
      this.channels.set(key, channel);
      try {
        await channel.start({ resume: true });
        console.log(`[daemon] restored ${key} → ${session.tmuxSession}`);
      } catch (err) {
        console.error(`[daemon] failed to restore ${key}:`, err);
      }
    }
  }

  private async startTelegram(): Promise<void> {
    if (!this.settings.telegram.token) {
      console.log("[daemon] telegram disabled (no token)");
      return;
    }
    const router: TelegramRouter = {
      handleMessage: (msg) => this.routeTelegram(msg),
    };
    this.telegram = new TelegramPlatform({
      config: this.settings.telegram,
      pollSeconds: this.settings.telegramPollSeconds,
      router,
    });
    await this.telegram.start();
  }

  private async routeTelegram(msg: InboundMessage): Promise<void> {
    // v1 parity: all Telegram traffic (DM + group) lands on "global".
    const key = GLOBAL_KEY;
    const replyTo: ReplyTarget = { platform: "telegram", chatId: msg.chatId };

    const channel = await this.ensureChannel(key, "global", /*multiparty*/ false);
    if (!channel) return;
    await touchActivity(key);
    await channel.handleIncoming({
      text: msg.text,
      fromLabel: msg.fromName,
      platformMsgId: String(msg.messageId),
      replyTo,
    });
  }

  private async ensureChannel(
    key: string,
    kind: "global" | "discord",
    multiparty: boolean,
  ): Promise<Channel | null> {
    let channel = this.channels.get(key);
    if (channel) return channel;
    const now = new Date().toISOString();
    const session: ChannelSession = {
      kind,
      channelKey: key,
      sessionId: randomUUID(),
      tmuxSession: tmuxNameFor(key),
      multiparty,
      createdAt: now,
      lastActivityAt: now,
    };
    await upsertSession(session);
    channel = this.makeChannel(session);
    this.channels.set(key, channel);
    console.log(`[daemon] spawning new channel ${key} (multiparty=${multiparty})`);
    try {
      await channel.start({ resume: false });
    } catch (err) {
      console.error(`[daemon] failed to start ${key}:`, err);
      this.channels.delete(key);
      return null;
    }
    return channel;
  }

  private makeChannel(session: ChannelSession): Channel {
    const callbacks: ChannelCallbacks = {
      onAssistantText: async (text, replyTo) => {
        await this.dispatchOutbound(session, text, replyTo);
      },
      onToolUse: async (toolName, input, replyTo) => {
        await this.dispatchOutbound(session, formatToolStatus(toolName, input), replyTo);
      },
      onError: (err) => {
        console.error(`[channel ${session.channelKey}] error:`, err.message);
      },
    };
    return new Channel({
      session,
      security: this.settings.security,
      projectDir: this.projectDir,
      callbacks,
    });
  }

  private async dispatchOutbound(
    session: ChannelSession,
    text: string,
    replyTo: ReplyTarget,
  ): Promise<void> {
    if (!replyTo) {
      console.log(`[daemon] [${session.channelKey}] no replyTo — logging only:\n${text.slice(0, 500)}`);
      return;
    }
    try {
      if (replyTo.platform === "telegram") {
        if (!this.telegram) return;
        await this.telegram.sendMessage(replyTo.chatId, text);
      } else if (replyTo.platform === "discord") {
        console.warn(`[daemon] discord outbound not implemented yet (chan=${replyTo.channelId})`);
      }
    } catch (err) {
      console.error(`[daemon] dispatch failed for ${session.channelKey}:`, err);
    }
  }

  private installSignalHandlers(): void {
    const stop = (sig: string) => {
      void this.shutdown(sig);
    };
    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGTERM", () => stop("SIGTERM"));
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    console.log(`[daemon] shutting down (${reason})...`);
    this.cron?.stop();
    if (this.telegram) await this.telegram.stop();
    // Note: we deliberately do NOT kill tmux sessions on shutdown — they
    // outlive the daemon so context is preserved across restarts. Use
    // `tmux kill-server` or a separate teardown command for full cleanup.
    for (const channel of this.channels.values()) {
      try {
        channel["tailer"]?.stop?.();
      } catch {}
    }
    process.exit(0);
  }
}

function deriveKindFromKey(key: string): { kind: "global" | "discord"; multiparty: boolean } | null {
  if (key === GLOBAL_KEY) return { kind: "global", multiparty: false };
  if (key.startsWith("discord:")) return { kind: "discord", multiparty: true };
  return null;
}

function formatToolStatus(toolName: string, input: unknown): string {
  let summary: string;
  try {
    if (typeof input === "string") {
      summary = input;
    } else if (input && typeof input === "object") {
      const obj = input as Record<string, unknown>;
      if (typeof obj.command === "string") summary = obj.command;
      else if (typeof obj.description === "string") summary = obj.description;
      else if (typeof obj.file_path === "string") summary = obj.file_path;
      else summary = JSON.stringify(input);
    } else {
      summary = "";
    }
  } catch {
    summary = "";
  }
  if (summary.length > 200) summary = summary.slice(0, 199) + "…";
  return summary ? `🛠 ${toolName}: ${summary}` : `🛠 ${toolName}`;
}

async function main(): Promise<void> {
  const settings = await loadSettings();
  const daemon = new Daemon(settings);
  await daemon.start();
}

main().catch((err) => {
  console.error("[daemon] fatal:", err);
  process.exit(1);
});
