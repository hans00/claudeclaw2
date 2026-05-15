/**
 * ClaudeClaw v2 main entry.
 *
 * Wires the platform connector(s) + per-channel state machines and routes
 * inbound messages to lazily-spawned tmux-hosted `claude` agents. Restores
 * existing sessions on startup so daemon restarts don't reset conversations.
 */
import { randomUUID } from "crypto";
import { watch } from "fs";
import { mkdir, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { Channel, type ChannelCallbacks, type ReplyTarget } from "./channel";
import { loadSettings, type MessageStreamMode, type Settings } from "./config";
import { CronScheduler, type Job } from "./jobs";
import { composeHeartbeatPrompt, HeartbeatScheduler, loadHeartbeatTemplate, parseTimezoneOffset } from "./heartbeat";
import type { SourceInfo } from "./channel";
import { StatuslineWriter } from "./statusline";
import { backupV1GlobalIfExists, migrateFromV1 } from "./migrate";
import { extractReactions } from "./reactions";
import { isSilentReplyText, stripSilentToken } from "./silent";
import { formatToolStatus } from "./tool-display";

const PID_FILE = join(".claude", "claudeclaw", "daemon.pid");
const SETTINGS_PATH = join(".claude", "claudeclaw", "settings.json");
import {
  GLOBAL_KEY,
  loadSessions,
  saveSessions,
  touchActivity,
  tmuxNameFor,
  upsertSession,
  type ChannelSession,
  type SessionMap,
} from "./sessions";
import { renameSession } from "./tmux";
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
  /** Per-channel list of preview bubbles (reasoning/tool/intermediate text)
   *  that get deleted at turn-end when settings.messageStream.mode = "replace".
   *  The currently-active bubble in `outbound` is NOT in this list — it
   *  becomes a preview only when superseded by a new bubble. */
  private previews = new Map<string, Array<{ replyTo: ReplyTarget; platformMsgId: string }>>();
  private telegram: TelegramPlatform | null = null;
  private discord: DiscordPlatform | null = null;
  private slack: SlackPlatform | null = null;
  private line: LinePlatform | null = null;
  private cron: CronScheduler | null = null;
  private heartbeat: HeartbeatScheduler | null = null;
  private statusline: StatuslineWriter | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
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
    this.startSessionCleanup();
    this.watchSettings();
    this.installSignalHandlers();
    console.log(`[daemon] ready (project=${this.projectDir})`);
  }

  /**
   * Watch settings.json for changes (debounced) and trigger a hot-reload.
   * Also responds to SIGHUP — installed in installSignalHandlers().
   */
  private watchSettings(): void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      watch(SETTINGS_PATH, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void this.reloadSettings("file change");
        }, 200);
      });
      console.log("[daemon] watching settings.json for changes");
    } catch (err) {
      console.warn("[daemon] could not watch settings.json:", err);
    }
  }

  /**
   * Re-read settings.json and push live-mutable subsets into the running
   * subsystems. Logs a warning for fields that need a daemon restart.
   */
  async reloadSettings(reason: string): Promise<void> {
    let next: Settings;
    try {
      next = await loadSettings();
    } catch (err) {
      console.error(`[daemon] reload failed: ${(err as Error).message}`);
      return;
    }
    const prev = this.settings;
    console.log(`[daemon] reloading settings (${reason})`);

    const cantChange: string[] = [];
    if (prev.telegram.token !== next.telegram.token) cantChange.push("telegram.token");
    if (prev.discord.token !== next.discord.token) cantChange.push("discord.token");
    if (prev.slack.appToken !== next.slack.appToken || prev.slack.botToken !== next.slack.botToken) {
      cantChange.push("slack.*Token");
    }
    if (
      prev.line.channelAccessToken !== next.line.channelAccessToken ||
      prev.line.channelSecret !== next.line.channelSecret ||
      prev.line.webhookPort !== next.line.webhookPort
    ) {
      cantChange.push("line.*");
    }
    if (
      prev.web.enabled !== next.web.enabled ||
      prev.web.host !== next.web.host ||
      prev.web.port !== next.web.port
    ) {
      cantChange.push("web");
    }
    if (prev.model !== next.model) cantChange.push("model (default — affects only new sessions)");
    if (cantChange.length > 0) {
      console.warn(`[daemon] these settings need a restart to take effect: ${cantChange.join(", ")}`);
    }

    this.settings = next;

    // Channels: agentic + timezone are live-mutable per channel.
    const tz = parseTimezoneOffset(next.timezone);
    for (const channel of this.channels.values()) {
      channel.updateRuntime({ agentic: next.agentic, timezoneOffsetMinutes: tz });
    }

    // Heartbeat: easiest to rebuild — captures config at constructor time.
    if (
      JSON.stringify(prev.heartbeat) !== JSON.stringify(next.heartbeat) ||
      prev.timezone !== next.timezone
    ) {
      console.log("[daemon] heartbeat config changed — rebuilding scheduler");
      this.heartbeat?.stop();
      this.startHeartbeat();
    }

    // Cron jobs are reloaded per-tick from disk, no action needed.
    // Statusline reads settings via a getter, picks up changes automatically.
    // Per-channel discord rules (settings.discord.channels) are consulted on
    // each inbound, also automatic.

    console.log(`[daemon] reload done`);
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

  /**
   * Periodically tear down tmux sessions whose channel has been idle past
   * settings.sessionCleanup.idleTimeoutHours. The sessions.json entry stays
   * so the next inbound restores the conversation via `claude --resume`.
   */
  private startSessionCleanup(): void {
    const cfg = this.settings.sessionCleanup;
    if (cfg.idleTimeoutHours <= 0 || cfg.checkIntervalMinutes <= 0) {
      console.log("[daemon] session cleanup disabled");
      return;
    }
    // Run once on start to catch sessions that were already idle when we
    // booted, then on the configured interval.
    void this.cleanupIdleSessions();
    this.cleanupTimer = setInterval(
      () => void this.cleanupIdleSessions(),
      cfg.checkIntervalMinutes * 60_000,
    );
    console.log(
      `[daemon] session cleanup scheduler: idleTimeout=${cfg.idleTimeoutHours}h, ` +
        `check every ${cfg.checkIntervalMinutes}m`,
    );
  }

  private async cleanupIdleSessions(): Promise<void> {
    const timeoutMs = this.settings.sessionCleanup.idleTimeoutHours * 3_600_000;
    if (timeoutMs <= 0) return;
    const now = Date.now();
    const candidates: Array<{ key: string; ageMs: number }> = [];
    for (const [key, channel] of this.channels.entries()) {
      if (channel.currentState !== "idle") continue;
      const lastTs = Date.parse(channel.session.lastActivityAt);
      if (!Number.isFinite(lastTs)) continue;
      const age = now - lastTs;
      if (age >= timeoutMs) candidates.push({ key, ageMs: age });
    }
    if (candidates.length === 0) return;
    console.log(`[daemon] cleaning up ${candidates.length} idle channel(s)`);
    for (const { key, ageMs } of candidates) {
      const channel = this.channels.get(key);
      if (!channel) continue;
      const hours = Math.round(ageMs / 3_600_000);
      console.log(`[daemon]   ${key} idle for ${hours}h → killing tmux`);
      try {
        await channel.shutdown();
      } catch (err) {
        console.error(`[daemon] cleanup ${key}:`, err);
      }
      // Also drop any in-flight outbound state for the channel.
      const outbound = this.outbound.get(key);
      if (outbound) {
        clearOutboundState(outbound);
        this.outbound.delete(key);
      }
      this.previews.delete(key);
      this.channels.delete(key);
    }
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
        fire: async (userPrompt) => {
          const channel = await this.ensureChannel(GLOBAL_KEY, "global", false);
          if (!channel) return false;
          const template = await loadHeartbeatTemplate();
          const merged = composeHeartbeatPrompt(template, userPrompt);
          if (!merged) return false;
          await channel.handleIncoming({
            text: merged,
            fromLabel: "heartbeat",
            replyTo: null,
            rawPrompt: true, // v1 parity: heartbeat template fires verbatim
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
      rawPrompt: true, // v1 parity: cron body fires verbatim, no prefix wrap
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
    // Migrate any pre-projectHash tmux session names to the new format.
    await this.migrateTmuxNames(persisted);

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

  /**
   * Old sessions.json entries had tmuxSession names like "claudeclaw-global"
   * with no project-hash prefix. Two daemons in different project roots
   * would collide on those. Rename existing tmux sessions to the new
   * `claudeclaw-<projectHash>-<key>` format and update the persisted state.
   */
  private async migrateTmuxNames(persisted: SessionMap): Promise<void> {
    let dirty = false;
    for (const [key, session] of Object.entries(persisted)) {
      const expected = tmuxNameFor(key, this.projectDir);
      if (session.tmuxSession === expected) continue;
      const oldName = session.tmuxSession;
      try {
        const renamed = await renameSession(oldName, expected);
        if (renamed) {
          console.log(`[daemon] renamed tmux session ${oldName} → ${expected}`);
        }
      } catch (err) {
        console.warn(`[daemon] could not rename ${oldName} → ${expected}:`, err);
      }
      session.tmuxSession = expected;
      dirty = true;
    }
    if (dirty) await saveSessions(persisted);
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

    // Restore from sessions.json if we have a persisted entry — keeps the
    // claude conversation context across cleanup/restart cycles.
    const persisted = await loadSessions();
    const existing = persisted[key];
    if (existing) {
      channel = this.makeChannel(existing);
      this.channels.set(key, channel);
      console.log(`[daemon] restoring cold channel ${key} (sessionId ${existing.sessionId.slice(0, 8)})`);
      try {
        await channel.start({ resume: true });
      } catch (err) {
        console.error(`[daemon] failed to restore ${key}:`, err);
        this.channels.delete(key);
        return null;
      }
      return channel;
    }

    const now = new Date().toISOString();
    const session: ChannelSession = {
      kind,
      channelKey: key,
      sessionId: randomUUID(),
      tmuxSession: tmuxNameFor(key, this.projectDir),
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
      onAssistantText: async (text, replyTo, claudeMsgId, stopReason) => {
        await this.dispatchAssistantText(session, text, replyTo, claudeMsgId, stopReason);
      },
      onToolUse: async (toolName, input, replyTo) => {
        await this.dispatchToolUse(session, toolName, input, replyTo);
      },
      onToolResult: async (toolUseId, result, replyTo) => {
        await this.dispatchToolResult(session, toolUseId, result, replyTo);
      },
      onReasoning: async (text, replyTo, claudeMsgId) => {
        await this.dispatchReasoning(session, text, replyTo, claudeMsgId);
      },
      onTurnEnd: () => {
        void this.finalizeTurn(session);
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
   *
   * Intermediate text (stop_reason !== "end_turn") gets folded into the
   * progress bubble — only the final answer becomes its own bubble.
   */
  private async dispatchAssistantText(
    session: ChannelSession,
    text: string,
    replyTo: ReplyTarget,
    claudeMsgId: string | undefined,
    stopReason: string | undefined,
  ): Promise<void> {
    const { cleanText, reactions } = extractReactions(text);
    if (!replyTo) {
      if (cleanText) {
        console.log(`[daemon] [${session.channelKey}] no replyTo — logging only:\n${cleanText.slice(0, 500)}`);
      }
      return;
    }
    if (!cleanText && reactions.length === 0) return;

    // NO_REPLY: agent has decided this turn shouldn't surface anything on
    // the platform (multi-party context, off-topic chatter, etc). Skip the
    // text path entirely — reactions are still honoured.
    let textToSend: string | null = cleanText;
    if (cleanText && isSilentReplyText(cleanText)) {
      console.log(`[daemon] [${session.channelKey}] NO_REPLY — suppressing text`);
      textToSend = null;
    } else if (cleanText) {
      // The model sometimes appends a trailing NO_REPLY to a real reply.
      // Strip the token but keep the rest.
      const stripped = stripSilentToken(cleanText);
      if (stripped !== cleanText) {
        textToSend = stripped || null;
      }
    }

    // Pre-final ("intermediate") text — more tools coming, this isn't the
    // user-visible answer yet. Fold into the progress bubble so it doesn't
    // create its own message.
    if (textToSend && stopReason !== "end_turn") {
      if (this.streamMode(replyTo) !== "off") {
        await this.updateProgress(session.channelKey, replyTo, (p) => {
          p.intermediateText = p.intermediateText
            ? `${p.intermediateText}\n\n${textToSend}`
            : textToSend!;
        });
      }
      await this.applyReactions(replyTo, reactions);
      return;
    }

    if (textToSend) {
      const state = this.outbound.get(session.channelKey);
      const sameBubble = state?.kind === "text" &&
        !!claudeMsgId && state.claudeMsgId === claudeMsgId &&
        !!state.platformMsgId;
      if (sameBubble && state) {
        const combined = `${state.accumulated}\n\n${textToSend}`;
        state.accumulated = combined;
        const ok = await this.editWithThrottle(state, replyTo, combined);
        if (!ok) {
          // Edit failed (text too long, platform refused, etc) — fall back
          // to a fresh bubble for this segment. The old bubble is now a
          // preview (subject to messageStream.mode cleanup at turn-end).
          this.archiveAsPreview(session.channelKey, state, replyTo);
          clearOutboundState(state);
          const newId = await this.platformSend(replyTo, textToSend);
          this.outbound.set(
            session.channelKey,
            freshTextState(claudeMsgId, newId, textToSend),
          );
        }
      } else {
        // New bubble — the previous one (if any) becomes a preview.
        this.archiveAsPreview(session.channelKey, state, replyTo);
        clearOutboundState(state);
        const newId = await this.platformSend(replyTo, textToSend);
        this.outbound.set(
          session.channelKey,
          freshTextState(claudeMsgId, newId, textToSend),
        );
      }
    }

    await this.applyReactions(replyTo, reactions);
  }

  /**
   * Throttle platform edits. If the last actual edit was less than
   * EDIT_THROTTLE_MS ago, defer the edit and coalesce further updates into
   * one flush. Returns false when the edit is rejected outright (caller
   * falls back to a fresh bubble).
   */
  private async editWithThrottle(
    state: OutboundState,
    replyTo: ReplyTarget,
    text: string,
  ): Promise<boolean> {
    if (!state.platformMsgId) return false;
    const elapsed = Date.now() - state.lastEditAtMs;
    if (elapsed >= EDIT_THROTTLE_MS) {
      const ok = await this.platformEdit(replyTo, state.platformMsgId, text);
      if (ok) state.lastEditAtMs = Date.now();
      return ok;
    }
    // Defer: coalesce with any pending edit.
    state.pendingText = text;
    if (state.pendingTimer) return true;
    state.pendingTimer = setTimeout(async () => {
      state.pendingTimer = null;
      const pending = state.pendingText;
      state.pendingText = null;
      if (pending === null || !state.platformMsgId) return;
      const ok = await this.platformEdit(replyTo, state.platformMsgId, pending);
      if (ok) state.lastEditAtMs = Date.now();
    }, EDIT_THROTTLE_MS - elapsed);
    return true;
  }

  /**
   * Stash the currently-active bubble (the one in OutboundState) as a
   * preview, so it can be deleted at turn-end if mode = "replace". Called
   * when a NEW bubble is about to take its place.
   */
  private archiveAsPreview(channelKey: string, state: OutboundState | undefined, replyTo: ReplyTarget): void {
    if (!state || !state.platformMsgId || !replyTo) return;
    let list = this.previews.get(channelKey);
    if (!list) {
      list = [];
      this.previews.set(channelKey, list);
    }
    list.push({ replyTo, platformMsgId: state.platformMsgId });
  }

  /**
   * Apply the configured messageStream.mode at turn-end:
   *   "replace" — delete every preview bubble, leave the final one alone
   *   "keep"    — keep everything visible
   *   "off"     — same as replace (off currently means "no previews at all"
   *               which is implemented as suppress-everything-except-final;
   *               for now we also just delete them)
   */
  private async finalizeTurn(session: ChannelSession): Promise<void> {
    const channelKey = session.channelKey;
    const previews = this.previews.get(channelKey) ?? [];
    this.previews.delete(channelKey);
    const state = this.outbound.get(channelKey);
    clearOutboundState(state);
    this.outbound.delete(channelKey);
    if (previews.length === 0) return;
    // All previews in a turn share the same replyTo, so the first one is
    // enough to determine the mode.
    const mode = this.streamMode(previews[0]?.replyTo ?? null);
    if (mode === "keep") return;
    // Delete previews (replace + off both clear previews). Fire and forget.
    for (const p of previews) {
      void this.platformDelete(p.replyTo, p.platformMsgId);
    }
  }

  /**
   * Pick the streaming mode for an outbound reply target.
   *   discord channel → settings.discord.channels[id].messageStream
   *                  → settings.discord.messageStream
   *                  → built-in default "off"
   *   discord DM     → settings.discord.messageStream → "off"
   *   telegram       → settings.telegram.messageStream → "replace"
   *   slack          → settings.slack.messageStream → "replace"
   *   line           → settings.line.messageStream → "replace"
   *   null replyTo   → "replace" (logging-only path; nothing visible anyway)
   */
  private streamMode(replyTo: ReplyTarget): MessageStreamMode {
    if (!replyTo) return "replace";
    if (replyTo.platform === "discord") {
      const ch = this.settings.discord.channels[replyTo.channelId];
      return ch?.messageStream?.mode
        ?? this.settings.discord.messageStream?.mode
        ?? "off";
    }
    if (replyTo.platform === "telegram") {
      return this.settings.telegram.messageStream?.mode ?? "replace";
    }
    if (replyTo.platform === "slack") {
      return this.settings.slack.messageStream?.mode ?? "replace";
    }
    if (replyTo.platform === "line") {
      return this.settings.line.messageStream?.mode ?? "replace";
    }
    return "replace";
  }

  private async platformDelete(replyTo: ReplyTarget, msgId: string): Promise<boolean> {
    if (!replyTo) return false;
    try {
      if (replyTo.platform === "telegram") return (await this.telegram?.deleteMessage(replyTo.chatId, msgId)) ?? false;
      if (replyTo.platform === "discord") return (await this.discord?.deleteMessage(replyTo.channelId, msgId)) ?? false;
      if (replyTo.platform === "slack") return (await this.slack?.deleteMessage(replyTo.channelId, msgId)) ?? false;
      if (replyTo.platform === "line") return false;
    } catch (err) {
      console.error(`[daemon] platformDelete failed:`, err instanceof Error ? err.message : err);
    }
    return false;
  }

  /**
   * Update the progress bubble (creating one if needed) by running a
   * mutator over its structured content, then re-rendering and editing.
   * Returns the (possibly new) state, or null if streamMode is off / no
   * content yet / no replyTo.
   */
  private async updateProgress(
    channelKey: string,
    replyTo: ReplyTarget,
    mutate: (p: ProgressContent) => void,
  ): Promise<OutboundState | null> {
    if (!replyTo) return null;
    let state = this.outbound.get(channelKey);
    if (state?.kind === "progress") {
      mutate(state.progress);
      const rendered = renderProgress(state.progress);
      if (!rendered || rendered === state.accumulated) return state;
      state.accumulated = rendered;
      await this.editWithThrottle(state, replyTo, rendered);
      return state;
    }
    // Need to start a new progress bubble (possibly archiving a text bubble).
    if (state) {
      this.archiveAsPreview(channelKey, state, replyTo);
      clearOutboundState(state);
    }
    const progress = emptyProgress();
    mutate(progress);
    const rendered = renderProgress(progress);
    if (!rendered) return null;
    const newId = await this.platformSend(replyTo, rendered);
    if (!newId) return null;
    state = freshProgressState(newId, rendered, progress);
    this.outbound.set(channelKey, state);
    return state;
  }

  /** Reasoning gets folded into the current progress bubble. Latest only. */
  private async dispatchReasoning(
    session: ChannelSession,
    text: string,
    _replyTo: ReplyTarget,
    _claudeMsgId: string | undefined,
  ): Promise<void> {
    const replyTo = _replyTo;
    if (this.streamMode(replyTo) === "off") return;
    if (!replyTo) {
      console.log(`[daemon] [${session.channelKey}] no replyTo — reasoning: ${text.slice(0, 200)}`);
      return;
    }
    const cleaned = text.trim();
    if (!cleaned) return;
    await this.updateProgress(session.channelKey, replyTo, (p) => {
      p.reasoning = cleaned;
    });
  }

  /** Tool-use appends a status line and clears the "lastResult" slot. */
  private async dispatchToolUse(
    session: ChannelSession,
    toolName: string,
    input: unknown,
    replyTo: ReplyTarget,
  ): Promise<void> {
    if (this.streamMode(replyTo) === "off") return;
    const line = formatToolStatus(toolName, input);
    if (!replyTo) {
      console.log(`[daemon] [${session.channelKey}] no replyTo — tool: ${line}`);
      return;
    }
    await this.updateProgress(session.channelKey, replyTo, (p) => {
      p.toolLines.push(line);
      p.lastResult = "";
    });
  }

  /** Tool result sets the "lastResult" slot — only the latest tool's
   *  result is shown to keep the bubble compact. No-op when there's no
   *  active progress bubble. */
  private async dispatchToolResult(
    session: ChannelSession,
    _toolUseId: string | undefined,
    result: string,
    replyTo: ReplyTarget,
  ): Promise<void> {
    if (this.streamMode(replyTo) === "off") return;
    if (!replyTo) return;
    const state = this.outbound.get(session.channelKey);
    if (!state || state.kind !== "progress") return;
    const preview = formatToolResultPreview(result);
    if (!preview) return;
    await this.updateProgress(session.channelKey, replyTo, (p) => {
      p.lastResult = preview;
    });
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
    process.on("SIGHUP", () => void this.reloadSettings("SIGHUP"));
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    console.log(`[daemon] shutting down (${reason})...`);
    this.cron?.stop();
    this.heartbeat?.stop();
    this.statusline?.stop();
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
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

/**
 * What the agent is doing right now, distilled into one editable platform
 * message. Reasoning / tool calls / intermediate text / latest tool result
 * all go into a single "progress" bubble so the chat doesn't fill up with
 * a chain of bubbles before the real answer lands.
 */
interface ProgressContent {
  /** Latest reasoning text (replaced each time, not accumulated). */
  reasoning: string;
  /** Pre-final assistant text segments (those with stop_reason !== end_turn). */
  intermediateText: string;
  /** Each tool call's status line in fire order. */
  toolLines: string[];
  /** Result preview for the LAST tool call only. Cleared when a new tool fires. */
  lastResult: string;
}

interface OutboundState {
  /** progress = the unified pre-final bubble. text = the final answer bubble. */
  kind: "progress" | "text";
  /** Platform-side id of the message we'd edit. */
  platformMsgId: string | undefined;
  /** Currently-rendered text on the platform (basis for next edit/diff). */
  accumulated: string;
  /** Structured contents (progress bubbles only). */
  progress: ProgressContent;
  /** Claude Code message.id (text bubbles only — groups text segments). */
  claudeMsgId: string | undefined;
  /** Last actual platform edit timestamp — used to throttle further edits. */
  lastEditAtMs: number;
  /** Pending coalesced edit text awaiting flush. */
  pendingText: string | null;
  /** Timer for the deferred flush. */
  pendingTimer: ReturnType<typeof setTimeout> | null;
}

/** Coalesce platform edits to at most 1 per second to stay clear of
 *  Telegram-style rate limits and stop the UI from re-rendering on every
 *  jsonl event. Inspired by OpenClaw's draft-stream throttle. */
const EDIT_THROTTLE_MS = 1000;

function emptyProgress(): ProgressContent {
  return { reasoning: "", intermediateText: "", toolLines: [], lastResult: "" };
}

function freshTextState(
  claudeMsgId: string | undefined,
  platformMsgId: string | undefined,
  accumulated: string,
): OutboundState {
  return {
    kind: "text",
    claudeMsgId,
    platformMsgId,
    accumulated,
    progress: emptyProgress(),
    lastEditAtMs: Date.now(),
    pendingText: null,
    pendingTimer: null,
  };
}

function freshProgressState(
  platformMsgId: string,
  accumulated: string,
  progress: ProgressContent,
): OutboundState {
  return {
    kind: "progress",
    claudeMsgId: undefined,
    platformMsgId,
    accumulated,
    progress,
    lastEditAtMs: Date.now(),
    pendingText: null,
    pendingTimer: null,
  };
}

function renderProgress(p: ProgressContent): string {
  const parts: string[] = [];
  if (p.reasoning.trim()) {
    parts.push(`💭 _Reasoning_\n${truncate(p.reasoning, REASONING_MAX_CHARS)}`);
  }
  if (p.intermediateText.trim()) {
    parts.push(p.intermediateText.trim());
  }
  if (p.toolLines.length > 0) {
    const lines = [...p.toolLines];
    if (p.lastResult.trim()) lines.push(`  ↳ ${p.lastResult.trim()}`);
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function clearOutboundState(s: OutboundState | undefined): void {
  if (!s) return;
  if (s.pendingTimer) clearTimeout(s.pendingTimer);
  s.pendingTimer = null;
  s.pendingText = null;
}

const REASONING_MAX_CHARS = 700;
const TOOL_RESULT_MAX_LINES = 4;
const TOOL_RESULT_MAX_CHARS = 280;

function formatToolResultPreview(result: string): string {
  const trimmed = result.trim();
  if (!trimmed) return "";
  const lines = trimmed.split("\n").slice(0, TOOL_RESULT_MAX_LINES);
  let joined = lines.join("\n  ↳ ");
  if (lines.length === TOOL_RESULT_MAX_LINES && trimmed.split("\n").length > TOOL_RESULT_MAX_LINES) {
    joined += "\n  ↳ …";
  }
  if (joined.length > TOOL_RESULT_MAX_CHARS) {
    joined = joined.slice(0, TOOL_RESULT_MAX_CHARS - 1) + "…";
  }
  return joined;
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


async function main(): Promise<void> {
  const settings = await loadSettings();
  const daemon = new Daemon(settings);
  await daemon.start();
}

main().catch((err) => {
  console.error("[daemon] fatal:", err);
  process.exit(1);
});
