/**
 * ClaudeClaw v2 main entry.
 *
 * Wires the platform connector(s) + per-channel state machines and routes
 * inbound messages to lazily-spawned tmux-hosted `claude` agents. Restores
 * existing sessions on startup so daemon restarts don't reset conversations.
 */
import { randomUUID } from "crypto";
import { watch } from "fs";
import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import { discoverCommands, type SlashCommandDef } from "./slash-commands";
import { dirname, join } from "path";
import { homedir } from "os";
import { Channel, type ChannelCallbacks, type ReplyTarget } from "./channel";
import { loadSettings, type MessageStreamMode, type Settings } from "./config";
import { CronScheduler, loadJob, type Job } from "./jobs";
import { composeHeartbeatPrompt, HeartbeatScheduler, loadHeartbeatTemplate, parseTimezoneOffset } from "./heartbeat";
import type { SourceInfo } from "./channel";
import { StatuslineWriter } from "./statusline";
import { backupV1GlobalIfExists, migrateFromV1 } from "./migrate";
import { appendInbox } from "./inbox";
import { extractReactions } from "./reactions";
import { isSilentReplyText, stripSilentToken } from "./silent";
import { formatToolStatus } from "./tool-display";

const PID_FILE = join(".claude", "claudeclaw", "daemon.pid");
const SETTINGS_PATH = join(".claude", "claudeclaw", "settings.json");
const RESTART_PENDING_PATH = join(".claude", "claudeclaw", "restart-pending.json");

/**
 * Fallback model list for the `/model` menu, used ONLY when the live picker
 * can't be queried (channel busy mid-turn, parse failure). The primary path
 * is channel.listModels(), which reads the live `/model` picker so the menu
 * auto-maintains with the installed Claude Code.
 *
 * Uses tier aliases (opus/sonnet/haiku) rather than dated ids so the
 * resolved model always tracks the latest in each tier — the labels are
 * intentionally version-agnostic for the same reason.
 */
const KNOWN_MODELS: Array<{ label: string; id: string }> = [
  { label: "Fable (latest)", id: "fable" },
  { label: "Opus (latest)", id: "opus" },
  { label: "Sonnet (latest)", id: "sonnet" },
  { label: "Haiku (latest)", id: "haiku" },
];
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
import { TelegramPlatform, type InboundMessage, type TelegramCallbackInbound, type TelegramRouter } from "./platforms/telegram";
import { randomBytes } from "crypto";
import type { ApprovalApi } from "./channel";
import type { PermissionDialog } from "./approval";
import { composePromptWithAttachments } from "./attachments";
import { DiscordPlatform, type DiscordInbound, type DiscordRouter } from "./platforms/discord";
import { SlackPlatform, type SlackInbound, type SlackRouter } from "./platforms/slack";
import { LinePlatform, type LineInbound, type LineRouter } from "./platforms/line";
import { WebServer, type SessionView, type WebDaemonView } from "./web";

class Daemon {
  private channels = new Map<string, Channel>();
  /** Permission dialogs waiting on operator decision. Keyed by short token
   *  embedded in the inline-keyboard callback_data so we can route incoming
   *  button presses back to the right channel's tmux session. */
  /** Outstanding inline-keyboard interactions (approval dialogs, /model
   *  pickers, anything else that prompts the operator with Telegram buttons).
   *  Keyed by the short token embedded in callback_data. The interaction
   *  carries its own onResolve closure so the daemon doesn't need to know
   *  the kind-specific logic here. */
  private pendingInteractions = new Map<string, PendingInteraction>();
  /** Per-channel temporary auto-approve deadline (epoch ms). While now <
   *  this value, permission/model-switch dialogs on that channel are
   *  auto-approved (select option 1) instead of prompting. Set via
   *  /autoapprove. */
  private autoApproveUntil = new Map<string, number>();
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
  private slashCommands: SlashCommandDef[] = [];
  private authToken: string | undefined;

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
    await this.startWeb();
    this.startSessionCleanup();
    this.watchSettings();
    this.installSignalHandlers();
    console.log(`[daemon] ready (project=${this.projectDir})`);
    void this.syncPlatformCommands();
    void this.checkRestartContext();
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

  private async startWeb(): Promise<void> {
    this.authToken = await this.loadOrCreateAuthToken();
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
      defaultTimezoneOffsetMinutes: () => parseTimezoneOffset(this.settings.timezone),
      triggerJob: (name) => this.triggerJobByName(name),
      sendToPlatform: (target, text) => this.sendToPlatform(target, text),
      inboxOwnerForTarget: (target) => inboxOwnerForTarget(target),
      restartDaemon: (ctx) => {
        console.log("[daemon] restart requested via API", ctx?.reason ? `(reason: ${ctx.reason})` : "");
        if (ctx?.reason || ctx?.replyTo) {
          void writeFile(RESTART_PENDING_PATH, JSON.stringify({ ...ctx, timestamp: new Date().toISOString() }));
        }
        setTimeout(() => this.shutdown("api-restart", 75), 150);
      },
    };
    this.web = new WebServer(this.settings.web, view, this.authToken);
    this.web.start();
    const sockPath = join(this.projectDir, ".claude", "claudeclaw", "daemon.sock");
    await this.web.startIpc(sockPath);
  }

  private async loadOrCreateAuthToken(): Promise<string> {
    const tokenPath = join(this.projectDir, ".claude", "claudeclaw", "auth.token");
    try {
      const existing = await Bun.file(tokenPath).text();
      const trimmed = existing.trim();
      if (trimmed.length >= 32) return trimmed;
    } catch {}
    const token = randomBytes(32).toString("hex");
    await writeFile(tokenPath, token, { mode: 0o600 });
    console.log(`[web] generated auth token → ${tokenPath}`);
    return token;
  }

  private async checkRestartContext(): Promise<void> {
    let ctx: { reason?: string; replyTo?: string; timestamp?: string };
    try {
      const raw = await Bun.file(RESTART_PENDING_PATH).text();
      ctx = JSON.parse(raw);
    } catch {
      return;
    }
    await unlink(RESTART_PENDING_PATH).catch(() => {});
    if (!ctx.replyTo) return;
    const age = ctx.timestamp ? Date.now() - new Date(ctx.timestamp).getTime() : 0;
    if (age > 5 * 60 * 1000) {
      console.log("[daemon] restart-pending too old, skipping");
      return;
    }
    // Route through the channel that owns inbound traffic from this target,
    // so the restart notification goes through the AI session (tmux) and gets
    // the AI's natural response, then out to the platform via replyTo.
    const channelKey = inboxOwnerForTarget(ctx.replyTo) ?? ctx.replyTo;
    const meta = deriveKindFromKey(channelKey);
    if (!meta) {
      console.warn(`[daemon] restart-pending: cannot resolve channel for replyTo=${ctx.replyTo}`);
      return;
    }
    const channel = await this.ensureChannel(channelKey, meta.kind, meta.multiparty);
    if (!channel) return;
    const replyTo = parseReplyToFromString(ctx.replyTo);
    const parts: string[] = ["[daemon restarted]"];
    if (ctx.reason) parts.push(`reason: ${ctx.reason}`);
    await channel.handleIncoming({
      text: parts.join("\n"),
      fromLabel: "daemon-restart",
      replyTo,
      skipModelRouting: true,
    });
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
          // Heartbeat fires verbatim — the template body already frames
          // itself as a passive "check on pending stuff" prompt and has
          // been stable in v1's bare-body form.
          await channel.handleIncoming({
            text: merged,
            fromLabel: "heartbeat",
            replyTo: null,
            rawPrompt: true,
            skipModelRouting: true,
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
      defaultTimezoneOffsetMinutes: () => parseTimezoneOffset(this.settings.timezone),
    });
    this.cron.start();
  }

  private async fireCronJob(job: Job, manual = false): Promise<void> {
    const meta = deriveKindFromKey(job.target);
    if (!meta) {
      console.error(`[daemon] cron job "${job.name}": unsupported target "${job.target}"`);
      return;
    }
    const channel = await this.ensureChannel(job.target, meta.kind, meta.multiparty);
    if (!channel) return;
    await touchActivity(job.target);
    // Wrap with timestamp + scheduled-job source line so context survives a
    // mid-turn compaction. v1 fired bare body which left the model guessing
    // whether the prompt meant "right now" or "for the daily summary".
    const sourceTag = manual ? "manual · cron" : "scheduled · cron";
    await channel.handleIncoming({
      text: job.body,
      fromLabel: `${sourceTag} · ${job.name} (${job.schedule})`,
      replyTo: job.replyTo,
      skipModelRouting: true,
    });
  }

  /**
   * Deliver a real platform-side message to `target`. Used by `/api/send`.
   * Returns `{ ok: false }` when the platform is disabled, the target form
   * is unsupported, or the underlying SDK call fails.
   */
  private async sendToPlatform(target: string, text: string): Promise<{ ok: boolean; error?: string }> {
    if (target === GLOBAL_KEY) {
      return { ok: false, error: "target=global has no platform to send to — use a specific platform target" };
    }
    try {
      if (target.startsWith("telegram:")) {
        if (!this.telegram) return { ok: false, error: "telegram platform not enabled" };
        const chatId = Number(target.slice("telegram:".length));
        if (!Number.isFinite(chatId)) return { ok: false, error: "invalid telegram chat id" };
        await this.telegram.sendMessage(chatId, text);
        return { ok: true };
      }
      if (target.startsWith("discord:")) {
        if (!this.discord) return { ok: false, error: "discord platform not enabled" };
        await this.discord.sendMessage(target.slice("discord:".length), text);
        return { ok: true };
      }
      if (target.startsWith("slack:")) {
        if (!this.slack) return { ok: false, error: "slack platform not enabled" };
        const rest = target.slice("slack:".length);
        const colon = rest.indexOf(":");
        const channelId = colon < 0 ? rest : rest.slice(0, colon);
        const threadTs = colon < 0 ? undefined : rest.slice(colon + 1);
        await this.slack.sendMessage(channelId, text, threadTs);
        return { ok: true };
      }
      if (target.startsWith("line:")) {
        if (!this.line) return { ok: false, error: "line platform not enabled" };
        await this.line.pushText(target.slice("line:".length), text);
        return { ok: true };
      }
      return { ok: false, error: `unsupported target form "${target}"` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Fire a job immediately by name. Returns false if the job is missing. */
  async triggerJobByName(name: string): Promise<boolean> {
    const job = await loadJob(name).catch(() => null);
    if (!job) return false;
    console.log(`[daemon] manual trigger for cron job "${job.name}" → target=${job.target}`);
    await this.fireCronJob(job, true);
    return true;
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
        session.kind !== "telegram" &&
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

  private async syncPlatformCommands(): Promise<void> {
    try {
      this.slashCommands = await discoverCommands();
      if (this.slashCommands.length === 0) return;
      console.log(`[daemon] discovered ${this.slashCommands.length} slash command(s)`);
      const payload = this.slashCommands.map((c) => ({ name: c.name, description: c.description }));
      await Promise.all([
        this.telegram?.setCommands(payload),
        this.discord?.registerGlobalCommands(payload),
      ]);
    } catch (err) {
      console.error("[daemon] syncPlatformCommands error:", err);
    }
  }

  private async startTelegram(): Promise<void> {
    if (!this.settings.telegram.token) {
      console.log("[daemon] telegram disabled (no token)");
      return;
    }
    const router: TelegramRouter = {
      handleMessage: (msg) => this.routeTelegram(msg),
      handleCallback: (cb) => this.handleTelegramCallback(cb),
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
    const text = composePromptWithAttachments(this.resolveCommandText(msg.text), msg.attachments);
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
    // Channel-routing modes (see SlackChannelMode in config.ts):
    //   "channel"            — every message in the channel (incl. thread replies)
    //                          → one shared session `slack:<channelId>`
    //   "thread-per-message" — each top-level message starts its own session;
    //                          replies in that thread join it via thread_ts.
    let key: string;
    if (isDM) {
      key = GLOBAL_KEY;
    } else {
      const channelCfg = this.settings.slack.channels?.[msg.channelId];
      const mode = channelCfg?.mode ?? this.settings.slack.defaultMode ?? "channel";
      if (mode === "thread-per-message") {
        // thread_ts is set on replies; the parent message has no thread_ts
        // until someone replies, so it anchors on its own messageTs.
        const anchor = msg.threadTs ?? msg.messageTs;
        key = `slack:${msg.channelId}:${anchor}`;
      } else {
        key = `slack:${msg.channelId}`;
      }
    }
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
    const text = composePromptWithAttachments(this.resolveCommandText(msg.text), msg.attachments);
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
    const text = composePromptWithAttachments(this.resolveCommandText(msg.text), msg.attachments);
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
    // DM (private chat) converges on `global` so it shares the local Claude
    // Code session like every other platform's DMs do. Groups/supergroups
    // get their own per-chat `telegram:<chatId>` channel so the conversation
    // history stays scoped to that group and isn't mixed into the user's
    // 1:1 context.
    const isDM = msg.chatType === "private";
    const key = isDM ? GLOBAL_KEY : `telegram:${msg.chatId}`;
    const kind = isDM ? "global" : "telegram";
    const multiparty = !isDM;
    const replyTo: ReplyTarget = {
      platform: "telegram",
      chatId: msg.chatId,
      messageId: msg.messageId,
    };

    const channel = await this.ensureChannel(key, kind, multiparty);
    if (!channel) return;
    await touchActivity(key);
    if (await this.tryHandleCommand(msg.text, channel, replyTo)) return;
    const text = composePromptWithAttachments(this.resolveCommandText(msg.text), msg.attachments);
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
  /** Translate platform-normalized command names back to original form.
   *  e.g. "/plugin_reload" → "/plugin reload". No-op for unknown or non-slash text. */
  private resolveCommandText(raw: string): string {
    const m = raw.trim().match(/^\/([a-z0-9_]+)(\s.*)?$/i);
    if (!m) return raw;
    const candidate = this.slashCommands.find((c) => c.name === m[1] && c.originalName !== m[1]);
    if (!candidate) return raw;
    return `/${candidate.originalName}${m[2] ?? ""}`;
  }

  private async tryHandleCommand(
    raw: string,
    channel: Channel,
    replyTo: ReplyTarget,
  ): Promise<boolean> {
    const cmd = raw.trim();
    if (cmd === "/help") {
      const lines = ["Available commands:"];
      for (const c of this.slashCommands) {
        lines.push(`/${c.originalName} — ${c.description}`);
      }
      if (lines.length === 1) lines.push("(no plugin commands discovered yet)");
      await this.dispatchOutbound(channel.session, lines.join("\n"), replyTo);
      return true;
    }
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
    if (cmd === "/usage") {
      const msg = await this.summarizeUsage();
      await this.dispatchOutbound(channel.session, msg, replyTo);
      return true;
    }
    // /clear — soft clear: forward native /clear (keeps the same session id
    // + jsonl, so the tail stays valid). Falls back to a hard reset if the
    // tmux process is gone.
    if (cmd === "/clear" || cmd === "/claudeclaw2:clear") {
      const res = await channel.softClear();
      if (res.ok) {
        await this.dispatchOutbound(
          channel.session,
          `🧼 Cleared context (session \`${channel.session.sessionId.slice(0, 8)}\` kept warm)`,
          replyTo,
        );
      } else if (res.busy) {
        await this.dispatchOutbound(channel.session, "⚠️ Busy mid-turn — /stop first, then /clear", replyTo);
      } else {
        // tmux gone — fall through to a hard reset so the user still ends
        // up with a fresh, tracked session.
        const newId = await channel.hardReset();
        await this.dispatchOutbound(
          channel.session,
          newId
            ? `🧹 Agent was down — hard-reset to new session \`${newId.slice(0, 8)}\``
            : "❌ Clear failed and hard reset failed — check daemon log",
          replyTo,
        );
      }
      return true;
    }
    // /autoapprove [minutes|off] — temporarily auto-approve permission +
    // model-switch dialogs on this channel so the operator doesn't have to
    // watch. Default 30 min. `off` cancels.
    const autoMatch = cmd.match(/^\/(?:claudeclaw2:)?(?:autoapprove|yolo)(?:\s+(.+))?$/);
    if (autoMatch) {
      const arg = autoMatch[1]?.trim().toLowerCase();
      const key = channel.session.channelKey;
      if (arg === "off" || arg === "0" || arg === "stop") {
        this.autoApproveUntil.delete(key);
        await this.dispatchOutbound(channel.session, "🔒 Auto-approve off — dialogs will ask again", replyTo);
        return true;
      }
      if (!arg) {
        const until = this.autoApproveUntil.get(key) ?? 0;
        const remainMin = Math.max(0, Math.round((until - Date.now()) / 60000));
        const msg = remainMin > 0
          ? `🟢 Auto-approve ON — ${remainMin} min left. \`/autoapprove off\` to stop.`
          : "🔒 Auto-approve off. `/autoapprove <minutes>` to enable (default 30).";
        await this.dispatchOutbound(channel.session, msg, replyTo);
        return true;
      }
      const mins = Math.min(720, Math.max(1, Math.round(Number(arg) || 30)));
      this.autoApproveUntil.set(key, Date.now() + mins * 60_000);
      await this.dispatchOutbound(
        channel.session,
        `🟢 Auto-approving all dialogs on this channel for ${mins} min. \`/autoapprove off\` to stop early.`,
        replyTo,
      );
      return true;
    }
    // /reset — hard reset: respawn the agent on a fresh session UUID. Always
    // a clean slate; session tracking stays correct because we own the id.
    if (cmd === "/reset" || cmd === "/claudeclaw2:reset") {
      const newId = await channel.hardReset();
      await this.dispatchOutbound(
        channel.session,
        newId
          ? `🧹 Reset — new session \`${newId.slice(0, 8)}\` (fresh context)`
          : "❌ Reset failed — check daemon log",
        replyTo,
      );
      return true;
    }
    // /model (and the namespaced /claudeclaw2:model) — list configured
    // models when called without args, or pin a specific model when given
    // one. Pinning bumps the channel's hysteresis sticky-window timestamp
    // so agentic routing won't flip the user back out of the picked model.
    const modelMatch = cmd.match(/^\/(?:claudeclaw2:)?model(?:\s+(.+))?$/);
    if (modelMatch) {
      const arg = modelMatch[1]?.trim();
      if (!arg) {
        await this.openModelMenu(channel, replyTo);
        return true;
      }
      const ok = await channel.pinModel(arg);
      const msg = ok
        ? `🎯 Pinned model \`${arg}\` (sticky for ${this.settings.agentic.hysteresis.stickyWindowMinutes}min / ${this.settings.agentic.hysteresis.stickyWindowTurns} turns)`
        : `⚠️ Failed to switch to \`${arg}\` — check daemon log`;
      await this.dispatchOutbound(channel.session, msg, replyTo);
      return true;
    }
    return false;
  }

  /**
   * Render the model picker as an inline-keyboard menu on Telegram, sourced
   * from the LIVE `/model` picker (channel.listModels) so it auto-maintains
   * with the installed Claude Code — no hardcoded model list to go stale.
   * Falls back to a static alias list if the channel is busy or discovery
   * fails. On non-Telegram platforms, text summary only.
   *
   * No auto-cancel timer — the menu is informational; if the user never
   * picks, nothing's blocked.
   */
  private async openModelMenu(channel: Channel, replyTo: ReplyTarget): Promise<void> {
    if (replyTo?.platform !== "telegram" || !this.telegram) {
      await this.dispatchOutbound(channel.session, this.summarizeModels(channel), replyTo);
      return;
    }
    const chatId = replyTo.chatId;
    const live = await channel.listModels();

    if (live && live.length > 0) {
      // Live picker path: buttons map 1:1 to picker indices; the apply step
      // drives the picker by index so labels never need parsing into ids.
      const header = [
        "🤖 *Select model*",
        "_Live list from Claude Code — applies to this session only._",
      ].join("\n");
      const ok = await this.registerInteraction({
        kind: "mdl",
        session: channel.session,
        chatId,
        body: header,
        buttonsFor: (token) => {
          const rows = live.map((o) => [{
            text: `${o.isCurrent ? "● " : ""}${o.label} — ${o.description.split("·")[0].trim()}`.slice(0, 60),
            callback_data: `mdl:${token}:${o.index}`,
          }]);
          rows.push([{ text: "❌ Cancel", callback_data: `mdl:${token}:0` }]);
          return rows;
        },
        onResolve: async (choice, actor) => {
          if (choice === null) return "⏰ _Closed_";
          if (choice === 0) return `❌ _Cancelled by ${actor ?? "user"}_`;
          const res = await channel.pickModelByIndex(choice);
          if (!res.ok) return `⚠️ _Switch failed (channel busy?) — see log_`;
          return `🎯 _Set to ${res.label} (this session) by ${actor ?? "user"}_`;
        },
      });
      if (ok) return;
    }

    // Fallback: channel busy or discovery failed — offer the static alias
    // list via pinModel (which sends `/model <alias>`).
    const body = this.summarizeModels(channel);
    const current = channel.model || this.settings.model;
    const choices: Array<{ label: string; model: string }> = [
      ...KNOWN_MODELS.map((m) => ({ label: m.label, model: m.id })),
      { label: "↩︎ Default (clear pin)", model: "default" },
    ];
    const ok = await this.registerInteraction({
      kind: "mdl",
      session: channel.session,
      chatId,
      body,
      buttonsFor: (token) => {
        const rows = choices.map((c, i) => [{
          text: `${c.model === current ? "● " : ""}${c.label}`,
          callback_data: `mdl:${token}:${i + 1}`,
        }]);
        rows.push([{ text: "❌ Cancel", callback_data: `mdl:${token}:0` }]);
        return rows;
      },
      onResolve: async (choice, actor) => {
        if (choice === null) return "⏰ _Closed_";
        if (choice === 0) return `❌ _Cancelled by ${actor ?? "user"}_`;
        const picked = choices[choice - 1];
        if (!picked) return "❓ _Invalid choice_";
        const switched = await channel.pinModel(picked.model);
        if (!switched) return `⚠️ _Switch to ${picked.model} failed — see log_`;
        return `🎯 _Pinned to ${picked.label} by ${actor ?? "user"}_`;
      },
    });
    if (!ok) await this.dispatchOutbound(channel.session, body, replyTo);
  }

  private summarizeModels(channel: Channel): string {
    const a = this.settings.agentic;
    const lines: string[] = ["🤖 *Models*"];
    const current = channel.model || this.settings.model || "(default)";
    lines.push(`Current on this channel: \`${current}\``);
    lines.push("");
    if (this.settings.model) {
      lines.push(`Default: \`${this.settings.model}\``);
    }
    if (a.enabled && a.modes.length > 0) {
      lines.push("Agentic routing modes:");
      for (const m of a.modes) {
        const kw = m.keywords.join(", ").slice(0, 60);
        lines.push(`  • \`${m.name}\` → \`${m.model}\`${kw ? ` — ${kw}` : ""}`);
      }
      lines.push("");
      const h = a.hysteresis;
      lines.push(
        `Hysteresis: confidence ≥ ${h.confidenceThreshold}, margin ≥ ${h.scoreMargin}, sticky ${h.stickyWindowMinutes}min/${h.stickyWindowTurns} turns`,
      );
    } else {
      lines.push("Agentic routing: _disabled_");
    }
    lines.push("");
    lines.push("Tap a model below, or use `/model <name>` (e.g. `opus`, `sonnet`, `haiku`, or a full id).");
    return lines.join("\n");
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

  private async summarizeUsage(): Promise<string> {
    const STATUS_FILE = join(homedir(), ".claude", "usag-status.json");
    let raw: string;
    try {
      raw = await readFile(STATUS_FILE, "utf8");
    } catch {
      return [
        "📊 Claude Code Usage",
        "",
        "No data yet — the statusLine hook needs to fire at least once.",
        "Run any command in a Claude Code session to trigger it.",
      ].join("\n");
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return "⚠ usage data file is corrupt";
    }

    const now = Date.now() / 1000;
    const receivedTs = typeof data._received_at_ts === "number" ? data._received_at_ts : 0;
    const ageMin = receivedTs ? Math.round((now - receivedTs) / 60) : null;

    const rl = (data.rate_limits ?? {}) as Record<string, unknown>;
    const five = (rl.five_hour ?? {}) as Record<string, unknown>;
    const seven = (rl.seven_day ?? {}) as Record<string, unknown>;

    function pct(v: unknown): number | null {
      if (v == null) return null;
      const n = parseFloat(String(v));
      return isNaN(n) ? null : Math.max(0, Math.min(100, Math.round(n)));
    }

    function resetIn(ts: unknown): string {
      if (!ts) return "unknown";
      const t = parseFloat(String(ts));
      if (isNaN(t) || t < now) return "reset occurred";
      const diff = Math.round(t - now);
      const d = Math.floor(diff / 86400);
      const h = Math.floor((diff % 86400) / 3600);
      const m = Math.floor((diff % 3600) / 60);
      if (d) return `${d}d ${h}h ${m}m`;
      if (h) return `${h}h ${m}m`;
      return `${m}m`;
    }

    function bar(p: number | null): string {
      if (p === null) return "[no data]";
      const filled = Math.round(p / 100 * 15);
      const icon = p >= 90 ? "🔴" : p >= 70 ? "🟡" : "🟢";
      return `${"█".repeat(filled)}${"░".repeat(15 - filled)} ${p}% ${icon}`;
    }

    const fivePct = pct(five.used_percentage);
    const sevenPct = pct(seven.used_percentage);
    const fiveReset = five.resets_at;
    const sevenReset = seven.resets_at;

    const lines: string[] = [
      "📊 Claude Code Usage",
      "",
      `5h window  ${bar(fivePct)}`,
      `           resets in ${resetIn(fiveReset)}`,
      "",
      `7d weekly  ${bar(sevenPct)}`,
      `           resets in ${resetIn(sevenReset)}`,
    ];

    if (typeof data.cost === "number") {
      lines.push("", `session cost  $${data.cost.toFixed(4)}`);
    }

    if (ageMin !== null) {
      const staleTag = ageMin > 360 ? ` ⚠ stale` : "";
      lines.push("", `data from ${ageMin}m ago${staleTag}`);
    }

    return lines.join("\n");
  }

  private async ensureChannel(
    key: string,
    kind: "global" | "telegram" | "discord" | "slack" | "line",
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
      onApprovalNeeded: async (dialog, replyTo, api) => {
        await this.handleApprovalNeeded(session, dialog, replyTo, api);
      },
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
      queue: this.settings.queue,
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
          const last = p.items[p.items.length - 1];
          if (last?.kind === "text") {
            // Coalesce consecutive intermediate-text events into one item
            // so successive segments read as a single paragraph.
            last.content = `${last.content}\n\n${textToSend}`;
          } else {
            p.items.push({ kind: "text", content: textToSend! });
          }
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

      // Cross-channel echo: when the reply lands on a chat/channel whose
      // *own* session is different from the one that produced it (typical
      // cron pattern: target=global, replyTo=telegram:<group>), append an
      // inbox entry to the natural owner so it sees the message on its
      // next turn instead of being surprised by chat history it didn't
      // create.
      const ownerKey = inboxOwnerForReplyTo(replyTo);
      if (ownerKey && ownerKey !== session.channelKey) {
        await appendInbox(ownerKey, {
          kind: "trigger-result",
          from: session.channelKey,
          text: textToSend,
          note: `routed via replyTo`,
        }).catch((err: Error) =>
          console.error(`[daemon] cross-channel inbox echo failed (${ownerKey}):`, err),
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
   * Route a permission dialog to the operator's DM with inline buttons,
   * then wait for their decision (or timeout) before sending the
   * corresponding keypress sequence into tmux.
   *
   * Currently Telegram-only — other platforms log + auto-cancel.
   */
  private async handleApprovalNeeded(
    session: ChannelSession,
    dialog: PermissionDialog,
    replyTo: ReplyTarget,
    api: ApprovalApi,
  ): Promise<void> {
    const cfg = this.settings.approval;
    if (!cfg.enabled) {
      console.warn(`[approval] disabled — cancelling dialog for ${session.channelKey}`);
      await api.cancel();
      return;
    }

    // Temporary auto-approve window (set via /autoapprove). While active for
    // this channel, approve permission/model-switch dialogs by selecting the
    // first (proceed) option without bothering the operator. Surveys still
    // follow the survey setting below.
    if (dialog.kind !== "survey") {
      const until = this.autoApproveUntil.get(session.channelKey) ?? 0;
      if (Date.now() < until) {
        console.log(`[approval] auto-approving (window active) on ${session.channelKey}`);
        await api.selectOption(1);
        return;
      }
    }

    // Survey auto-dismiss: settings.approval.survey === "dismiss" makes the
    // periodic "How is Claude doing?" prompt vanish silently so the channel
    // doesn't stall on it. "ask" falls through to the normal operator path.
    if (dialog.kind === "survey" && cfg.survey === "dismiss") {
      const dismissOption = dialog.options.findIndex((o) => /dismiss/i.test(o)) + 1;
      const choice = dismissOption > 0 ? dismissOption : 1;
      console.log(`[approval] auto-dismissing survey on ${session.channelKey} (option ${choice})`);
      await api.selectOption(choice);
      return;
    }

    // Resolve DM target. Route to the originating platform's owner DM where
    // possible. Discord/Slack/LINE not yet wired — fall back to auto-cancel.
    let telegramChatId: number | undefined;
    if (replyTo?.platform === "telegram") {
      telegramChatId = replyTo.chatId;
    } else if (this.settings.telegram.allowedUserIds.length > 0) {
      telegramChatId = this.settings.telegram.allowedUserIds[0];
    }

    if (telegramChatId === undefined || !this.telegram) {
      console.warn(
        `[approval] no Telegram approver configured for ${session.channelKey} — auto-cancelling.`,
      );
      await api.cancel();
      return;
    }

    const body = formatApprovalPrompt(session.channelKey, dialog);
    const buttons = (token: string) => {
      const rows = dialog.options.map((opt, i) => [{
        text: numberedButtonLabel(i + 1, opt),
        callback_data: `ap:${token}:${i + 1}`,
      }]);
      rows.push([{ text: "❌ Cancel (Esc)", callback_data: `ap:${token}:0` }]);
      return rows;
    };

    const registered = await this.registerInteraction({
      kind: "ap",
      session,
      chatId: telegramChatId,
      body,
      buttonsFor: buttons,
      timeoutMs: cfg.timeoutSeconds * 1000,
      ephemeral: true,
      onResolve: async (choice, actor) => {
        if (choice === null) {
          await api.cancel();
          return "⏰ _Timed out — cancelled_";
        }
        if (choice === 0) {
          await api.cancel();
          return `❌ _Cancelled by ${actor ?? "user"}_`;
        }
        const label = dialog.options[choice - 1] ?? `option ${choice}`;
        await api.selectOption(choice);
        return `✅ _Picked "${label}" by ${actor ?? "user"}_`;
      },
    });
    if (!registered) {
      console.warn(`[approval] failed to register for ${session.channelKey} — auto-cancelling`);
      await api.cancel();
    }
  }

  /**
   * Send a Telegram inline keyboard and remember the token so the operator's
   * tap routes back to `onResolve`. Returns true on success. Use `timeoutMs`
   * to auto-resolve with `choice = null` after a delay; omit it for prompts
   * that can sit indefinitely (model picks etc).
   */
  private async registerInteraction(opts: {
    kind: string;
    session: ChannelSession;
    chatId: number;
    body: string;
    buttonsFor: (token: string) => Array<Array<{ text: string; callback_data: string }>>;
    timeoutMs?: number;
    ephemeral?: boolean;
    onResolve: PendingInteraction["onResolve"];
  }): Promise<boolean> {
    if (!this.telegram) return false;
    const token = randomBytes(6).toString("hex");
    const buttons = opts.buttonsFor(token);
    const msgId = await this.telegram.sendInlineKeyboard(opts.chatId, opts.body, buttons);
    if (!msgId) return false;
    const interaction: PendingInteraction = {
      session: opts.session,
      platform: "telegram",
      chatId: opts.chatId,
      platformMsgId: msgId,
      bodyBase: opts.body,
      ephemeral: opts.ephemeral,
      onResolve: opts.onResolve,
    };
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      interaction.timer = setTimeout(() => {
        void this.resolveInteraction(token, null);
      }, opts.timeoutMs);
    }
    this.pendingInteractions.set(token, interaction);
    console.log(`[interaction] ${opts.kind} ${opts.session.channelKey} sent (token ${token})`);
    return true;
  }

  private async handleTelegramCallback(cb: TelegramCallbackInbound): Promise<void> {
    // Callback data shape: `<kind>:<token>:<choice>`. We don't actually
    // dispatch on `kind` here — onResolve closures own the logic — but the
    // prefix is kept human-readable for log debugging.
    const m = cb.data.match(/^[a-z]+:([a-f0-9]+):(-?\d+)$/);
    if (!m) {
      await this.telegram?.answerCallbackQuery(cb.callbackQueryId, "Unknown action");
      return;
    }
    const token = m[1];
    const choice = Number(m[2]);
    if (!this.pendingInteractions.has(token)) {
      await this.telegram?.answerCallbackQuery(cb.callbackQueryId, "Expired");
      return;
    }
    const outcome = await this.resolveInteraction(token, choice, cb.fromName);
    // Show the outcome as a transient toast (strip markdown). For ephemeral
    // interactions the message itself is deleted, so the toast is the only
    // feedback — keep it short.
    const toast = outcome ? outcome.replace(/[_*`]/g, "").slice(0, 190) : undefined;
    await this.telegram?.answerCallbackQuery(cb.callbackQueryId, toast);
  }

  private async resolveInteraction(
    token: string,
    choice: number | null,
    actor?: string,
  ): Promise<string | undefined> {
    const p = this.pendingInteractions.get(token);
    if (!p) return undefined;
    this.pendingInteractions.delete(token);
    if (p.timer) clearTimeout(p.timer);
    try {
      const outcome = await p.onResolve(choice, actor);
      if (p.ephemeral) {
        // Drop the resolved prompt so it doesn't clutter the chat.
        await this.telegram?.deleteMessage(p.chatId, p.platformMsgId);
      } else {
        await this.telegram?.editMessage(
          p.chatId,
          p.platformMsgId,
          `${outcome}\n\n${p.bodyBase}`,
        );
      }
      return outcome;
    } catch (err) {
      console.error(`[interaction] resolve ${token} failed:`, err);
      return undefined;
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
      p.items.push({ kind: "reasoning", content: cleaned });
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
      p.items.push({ kind: "tool", content: line });
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

  async shutdown(reason: string, exitCode = 0): Promise<void> {
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
    process.exit(exitCode);
  }
}

/**
 * What the agent is doing right now, distilled into one editable platform
 * message. Reasoning / tool calls / intermediate text are recorded in jsonl
 * fire order so the bubble reads chronologically (a turn that does
 * tool → text → tool stays readable as such).
 *
 * Consecutive tool calls coalesce on render into one block; if the run is
 * longer than TOOL_LINES_MAX, older calls fold into a "… N earlier tool
 * calls hidden" line. Only the latest tool's result is shown.
 */
type ProgressItemKind = "reasoning" | "text" | "tool";

interface ProgressItem {
  kind: ProgressItemKind;
  content: string;
}

interface ProgressContent {
  /** Events in the order they fired during the turn. */
  items: ProgressItem[];
  /** Result preview for the LAST tool call only; cleared on each new tool. */
  lastResult: string;
}

/**
 * Generic Telegram inline-keyboard interaction. Both approval dialogs and
 * `/model` button menus use the same shape — the differences are encoded in
 * the `kind` prefix (so the callback_data parser can route) and the
 * `onResolve` closure (which handles the kind-specific action).
 */
interface PendingInteraction {
  session: ChannelSession;
  platform: "telegram";
  chatId: number;
  platformMsgId: string;
  /** The body we initially posted, kept so we can prepend the outcome
   *  line during the final edit. */
  bodyBase: string;
  /**
   * Optional auto-cancel timer. Approvals set this so the agent (blocked
   * in tmux on a permission dialog) doesn't wait forever. Model picks
   * leave it undefined — the menu can sit indefinitely without harm.
   */
  timer?: ReturnType<typeof setTimeout>;
  /**
   * When true, DELETE the prompt message on resolution instead of editing it
   * to show the outcome. Used for approvals so resolved dialogs don't pile up
   * in the chat — the outcome is shown as a transient callback toast instead.
   */
  ephemeral?: boolean;
  /**
   * Invoked when the operator taps a button (or the optional timer fires
   * with `choice = null`). `choice` is 1..N for an option, 0 for an
   * explicit cancel button, or `null` for timeout. Returns the outcome
   * line (shown as a toast for ephemeral interactions, or prepended to the
   * edited message otherwise).
   */
  onResolve(choice: number | null, actor?: string): Promise<string>;
}

function numberedButtonLabel(n: number, text: string): string {
  // Telegram inline-keyboard buttons render best as a single line. Truncate
  // long option text so it fits on a button without wrapping.
  const max = 50;
  const truncated = text.length <= max ? text : text.slice(0, max - 1) + "…";
  return `${n}. ${truncated}`;
}

function formatApprovalPrompt(channelKey: string, dialog: PermissionDialog): string {
  let header: string;
  switch (dialog.kind) {
    case "model-switch":
      header = `🔁 _Switch model?_ · \`${channelKey}\``;
      break;
    case "survey":
      header = `📋 _How is Claude doing this session?_ · \`${channelKey}\``;
      break;
    case "permission":
    default:
      header = `🔐 _Permission needed_ · \`${channelKey}\``;
      break;
  }
  const lines: string[] = [header, ""];
  if (dialog.question) {
    lines.push("```");
    lines.push(dialog.question);
    lines.push("```");
  }
  return lines.join("\n");
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
  return { items: [], lastResult: "" };
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
  if (p.items.length === 0) return "";
  const blocks: string[] = [];
  let i = 0;
  while (i < p.items.length) {
    const item = p.items[i];
    if (item.kind === "tool") {
      // Coalesce consecutive tool items into one block, truncating older
      // calls if the run exceeds TOOL_LINES_MAX.
      const tools: string[] = [];
      while (i < p.items.length && p.items[i].kind === "tool") {
        tools.push(p.items[i].content);
        i++;
      }
      const hidden = Math.max(0, tools.length - TOOL_LINES_MAX);
      const visible = hidden > 0 ? tools.slice(-TOOL_LINES_MAX) : tools;
      const lines: string[] = [];
      if (hidden > 0) {
        lines.push(`… ${hidden} earlier tool call${hidden > 1 ? "s" : ""} hidden`);
      }
      lines.push(...visible);
      // lastResult attaches only to the FINAL tool block (any subsequent
      // tool item would have cleared it on dispatch anyway).
      const hasMoreToolsAhead = p.items.slice(i).some((x) => x.kind === "tool");
      if (!hasMoreToolsAhead && p.lastResult.trim()) {
        lines.push(`  ↳ ${p.lastResult.trim()}`);
      }
      blocks.push(lines.join("\n"));
      continue;
    }
    if (item.kind === "reasoning") {
      blocks.push(`💭 _Reasoning_\n${truncate(item.content, REASONING_MAX_CHARS)}`);
    } else {
      blocks.push(item.content);
    }
    i++;
  }
  return blocks.join("\n\n");
}

const TOOL_LINES_MAX = 5;

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

/**
 * Map a `/api/send` target to the session key that handles inbound traffic
 * from that chat/channel. The inbox echo lands there so the owning session
 * sees "you sent this earlier" on its next turn.
 *
 * Telegram DM chat ids are positive; group/supergroup ids are negative. We
 * branch on the sign so DM sends echo into `global` (where Telegram DMs
 * route) and group sends echo into the group's own per-chat channel.
 *
 * Discord/Slack/LINE have no reliable id-only DM signal, so the inbox echo
 * just goes to the same-shape key. For Discord/Slack DM channels this is
 * a known mismatch with the actual `global` routing — the caller would
 * need to use `global` as target if echoing to global matters.
 */
/**
 * Sibling of {@link inboxOwnerForTarget} that takes a structured ReplyTarget
 * instead of a target string. Used to decide whether a cross-channel reply
 * should also echo into the natural owner's inbox.
 */
function inboxOwnerForReplyTo(replyTo: ReplyTarget): string | null {
  if (!replyTo) return null;
  if (replyTo.platform === "telegram") {
    return inboxOwnerForTarget(`telegram:${replyTo.chatId}`);
  }
  if (replyTo.platform === "discord") {
    return inboxOwnerForTarget(`discord:${replyTo.channelId}`);
  }
  if (replyTo.platform === "slack") {
    return inboxOwnerForTarget(`slack:${replyTo.channelId}`);
  }
  if (replyTo.platform === "line") {
    return inboxOwnerForTarget(`line:${replyTo.to}`);
  }
  return null;
}

function inboxOwnerForTarget(target: string): string | null {
  if (target === GLOBAL_KEY) return null;
  if (target.startsWith("telegram:")) {
    const chatId = Number(target.slice("telegram:".length));
    if (!Number.isFinite(chatId)) return null;
    return chatId > 0 ? GLOBAL_KEY : target;
  }
  if (target.startsWith("slack:")) {
    // Drop the threadTs suffix — the inbox is per-channel, not per-thread.
    const rest = target.slice("slack:".length);
    const colon = rest.indexOf(":");
    return `slack:${colon < 0 ? rest : rest.slice(0, colon)}`;
  }
  if (target.startsWith("discord:") || target.startsWith("line:")) {
    return target;
  }
  return null;
}

function parseReplyToFromString(target: string): ReplyTarget {
  if (target.startsWith("telegram:")) {
    const chatId = Number(target.slice("telegram:".length));
    if (Number.isFinite(chatId)) return { platform: "telegram", chatId };
  }
  if (target.startsWith("discord:")) {
    return { platform: "discord", channelId: target.slice("discord:".length) };
  }
  if (target.startsWith("slack:")) {
    const rest = target.slice("slack:".length);
    const colon = rest.indexOf(":");
    return colon < 0
      ? { platform: "slack", channelId: rest }
      : { platform: "slack", channelId: rest.slice(0, colon), threadTs: rest.slice(colon + 1) };
  }
  if (target.startsWith("line:")) {
    return { platform: "line", to: target.slice("line:".length) };
  }
  return null;
}

function deriveKindFromKey(
  key: string,
): { kind: "global" | "telegram" | "discord" | "slack" | "line"; multiparty: boolean } | null {
  if (key === GLOBAL_KEY) return { kind: "global", multiparty: false };
  if (key.startsWith("telegram:")) return { kind: "telegram", multiparty: true };
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
