/**
 * Settings loader. Reads `.claude/claudeclaw/settings.json` (relative to
 * cwd) and supplies defaults for missing fields. Settings define WHAT IS
 * ALLOWED (tokens, allowlists, security level) — runtime state lives in
 * sessions.json instead.
 */
import { readFile } from "fs/promises";
import { join } from "path";
import type { SecurityConfig } from "./compose";

/**
 * How to surface in-progress reasoning / tool calls during a turn vs. the
 * final answer at end_turn.
 *
 *   "replace" — show previews during the turn, delete them at end_turn so
 *               only the final bubble remains
 *   "keep"    — leave previews visible after end_turn
 *   "off"     — no previews at all; only the final text is sent
 *
 * Built-in defaults per platform: telegram=replace, discord=off (busy rooms
 * default), slack=replace, line=replace.
 */
export type MessageStreamMode = "replace" | "keep" | "off";

export interface MessageStreamConfig {
  mode: MessageStreamMode;
}

export interface TelegramConfig {
  token: string;
  allowedUserIds: number[];
  /** Default messageStream mode for Telegram. Built-in default: "replace". */
  messageStream?: MessageStreamConfig;
}

export interface DiscordChannelConfig {
  enabled: boolean;
  requireMention: boolean;
  ignoreOtherMentions: boolean;
  /** Per-channel override; takes precedence over discord.messageStream. */
  messageStream?: MessageStreamConfig;
}

export interface DiscordConfig {
  token: string;
  allowedUserIds: string[];
  allowedBotIds: string[];
  channels: Record<string, DiscordChannelConfig>;
  /** Default messageStream mode for Discord. Built-in default: "off" so the
   *  bot doesn't flood busy public channels with tool-call previews. */
  messageStream?: MessageStreamConfig;
}

export interface LineConfig {
  channelAccessToken: string;
  channelSecret: string;
  /** Path on the webhook server. Default "/line/webhook". */
  webhookPath: string;
  /** Port the LINE webhook server binds to. Set to 0 to disable. */
  webhookPort: number;
  /** Allowed user ids (Slack `U...`-style strings). Empty = allow all. */
  allowedUserIds: string[];
  allowedGroupIds: string[];
  /** Default messageStream mode for LINE. Note: LINE has no edit/delete
   *  endpoint, so "replace" effectively behaves like "keep" anyway. */
  messageStream?: MessageStreamConfig;
}

/**
 * How a Slack channel maps to ClaudeClaw sessions.
 *
 *   "channel"             — one session per channel; thread replies collapse
 *                           into the channel session (Discord-style; default)
 *   "thread-per-message"  — every top-level channel message starts its own
 *                           session; thread replies join the parent's session.
 *                           Suited for office workflows where each thread is
 *                           a self-contained task. Pair with a short
 *                           sessionCleanup.idleTimeoutHours so finished
 *                           threads don't keep tmux alive.
 */
export type SlackChannelMode = "channel" | "thread-per-message";

export interface SlackChannelConfig {
  /** Per-channel override of slack.defaultMode. */
  mode?: SlackChannelMode;
  /** Per-channel override of slack.messageStream. */
  messageStream?: MessageStreamConfig;
}

export interface SlackConfig {
  /** xapp-... token for Socket Mode. */
  appToken: string;
  /** xoxb-... bot token for Web API (chat.postMessage etc). */
  botToken: string;
  /** Allowed human user ids (Slack U... ids). Empty array = allow all. */
  allowedUserIds: string[];
  /** Allowed bot ids (Slack B... ids). */
  allowedBotIds: string[];
  /** Default channel mode for channels without explicit config. Default "channel". */
  defaultMode: SlackChannelMode;
  /** Per-channel overrides keyed by Slack channel id. */
  channels: Record<string, SlackChannelConfig>;
  /** Default messageStream mode for Slack. Built-in default: "replace". */
  messageStream?: MessageStreamConfig;
}

export interface WebConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface ApprovalConfig {
  /** Master switch — when off, permission dialogs in tmux just hang. */
  enabled: boolean;
  /** How long to wait for an operator response before auto-denying
   *  (sending Esc to the tmux dialog). */
  timeoutSeconds: number;
  /** Default duration (minutes) of the temporary auto-approve window opened
   *  by the dialog's Yolo button and by `/autoapprove` with no argument. */
  yoloMinutes: number;
  /**
   * Handling for Claude Code's periodic "How is Claude doing this session?"
   * feedback survey. The survey blocks the pane and produces no jsonl, so
   * it has to be either auto-dismissed or surfaced to the operator.
   *
   *   "dismiss" — press 0 to dismiss the survey immediately (default)
   *   "ask"     — forward as inline keyboard like a permission dialog
   */
  survey: "dismiss" | "ask";
}

export interface SessionCleanupConfig {
  /** Channel sessions idle longer than this get their tmux + agent torn
   *  down. The sessions.json entry stays, so the next inbound restores
   *  the conversation via `claude --resume`. 0 disables cleanup. */
  idleTimeoutHours: number;
  /** How often the cleanup scanner runs. */
  checkIntervalMinutes: number;
}

export interface HeartbeatWindow {
  start: string; // "HH:MM"
  end: string;   // "HH:MM"; if end < start the window wraps midnight
}

export interface HeartbeatConfig {
  enabled: boolean;
  /** Minutes between fires. */
  interval: number;
  prompt: string;
  excludeWindows: HeartbeatWindow[];
}

export interface AgenticMode {
  name: string;
  model: string;
  keywords: string[];
  phrases?: string[];
}

/**
 * Hysteresis gates that suppress model flip-flopping between turns. Each
 * gate is bypassed when the router's confidence is at phrase-match level
 * (≥ 0.95) — explicit user intent always wins. Otherwise switching from
 * the current model requires ALL of:
 *
 *   - classification confidence ≥ confidenceThreshold
 *   - new mode's keyword score is ≥ scoreMargin ABOVE the current mode's
 *   - time since last switch ≥ stickyWindowMinutes
 *   - user turns since last switch ≥ stickyWindowTurns
 *
 * Defaults pick reasonable values for the typical heartbeat-every-N-min
 * + occasional-planning-prompt pattern: keep the cache warm unless the
 * user has clearly steered toward a different mode.
 */
export interface AgenticHysteresis {
  confidenceThreshold: number;
  scoreMargin: number;
  stickyWindowMinutes: number;
  stickyWindowTurns: number;
}

export interface AgenticConfig {
  enabled: boolean;
  defaultMode: string;
  modes: AgenticMode[];
  hysteresis: AgenticHysteresis;
}

/**
 * How the channel handles new inbound messages while the agent is mid-turn.
 *
 *   "queue"     — queue + auto-merge: hold messages, then coalesce them into
 *                 one bundled prompt after the turn ends (default)
 *   "interrupt" — immediately send ESC, then deliver queued messages once
 *                 the turn settles
 */
export type QueueMode = "queue" | "interrupt";
export type QueueDropPolicy = "old" | "new" | "summarize";

export interface QueueConfig {
  mode: QueueMode;
  /** Wait this long after the last enqueued message before draining. Gives
   *  rapid-fire messages a chance to coalesce before they hit the agent.
   *  Default 1500 ms. */
  debounceMs: number;
  /** Maximum number of messages to hold in the queue. Default 20. */
  cap: number;
  /** What to drop when cap is hit. "summarize" preserves a one-line summary
   *  of each dropped message. Default "summarize". */
  dropPolicy: QueueDropPolicy;
}

export interface Settings {
  telegram: TelegramConfig;
  discord: DiscordConfig;
  slack: SlackConfig;
  line: LineConfig;
  web: WebConfig;
  approval: ApprovalConfig;
  sessionCleanup: SessionCleanupConfig;
  heartbeat: HeartbeatConfig;
  security: SecurityConfig;
  /** Default model (alias like "opus"/"sonnet" or full id). Empty = let Claude Code pick. */
  model: string;
  /** Per-turn model routing. When enabled, classifyTask picks a mode + model based on the user prompt. */
  agentic: AgenticConfig;
  /** Polling interval for Telegram long-poll, in seconds. Default 25. */
  telegramPollSeconds: number;
  /** Timezone for heartbeat exclude windows + cron with no override. e.g. "UTC+8". */
  timezone: string;
  /** Busy-channel queue behaviour. */
  queue: QueueConfig;
}

const SETTINGS_PATH = join(".claude", "claudeclaw", "settings.json");

const DEFAULTS: Settings = {
  telegram: { token: "", allowedUserIds: [] },
  discord: { token: "", allowedUserIds: [], allowedBotIds: [], channels: {} },
  slack: {
    appToken: "",
    botToken: "",
    allowedUserIds: [],
    allowedBotIds: [],
    defaultMode: "channel",
    channels: {},
  },
  line: {
    channelAccessToken: "",
    channelSecret: "",
    webhookPath: "/line/webhook",
    webhookPort: 0,
    allowedUserIds: [],
    allowedGroupIds: [],
  },
  web: { enabled: false, host: "127.0.0.1", port: 4632 },
  approval: { enabled: true, timeoutSeconds: 300, survey: "dismiss", yoloMinutes: 30 },
  sessionCleanup: { idleTimeoutHours: 168, checkIntervalMinutes: 30 },
  heartbeat: { enabled: false, interval: 60, prompt: "", excludeWindows: [] },
  security: { level: "moderate", allowedTools: [], disallowedTools: [], skipPermissions: false },
  model: "",
  agentic: {
    enabled: false,
    defaultMode: "",
    modes: [],
    hysteresis: {
      confidenceThreshold: 0.75,
      scoreMargin: 2,
      stickyWindowMinutes: 30,
      stickyWindowTurns: 5,
    },
  },
  telegramPollSeconds: 25,
  timezone: "",
  queue: { mode: "queue", debounceMs: 1500, cap: 20, dropPolicy: "summarize" },
};

function parseStreamCfg(raw: any): MessageStreamConfig | undefined {
  const m = raw?.mode;
  if (m === "replace" || m === "keep" || m === "off") return { mode: m };
  return undefined;
}

export async function loadSettings(): Promise<Settings> {
  let raw: any;
  try {
    raw = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      console.warn(`[config] no settings file at ${SETTINGS_PATH}; using defaults`);
      return structuredClone(DEFAULTS);
    }
    throw err;
  }
  return {
    telegram: {
      token: raw?.telegram?.token ?? DEFAULTS.telegram.token,
      allowedUserIds: Array.isArray(raw?.telegram?.allowedUserIds)
        ? raw.telegram.allowedUserIds.filter((x: unknown) => typeof x === "number")
        : DEFAULTS.telegram.allowedUserIds,
      messageStream: parseStreamCfg(raw?.telegram?.messageStream),
    },
    discord: {
      token: raw?.discord?.token ?? DEFAULTS.discord.token,
      allowedUserIds: Array.isArray(raw?.discord?.allowedUserIds)
        ? raw.discord.allowedUserIds.filter((x: unknown) => typeof x === "string")
        : DEFAULTS.discord.allowedUserIds,
      allowedBotIds: Array.isArray(raw?.discord?.allowedBotIds)
        ? raw.discord.allowedBotIds.filter((x: unknown) => typeof x === "string")
        : DEFAULTS.discord.allowedBotIds,
      channels: (() => {
        const out: Record<string, DiscordChannelConfig> = {};
        const src = raw?.discord?.channels;
        if (src && typeof src === "object") {
          for (const [id, cfg] of Object.entries(src)) {
            if (!cfg || typeof cfg !== "object") continue;
            const c = cfg as any;
            out[id] = {
              enabled: !!c.enabled,
              requireMention: !!c.requireMention,
              ignoreOtherMentions: !!c.ignoreOtherMentions,
              messageStream: parseStreamCfg(c.messageStream),
            };
          }
        }
        return out;
      })(),
      messageStream: parseStreamCfg(raw?.discord?.messageStream),
    },
    slack: {
      appToken: raw?.slack?.appToken ?? DEFAULTS.slack.appToken,
      botToken: raw?.slack?.botToken ?? DEFAULTS.slack.botToken,
      allowedUserIds: Array.isArray(raw?.slack?.allowedUserIds)
        ? raw.slack.allowedUserIds.filter((x: unknown) => typeof x === "string")
        : DEFAULTS.slack.allowedUserIds,
      allowedBotIds: Array.isArray(raw?.slack?.allowedBotIds)
        ? raw.slack.allowedBotIds.filter((x: unknown) => typeof x === "string")
        : DEFAULTS.slack.allowedBotIds,
      defaultMode:
        raw?.slack?.defaultMode === "thread-per-message" ? "thread-per-message" : "channel",
      channels: (() => {
        const out: Record<string, SlackChannelConfig> = {};
        const src = raw?.slack?.channels;
        if (src && typeof src === "object") {
          for (const [id, cfg] of Object.entries(src)) {
            if (!cfg || typeof cfg !== "object") continue;
            const c = cfg as any;
            const mode: SlackChannelMode | undefined =
              c.mode === "thread-per-message" || c.mode === "channel" ? c.mode : undefined;
            out[id] = {
              mode,
              messageStream: parseStreamCfg(c.messageStream),
            };
          }
        }
        return out;
      })(),
      messageStream: parseStreamCfg(raw?.slack?.messageStream),
    },
    line: {
      channelAccessToken: raw?.line?.channelAccessToken ?? DEFAULTS.line.channelAccessToken,
      channelSecret: raw?.line?.channelSecret ?? DEFAULTS.line.channelSecret,
      webhookPath: typeof raw?.line?.webhookPath === "string"
        ? raw.line.webhookPath
        : DEFAULTS.line.webhookPath,
      webhookPort: typeof raw?.line?.webhookPort === "number"
        ? raw.line.webhookPort
        : DEFAULTS.line.webhookPort,
      allowedUserIds: Array.isArray(raw?.line?.allowedUserIds)
        ? raw.line.allowedUserIds.filter((x: unknown) => typeof x === "string")
        : DEFAULTS.line.allowedUserIds,
      allowedGroupIds: Array.isArray(raw?.line?.allowedGroupIds)
        ? raw.line.allowedGroupIds.filter((x: unknown) => typeof x === "string")
        : DEFAULTS.line.allowedGroupIds,
      messageStream: parseStreamCfg(raw?.line?.messageStream),
    },
    web: {
      enabled: typeof raw?.web?.enabled === "boolean" ? raw.web.enabled : DEFAULTS.web.enabled,
      host: typeof raw?.web?.host === "string" ? raw.web.host : DEFAULTS.web.host,
      port: typeof raw?.web?.port === "number" ? raw.web.port : DEFAULTS.web.port,
    },
    sessionCleanup: {
      idleTimeoutHours: typeof raw?.sessionCleanup?.idleTimeoutHours === "number"
        ? raw.sessionCleanup.idleTimeoutHours
        : DEFAULTS.sessionCleanup.idleTimeoutHours,
      checkIntervalMinutes: typeof raw?.sessionCleanup?.checkIntervalMinutes === "number"
        ? raw.sessionCleanup.checkIntervalMinutes
        : DEFAULTS.sessionCleanup.checkIntervalMinutes,
    },
    approval: {
      enabled: typeof raw?.approval?.enabled === "boolean"
        ? raw.approval.enabled
        : DEFAULTS.approval.enabled,
      timeoutSeconds: typeof raw?.approval?.timeoutSeconds === "number"
        ? raw.approval.timeoutSeconds
        : DEFAULTS.approval.timeoutSeconds,
      survey: raw?.approval?.survey === "ask" ? "ask" : DEFAULTS.approval.survey,
      yoloMinutes: typeof raw?.approval?.yoloMinutes === "number"
        ? raw.approval.yoloMinutes
        : DEFAULTS.approval.yoloMinutes,
    },
    security: {
      level: raw?.security?.level ?? DEFAULTS.security.level,
      allowedTools: Array.isArray(raw?.security?.allowedTools) ? raw.security.allowedTools : [],
      disallowedTools: Array.isArray(raw?.security?.disallowedTools)
        ? raw.security.disallowedTools
        : [],
      skipPermissions: raw?.security?.skipPermissions === true,
    },
    heartbeat: {
      enabled: typeof raw?.heartbeat?.enabled === "boolean"
        ? raw.heartbeat.enabled
        : DEFAULTS.heartbeat.enabled,
      interval: typeof raw?.heartbeat?.interval === "number"
        ? raw.heartbeat.interval
        : DEFAULTS.heartbeat.interval,
      prompt: typeof raw?.heartbeat?.prompt === "string"
        ? raw.heartbeat.prompt
        : DEFAULTS.heartbeat.prompt,
      excludeWindows: Array.isArray(raw?.heartbeat?.excludeWindows)
        ? raw.heartbeat.excludeWindows.filter(
            (w: any) => w && typeof w.start === "string" && typeof w.end === "string",
          )
        : DEFAULTS.heartbeat.excludeWindows,
    },
    model: typeof raw?.model === "string" ? raw.model : DEFAULTS.model,
    agentic: {
      enabled: typeof raw?.agentic?.enabled === "boolean"
        ? raw.agentic.enabled
        : DEFAULTS.agentic.enabled,
      defaultMode: typeof raw?.agentic?.defaultMode === "string"
        ? raw.agentic.defaultMode
        : DEFAULTS.agentic.defaultMode,
      modes: Array.isArray(raw?.agentic?.modes)
        ? raw.agentic.modes
            .filter((m: any) => m && typeof m.name === "string" && typeof m.model === "string")
            .map((m: any) => ({
              name: m.name,
              model: m.model,
              keywords: Array.isArray(m.keywords) ? m.keywords.filter((k: any) => typeof k === "string") : [],
              phrases: Array.isArray(m.phrases) ? m.phrases.filter((p: any) => typeof p === "string") : undefined,
            }))
        : DEFAULTS.agentic.modes,
      hysteresis: {
        confidenceThreshold: typeof raw?.agentic?.hysteresis?.confidenceThreshold === "number"
          ? raw.agentic.hysteresis.confidenceThreshold
          : DEFAULTS.agentic.hysteresis.confidenceThreshold,
        scoreMargin: typeof raw?.agentic?.hysteresis?.scoreMargin === "number"
          ? raw.agentic.hysteresis.scoreMargin
          : DEFAULTS.agentic.hysteresis.scoreMargin,
        stickyWindowMinutes: typeof raw?.agentic?.hysteresis?.stickyWindowMinutes === "number"
          ? raw.agentic.hysteresis.stickyWindowMinutes
          : DEFAULTS.agentic.hysteresis.stickyWindowMinutes,
        stickyWindowTurns: typeof raw?.agentic?.hysteresis?.stickyWindowTurns === "number"
          ? raw.agentic.hysteresis.stickyWindowTurns
          : DEFAULTS.agentic.hysteresis.stickyWindowTurns,
      },
    },
    telegramPollSeconds: typeof raw?.telegramPollSeconds === "number"
      ? raw.telegramPollSeconds
      : DEFAULTS.telegramPollSeconds,
    timezone: typeof raw?.timezone === "string" ? raw.timezone : DEFAULTS.timezone,
    queue: (() => {
      const q = raw?.queue;
      const mode: QueueMode =
        q?.mode === "interrupt" ? "interrupt" : DEFAULTS.queue.mode;
      const debounceMs =
        typeof q?.debounceMs === "number" && q.debounceMs >= 0
          ? q.debounceMs
          : DEFAULTS.queue.debounceMs;
      const cap =
        typeof q?.cap === "number" && q.cap > 0
          ? Math.floor(q.cap)
          : DEFAULTS.queue.cap;
      const dropPolicy: QueueDropPolicy =
        q?.dropPolicy === "old" || q?.dropPolicy === "new" || q?.dropPolicy === "summarize"
          ? q.dropPolicy
          : DEFAULTS.queue.dropPolicy;
      return { mode, debounceMs, cap, dropPolicy };
    })(),
  };
}
