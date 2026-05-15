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
      onAssistantText: async (text, replyTo, claudeMsgId) => {
        await this.dispatchAssistantText(session, text, replyTo, claudeMsgId);
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
            freshOutboundState("text", claudeMsgId, newId, textToSend),
          );
        }
      } else {
        // New bubble — the previous one (if any) becomes a preview.
        this.archiveAsPreview(session.channelKey, state, replyTo);
        clearOutboundState(state);
        const newId = await this.platformSend(replyTo, textToSend);
        this.outbound.set(
          session.channelKey,
          freshOutboundState("text", claudeMsgId, newId, textToSend),
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
   * Reasoning ("thinking") bubble. Shown before tool calls / final answer
   * when the model emits visible deliberation. Same edit-in-place + throttle
   * semantics as text/tool bubbles.
   *
   * Suppressed entirely when settings.messageStream.mode === "off".
   */
  private async dispatchReasoning(
    session: ChannelSession,
    text: string,
    replyTo: ReplyTarget,
    claudeMsgId: string | undefined,
  ): Promise<void> {
    if (this.streamMode(replyTo) === "off") return;
    if (!replyTo) {
      console.log(`[daemon] [${session.channelKey}] no replyTo — reasoning: ${text.slice(0, 200)}`);
      return;
    }
    const line = formatReasoningLine(text);
    if (!line) return;
    const state = this.outbound.get(session.channelKey);
    const sameBubble = state?.kind === "reasoning" &&
      !!claudeMsgId && state.claudeMsgId === claudeMsgId &&
      !!state.platformMsgId;
    if (sameBubble && state) {
      state.accumulated = line;
      const ok = await this.editWithThrottle(state, replyTo, line);
      if (ok) return;
      this.archiveAsPreview(session.channelKey, state, replyTo);
      clearOutboundState(state);
    } else if (state) {
      this.archiveAsPreview(session.channelKey, state, replyTo);
      clearOutboundState(state);
    }
    const newId = await this.platformSend(replyTo, line);
    this.outbound.set(
      session.channelKey,
      freshOutboundState("reasoning", claudeMsgId, newId, line),
    );
  }

  /**
   * Append a truncated tool-result preview under the current tool bubble,
   * indented to make the call → result relationship visible. No-op when
   * there's no active tool bubble.
   */
  private async dispatchToolResult(
    session: ChannelSession,
    _toolUseId: string | undefined,
    result: string,
    replyTo: ReplyTarget,
  ): Promise<void> {
    if (this.streamMode(replyTo) === "off") return;
    if (!replyTo) return;
    const state = this.outbound.get(session.channelKey);
    if (!state || state.kind !== "tool" || !state.platformMsgId) return;
    const preview = formatToolResultPreview(result);
    if (!preview) return;
    const combined = `${state.accumulated}\n  ↳ ${preview}`;
    state.accumulated = combined;
    await this.editWithThrottle(state, replyTo, combined);
  }

  /**
   * Consecutive tool-use events within a turn collapse into a single growing
   * status bubble — "🛠 Bash: ls\n🛠 Read: foo.ts\n…" — instead of one
   * platform message per tool call. Switching back to text (or a new turn)
   * starts a fresh bubble.
   */
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
    const state = this.outbound.get(session.channelKey);
    if (state?.kind === "tool" && state.platformMsgId) {
      const combined = `${state.accumulated}\n${line}`;
      state.accumulated = combined;
      const ok = await this.editWithThrottle(state, replyTo, combined);
      if (ok) return;
      // Edit failed — start a fresh tool bubble for this line.
      this.archiveAsPreview(session.channelKey, state, replyTo);
      clearOutboundState(state);
    } else if (state && state.kind !== "tool") {
      // Switching from another kind into a tool bubble.
      this.archiveAsPreview(session.channelKey, state, replyTo);
      clearOutboundState(state);
    }
    const newId = await this.platformSend(replyTo, line);
    this.outbound.set(
      session.channelKey,
      freshOutboundState("tool", undefined, newId, line),
    );
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
  /** Whether the current bubble is collecting assistant text, tool-call
   *  status lines, or reasoning — switching kinds starts a fresh bubble. */
  kind: "text" | "tool" | "reasoning";
  /** Claude Code message.id whose segments we're accumulating. Only set
   *  for text bubbles (tool bubbles accumulate across msg_ids within a turn). */
  claudeMsgId: string | undefined;
  /** Platform-side id of the message we'd edit (string for portability). */
  platformMsgId: string | undefined;
  /** Combined text we've sent so far for this bubble; basis for next edit. */
  accumulated: string;
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

function freshOutboundState(
  kind: "text" | "tool" | "reasoning",
  claudeMsgId: string | undefined,
  platformMsgId: string | undefined,
  accumulated: string,
): OutboundState {
  return {
    kind,
    claudeMsgId,
    platformMsgId,
    accumulated,
    lastEditAtMs: Date.now(),
    pendingText: null,
    pendingTimer: null,
  };
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

function formatReasoningLine(text: string): string {
  const cleaned = text.trim();
  if (!cleaned) return "";
  const truncated = cleaned.length <= REASONING_MAX_CHARS
    ? cleaned
    : cleaned.slice(0, REASONING_MAX_CHARS - 1) + "…";
  return `💭 _Reasoning_\n${truncated}`;
}

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
