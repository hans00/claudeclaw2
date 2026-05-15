/**
 * ClaudeClaw v2 main entry.
 *
 * Wires the platform connector(s) + per-channel state machines and routes
 * inbound messages to lazily-spawned tmux-hosted `claude` agents. Restores
 * existing sessions on startup so daemon restarts don't reset conversations.
 */
import { randomUUID } from "crypto";
import { mkdir, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { Channel, type ChannelCallbacks, type ReplyTarget } from "./channel";
import { loadSettings, type Settings } from "./config";
import { CronScheduler, type Job } from "./jobs";
import { HeartbeatScheduler, parseTimezoneOffset } from "./heartbeat";
import { StatuslineWriter } from "./statusline";
import { backupV1GlobalIfExists, migrateFromV1 } from "./migrate";
import { extractReactions } from "./reactions";

const PID_FILE = join(".claude", "claudeclaw", "daemon.pid");
import {
  GLOBAL_KEY,
  loadSessions,
  touchActivity,
  tmuxNameFor,
  upsertSession,
  type ChannelSession,
} from "./sessions";
import { TelegramPlatform, type InboundMessage, type TelegramRouter } from "./platforms/telegram";
import { composePromptWithAttachments } from "./attachments";
import { DiscordPlatform, type DiscordInbound, type DiscordRouter } from "./platforms/discord";
import { SlackPlatform, type SlackInbound, type SlackRouter } from "./platforms/slack";
import { WebServer, type SessionView, type WebDaemonView } from "./web";

class Daemon {
  private channels = new Map<string, Channel>();
  private telegram: TelegramPlatform | null = null;
  private discord: DiscordPlatform | null = null;
  private slack: SlackPlatform | null = null;
  private cron: CronScheduler | null = null;
  private heartbeat: HeartbeatScheduler | null = null;
  private statusline: StatuslineWriter | null = null;
  private web: WebServer | null = null;
  private projectDir = process.cwd();
  private startedAt = Date.now();
  private shuttingDown = false;

  constructor(private settings: Settings) {}

  async start(): Promise<void> {
    await this.writePidFile();
    await backupV1GlobalIfExists();
    await migrateFromV1();
    await this.restoreSessions();
    await this.startTelegram();
    await this.startDiscord();
    await this.startSlack();
    this.startCron();
    this.startHeartbeat();
    this.startStatusline();
    this.startWeb();
    this.installSignalHandlers();
    console.log(`[daemon] ready (project=${this.projectDir})`);
  }

  private startWeb(): void {
    const view: WebDaemonView = {
      projectDir: this.projectDir,
      startedAt: this.startedAt,
      listChannels: () => this.snapshotChannels(),
      resolveChannel: async (target) => {
        const existing = this.channels.get(target);
        if (existing) return existing;
        const meta = deriveKindFromKey(target);
        if (!meta) return null;
        return this.ensureChannel(target, meta.kind, meta.multiparty);
      },
    };
    this.web = new WebServer(this.settings.web, view);
    this.web.start();
  }

  private snapshotChannels(): SessionView[] {
    const result: SessionView[] = [];
    for (const [key, channel] of this.channels.entries()) {
      const session = channel.session;
      result.push({
        channelKey: key,
        kind: session.kind,
        sessionId: session.sessionId,
        multiparty: session.multiparty,
        state: channel.currentState,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
      });
    }
    return result;
  }

  private startStatusline(): void {
    this.statusline = new StatuslineWriter({
      settings: () => this.settings,
      startedAt: () => this.startedAt,
      heartbeatLastFiredAt: () => this.heartbeat?.lastFiredAtMs ?? 0,
      platforms: () => ({
        telegram: !!this.telegram,
        discord: !!this.discord,
        slack: !!this.slack,
        line: false,
      }),
    });
    this.statusline.start();
  }

  private startHeartbeat(): void {
    this.heartbeat = new HeartbeatScheduler({
      config: this.settings.heartbeat,
      timezoneOffsetMinutes: parseTimezoneOffset(this.settings.timezone),
      hooks: {
        fire: async (prompt) => {
          const channel = await this.ensureChannel(GLOBAL_KEY, "global", false);
          if (!channel) return false;
          await channel.handleIncoming({
            text: prompt,
            fromLabel: "heartbeat",
            replyTo: null,
          });
          return true;
        },
        isBusy: () => {
          const ch = this.channels.get(GLOBAL_KEY);
          if (!ch) return false;
          return ch.currentState === "running" || ch.currentState === "interrupting";
        },
      },
    });
    this.heartbeat.start();
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

  private async writePidFile(): Promise<void> {
    await mkdir(dirname(PID_FILE), { recursive: true });
    await writeFile(PID_FILE, String(process.pid), "utf8");
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
      if (session.kind !== "global" && session.kind !== "discord" && session.kind !== "slack") continue;
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

  private async startDiscord(): Promise<void> {
    if (!this.settings.discord.token) {
      console.log("[daemon] discord disabled (no token)");
      return;
    }
    const router: DiscordRouter = {
      handleMessage: (msg) => this.routeDiscord(msg),
    };
    this.discord = new DiscordPlatform({
      config: this.settings.discord,
      router,
    });
    await this.discord.start();
  }

  private async startSlack(): Promise<void> {
    const { appToken, botToken } = this.settings.slack;
    if (!appToken || !botToken) {
      console.log("[daemon] slack disabled (missing tokens)");
      return;
    }
    const router: SlackRouter = {
      handleMessage: (msg) => this.routeSlack(msg),
    };
    this.slack = new SlackPlatform({ config: this.settings.slack, router });
    await this.slack.start();
  }

  private async routeSlack(msg: SlackInbound): Promise<void> {
    const isDM = msg.channelType === "im";
    // v1 parity: messages in a thread get their own session.
    let key: string;
    if (isDM) key = GLOBAL_KEY;
    else if (msg.threadTs && msg.threadTs !== msg.messageTs) {
      // thread_ts == message_ts on the parent message — that's "starting" the
      // thread but isn't itself a thread reply yet. Keep parent on the channel.
      key = `slack:${msg.channelId}:${msg.threadTs}`;
    } else key = `slack:${msg.channelId}`;
    const replyTo: ReplyTarget = {
      platform: "slack",
      channelId: msg.channelId,
      threadTs: msg.threadTs,
      messageTs: msg.messageTs,
    };
    const kind = isDM ? "global" : "slack";
    const multiparty = !isDM;
    const channel = await this.ensureChannel(key, kind, multiparty);
    if (!channel) return;
    await touchActivity(key);
    if (await this.tryHandleCommand(msg.text, channel, replyTo)) return;
    const text = composePromptWithAttachments(msg.text, msg.attachments);
    await channel.handleIncoming({
      text,
      fromLabel: msg.fromName,
      platformMsgId: msg.messageTs,
      replyTo,
    });
  }

  private async routeDiscord(msg: DiscordInbound): Promise<void> {
    const isDM = msg.guildId === null;
    const key = isDM ? GLOBAL_KEY : `discord:${msg.channelId}`;
    const replyTo: ReplyTarget = {
      platform: "discord",
      channelId: msg.channelId,
      messageId: msg.messageId,
    };
    const kind = isDM ? "global" : "discord";
    const multiparty = !isDM;
    const channel = await this.ensureChannel(key, kind, multiparty);
    if (!channel) return;
    await touchActivity(key);
    if (await this.tryHandleCommand(msg.text, channel, replyTo)) return;
    const text = composePromptWithAttachments(msg.text, msg.attachments);
    await channel.handleIncoming({
      text,
      fromLabel: msg.fromName,
      platformMsgId: msg.messageId,
      replyTo,
    });
  }

  private async routeTelegram(msg: InboundMessage): Promise<void> {
    // v1 parity: all Telegram traffic (DM + group) lands on "global".
    const key = GLOBAL_KEY;
    const replyTo: ReplyTarget = {
      platform: "telegram",
      chatId: msg.chatId,
      messageId: msg.messageId,
    };

    const channel = await this.ensureChannel(key, "global", /*multiparty*/ false);
    if (!channel) return;
    await touchActivity(key);
    if (await this.tryHandleCommand(msg.text, channel, replyTo)) return;
    const text = composePromptWithAttachments(msg.text, msg.attachments);
    await channel.handleIncoming({
      text,
      fromLabel: msg.fromName,
      platformMsgId: String(msg.messageId),
      replyTo,
    });
  }

  /**
   * Handle slash-commands that should not reach the agent. Returns true when
   * the message was consumed as a command.
   */
  private async tryHandleCommand(
    raw: string,
    channel: Channel,
    replyTo: ReplyTarget,
  ): Promise<boolean> {
    const cmd = raw.trim();
    if (cmd === "/stop") {
      const state = channel.currentState;
      await channel.userStop();
      const msg =
        state === "running"
          ? "🛑 stopped current turn (queue cleared)"
          : "🛑 nothing was running; queue cleared if any";
      await this.dispatchOutbound(channel.session, msg, replyTo);
      return true;
    }
    return false;
  }

  private async ensureChannel(
    key: string,
    kind: "global" | "discord" | "slack",
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
      defaultModel: this.settings.model,
      agentic: this.settings.agentic,
    });
  }

  private async dispatchOutbound(
    session: ChannelSession,
    text: string,
    replyTo: ReplyTarget,
  ): Promise<void> {
    const { cleanText, reactions } = extractReactions(text);
    if (!replyTo) {
      console.log(`[daemon] [${session.channelKey}] no replyTo — logging only:\n${cleanText.slice(0, 500)}`);
      if (reactions.length) {
        console.log(`[daemon] [${session.channelKey}] reactions (dropped, no target): ${reactions.join(" ")}`);
      }
      return;
    }
    try {
      if (replyTo.platform === "telegram") {
        if (!this.telegram) return;
        if (cleanText) await this.telegram.sendMessage(replyTo.chatId, cleanText);
        if (replyTo.messageId !== undefined && reactions.length > 0) {
          // Telegram replaces (not appends) on each call — send all in one.
          await this.telegram.setReactions(replyTo.chatId, replyTo.messageId, reactions);
        }
      } else if (replyTo.platform === "discord") {
        if (!this.discord) return;
        if (cleanText) await this.discord.sendMessage(replyTo.channelId, cleanText);
        if (replyTo.messageId) {
          for (const emoji of reactions) {
            await this.discord.addReaction(replyTo.channelId, replyTo.messageId, emoji);
          }
        }
      } else if (replyTo.platform === "slack") {
        if (!this.slack) return;
        if (cleanText) await this.slack.sendMessage(replyTo.channelId, cleanText, replyTo.threadTs);
        if (replyTo.messageTs) {
          for (const emoji of reactions) {
            await this.slack.addReaction(replyTo.channelId, replyTo.messageTs, emoji);
          }
        }
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
    this.heartbeat?.stop();
    this.statusline?.stop();
    this.web?.stop();
    if (this.telegram) await this.telegram.stop();
    if (this.discord) await this.discord.stop();
    if (this.slack) await this.slack.stop();
    await unlink(PID_FILE).catch(() => {});
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

function deriveKindFromKey(
  key: string,
): { kind: "global" | "discord" | "slack"; multiparty: boolean } | null {
  if (key === GLOBAL_KEY) return { kind: "global", multiparty: false };
  if (key.startsWith("discord:")) return { kind: "discord", multiparty: true };
  // slack keys may be "slack:<channelId>" or "slack:<channelId>:<threadTs>".
  if (key.startsWith("slack:")) return { kind: "slack", multiparty: true };
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
