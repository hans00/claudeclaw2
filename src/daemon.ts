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
import type { SourceInfo } from "./channel";
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
import { LinePlatform, type LineInbound, type LineRouter } from "./platforms/line";
import { WebServer, type SessionView, type WebDaemonView } from "./web";

class Daemon {
  private channels = new Map<string, Channel>();
  /** Per-channel outbound state for edit-in-place: while consecutive
   *  assistant-text events share the same Claude msg_id, we keep editing
   *  the same platform message instead of sending each segment as its own
   *  bubble. Reset on tool-use, turn-end, or when a new msg_id arrives. */
  private outbound = new Map<string, OutboundState>();
  private telegram: TelegramPlatform | null = null;
  private discord: DiscordPlatform | null = null;
  private slack: SlackPlatform | null = null;
  private line: LinePlatform | null = null;
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
    await this.startLine();
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
        line: !!this.line,
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
      if (
        session.kind !== "global" &&
        session.kind !== "discord" &&
        session.kind !== "slack" &&
        session.kind !== "line"
      ) continue;
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

  private async startLine(): Promise<void> {
    const c = this.settings.line;
    if (!c.channelAccessToken || !c.channelSecret || c.webhookPort <= 0) {
      console.log("[daemon] line disabled (no tokens or webhookPort=0)");
      return;
    }
    const router: LineRouter = {
      handleMessage: (msg) => this.routeLine(msg),
    };
    this.line = new LinePlatform({ config: c, router });
    await this.line.start();
  }

  private async routeLine(msg: LineInbound): Promise<void> {
    const isDM = msg.sourceType === "user";
    const key = isDM ? GLOBAL_KEY : `line:${msg.sourceId}`;
    const replyTo: ReplyTarget = {
      platform: "line",
      to: msg.sourceId,
      messageId: msg.messageId,
    };
    const kind = isDM ? "global" : "line";
    const multiparty = !isDM;
    const channel = await this.ensureChannel(key, kind, multiparty);
    if (!channel) return;
    await touchActivity(key);
    if (await this.tryHandleCommand(msg.text, channel, replyTo)) return;
    const text = composePromptWithAttachments(msg.text, msg.attachments);
    const source: SourceInfo = {
      platform: "line",
      name: msg.fromName,
      id: msg.fromUserId,
    };
    await channel.handleIncoming({
      text,
      fromLabel: msg.fromName,
      platformMsgId: msg.messageId,
      replyTo,
      source,
    });
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
    const source: SourceInfo = {
      platform: "discord",
      name: msg.fromName,
      username: msg.fromUsername,
      id: msg.fromUserId,
    };
    await channel.handleIncoming({
      text,
      fromLabel: msg.fromName,
      platformMsgId: msg.messageId,
      replyTo,
      source,
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
    const source: SourceInfo = {
      platform: "telegram",
      name: msg.fromName,
      username: msg.fromUsername,
      id: String(msg.fromUserId),
    };
    await channel.handleIncoming({
      text,
      fromLabel: msg.fromName,
      platformMsgId: String(msg.messageId),
      replyTo,
      source,
    });
  }

  /**
   * Handle slash-commands that should not reach the agent. Returns true when
   * the message was consumed as a command.
   *
   * Why this exists: Claude Code's UI-only slash commands (/context, /status,
   * /clear, ...) operate on the local TUI and never write to the session
   * jsonl. Pasting them into tmux works — the TUI panel updates — but the
   * daemon never sees the response, so nothing gets posted to the platform.
   * For those we render an equivalent summary from daemon state ourselves.
   * Skill commands and other model-bound slash commands DO write jsonl when
   * they fire, so they pass through unchanged.
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
    if (cmd === "/status") {
      const msg = this.summarizeStatus(channel);
      await this.dispatchOutbound(channel.session, msg, replyTo);
      return true;
    }
    return false;
  }

  private summarizeStatus(channel: Channel): string {
    const uptimeSec = Math.round((Date.now() - this.startedAt) / 1000);
    const uptimeStr = uptimeSec < 60
      ? `${uptimeSec}s`
      : uptimeSec < 3600
        ? `${Math.floor(uptimeSec / 60)}m`
        : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;
    let running = 0;
    for (const ch of this.channels.values()) {
      if (ch.currentState === "running") running++;
    }
    const s = channel.session;
    const platforms: string[] = [];
    if (this.telegram) platforms.push("telegram");
    if (this.discord) platforms.push("discord");
    if (this.slack) platforms.push("slack");
    if (this.line) platforms.push("line");
    return [
      `🦞 claudeclaw v2`,
      `daemon    pid ${process.pid} · up ${uptimeStr}`,
      `platforms ${platforms.join(", ") || "(none)"}`,
      `channels  ${this.channels.size} (${running} running)`,
      ``,
      `this channel`,
      `  key     ${s.channelKey}`,
      `  kind    ${s.kind}${s.multiparty ? " · multiparty" : ""}`,
      `  state   ${channel.currentState}`,
      `  session ${s.sessionId.slice(0, 8)}`,
    ].join("\n");
  }

  private async ensureChannel(
    key: string,
    kind: "global" | "discord" | "slack" | "line",
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
      onAssistantText: async (text, replyTo, claudeMsgId) => {
        await this.dispatchAssistantText(session, text, replyTo, claudeMsgId);
      },
      onToolUse: async (toolName, input, replyTo) => {
        // Tool messages always start a new bubble — edit-in-place doesn't
        // span tool calls, otherwise the message order looks confusing.
        this.outbound.delete(session.channelKey);
        await this.dispatchOutbound(session, formatToolStatus(toolName, input), replyTo);
      },
      onTurnEnd: () => {
        this.outbound.delete(session.channelKey);
      },
      onTyping: async (replyTo) => {
        await this.dispatchTyping(replyTo);
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
      timezoneOffsetMinutes: parseTimezoneOffset(this.settings.timezone),
    });
  }

  private async dispatchTyping(replyTo: ReplyTarget): Promise<void> {
    if (!replyTo) return;
    try {
      if (replyTo.platform === "telegram") await this.telegram?.sendTypingAction(replyTo.chatId);
      else if (replyTo.platform === "discord") await this.discord?.sendTypingAction(replyTo.channelId);
      else if (replyTo.platform === "slack") await this.slack?.sendTypingAction(replyTo.channelId);
      else if (replyTo.platform === "line") await this.line?.sendTypingAction(replyTo.to);
    } catch (err) {
      console.error(`[daemon] typing dispatch failed:`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * Edit-in-place when the assistant emits consecutive text segments with
   * the same Claude msg_id; otherwise send a new platform message and
   * remember the id for the next segment.
   */
  private async dispatchAssistantText(
    session: ChannelSession,
    text: string,
    replyTo: ReplyTarget,
    claudeMsgId: string | undefined,
  ): Promise<void> {
    const { cleanText, reactions } = extractReactions(text);
    if (!replyTo) {
      if (cleanText) {
        console.log(`[daemon] [${session.channelKey}] no replyTo — logging only:\n${cleanText.slice(0, 500)}`);
      }
      return;
    }
    if (!cleanText && reactions.length === 0) return;

    if (cleanText) {
      const state = this.outbound.get(session.channelKey);
      const sameBubble = !!claudeMsgId && state?.claudeMsgId === claudeMsgId && !!state.platformMsgId;
      if (sameBubble && state) {
        const combined = `${state.accumulated}\n\n${cleanText}`;
        const ok = await this.platformEdit(replyTo, state.platformMsgId!, combined);
        if (ok) {
          state.accumulated = combined;
        } else {
          // Edit failed (text too long, platform refused, etc) — fall back
          // to a fresh bubble for this segment.
          const newId = await this.platformSend(replyTo, cleanText);
          this.outbound.set(session.channelKey, {
            claudeMsgId,
            platformMsgId: newId,
            accumulated: cleanText,
          });
        }
      } else {
        const newId = await this.platformSend(replyTo, cleanText);
        this.outbound.set(session.channelKey, {
          claudeMsgId,
          platformMsgId: newId,
          accumulated: cleanText,
        });
      }
    }

    await this.applyReactions(replyTo, reactions);
  }

  private async platformSend(replyTo: ReplyTarget, text: string): Promise<string | undefined> {
    if (!replyTo) return undefined;
    try {
      if (replyTo.platform === "telegram") return await this.telegram?.sendMessage(replyTo.chatId, text);
      if (replyTo.platform === "discord") return await this.discord?.sendMessage(replyTo.channelId, text);
      if (replyTo.platform === "slack") return await this.slack?.sendMessage(replyTo.channelId, text, replyTo.threadTs);
      if (replyTo.platform === "line") return await this.line?.pushText(replyTo.to, text);
    } catch (err) {
      console.error(`[daemon] platformSend failed:`, err instanceof Error ? err.message : err);
    }
    return undefined;
  }

  private async platformEdit(replyTo: ReplyTarget, msgId: string, text: string): Promise<boolean> {
    if (!replyTo) return false;
    try {
      if (replyTo.platform === "telegram") return (await this.telegram?.editMessage(replyTo.chatId, msgId, text)) ?? false;
      if (replyTo.platform === "discord") return (await this.discord?.editMessage(replyTo.channelId, msgId, text)) ?? false;
      if (replyTo.platform === "slack") return (await this.slack?.editMessage(replyTo.channelId, msgId, text)) ?? false;
      if (replyTo.platform === "line") return false; // line has no edit endpoint
    } catch (err) {
      console.error(`[daemon] platformEdit failed:`, err instanceof Error ? err.message : err);
    }
    return false;
  }

  private async applyReactions(replyTo: ReplyTarget, reactions: string[]): Promise<void> {
    if (!replyTo || reactions.length === 0) return;
    try {
      if (replyTo.platform === "telegram" && replyTo.messageId !== undefined) {
        await this.telegram?.setReactions(replyTo.chatId, replyTo.messageId, reactions);
      } else if (replyTo.platform === "discord" && replyTo.messageId) {
        for (const e of reactions) await this.discord?.addReaction(replyTo.channelId, replyTo.messageId, e);
      } else if (replyTo.platform === "slack" && replyTo.messageTs) {
        for (const e of reactions) await this.slack?.addReaction(replyTo.channelId, replyTo.messageTs, e);
      } else if (replyTo.platform === "line" && replyTo.messageId) {
        for (const e of reactions) await this.line?.sendReaction(replyTo.messageId, e);
      }
    } catch (err) {
      console.error(`[daemon] applyReactions failed:`, err instanceof Error ? err.message : err);
    }
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
      } else if (replyTo.platform === "line") {
        if (!this.line) return;
        if (cleanText) await this.line.pushText(replyTo.to, cleanText);
        if (replyTo.messageId) {
          for (const emoji of reactions) {
            await this.line.sendReaction(replyTo.messageId, emoji);
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
    if (this.line) await this.line.stop();
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

interface OutboundState {
  /** Claude Code message.id whose segments we're accumulating. */
  claudeMsgId: string | undefined;
  /** Platform-side id of the message we'd edit (string for portability). */
  platformMsgId: string | undefined;
  /** Combined text we've sent so far for this bubble; basis for next edit. */
  accumulated: string;
}

function deriveKindFromKey(
  key: string,
): { kind: "global" | "discord" | "slack" | "line"; multiparty: boolean } | null {
  if (key === GLOBAL_KEY) return { kind: "global", multiparty: false };
  if (key.startsWith("discord:")) return { kind: "discord", multiparty: true };
  if (key.startsWith("slack:")) return { kind: "slack", multiparty: true };
  if (key.startsWith("line:")) return { kind: "line", multiparty: true };
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
