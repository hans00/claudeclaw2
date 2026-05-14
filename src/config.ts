/**
 * Settings loader. Reads `.claude/claudeclaw/settings.json` (relative to
 * cwd) and supplies defaults for missing fields. Settings define WHAT IS
 * ALLOWED (tokens, allowlists, security level) — runtime state lives in
 * sessions.json instead.
 */
import { readFile } from "fs/promises";
import { join } from "path";
import type { SecurityConfig } from "./compose";

export interface TelegramConfig {
  token: string;
  allowedUserIds: number[];
}

export interface DiscordChannelConfig {
  enabled: boolean;
  requireMention: boolean;
  ignoreOtherMentions: boolean;
}

export interface DiscordConfig {
  token: string;
  allowedUserIds: string[];
  allowedBotIds: string[];
  channels: Record<string, DiscordChannelConfig>;
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
}

export interface WebConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface Settings {
  telegram: TelegramConfig;
  discord: DiscordConfig;
  slack: SlackConfig;
  web: WebConfig;
  security: SecurityConfig;
  /** Polling interval for Telegram long-poll, in seconds. Default 25. */
  telegramPollSeconds: number;
}

const SETTINGS_PATH = join(".claude", "claudeclaw", "settings.json");

const DEFAULTS: Settings = {
  telegram: { token: "", allowedUserIds: [] },
  discord: { token: "", allowedUserIds: [], allowedBotIds: [], channels: {} },
  slack: { appToken: "", botToken: "", allowedUserIds: [], allowedBotIds: [] },
  web: { enabled: false, host: "127.0.0.1", port: 4632 },
  security: { level: "moderate", allowedTools: [], disallowedTools: [] },
  telegramPollSeconds: 25,
};

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
    },
    discord: {
      token: raw?.discord?.token ?? DEFAULTS.discord.token,
      allowedUserIds: Array.isArray(raw?.discord?.allowedUserIds)
        ? raw.discord.allowedUserIds.filter((x: unknown) => typeof x === "string")
        : DEFAULTS.discord.allowedUserIds,
      allowedBotIds: Array.isArray(raw?.discord?.allowedBotIds)
        ? raw.discord.allowedBotIds.filter((x: unknown) => typeof x === "string")
        : DEFAULTS.discord.allowedBotIds,
      channels: raw?.discord?.channels ?? DEFAULTS.discord.channels,
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
    },
    web: {
      enabled: typeof raw?.web?.enabled === "boolean" ? raw.web.enabled : DEFAULTS.web.enabled,
      host: typeof raw?.web?.host === "string" ? raw.web.host : DEFAULTS.web.host,
      port: typeof raw?.web?.port === "number" ? raw.web.port : DEFAULTS.web.port,
    },
    security: {
      level: raw?.security?.level ?? DEFAULTS.security.level,
      allowedTools: Array.isArray(raw?.security?.allowedTools) ? raw.security.allowedTools : [],
      disallowedTools: Array.isArray(raw?.security?.disallowedTools)
        ? raw.security.disallowedTools
        : [],
    },
    telegramPollSeconds: typeof raw?.telegramPollSeconds === "number"
      ? raw.telegramPollSeconds
      : DEFAULTS.telegramPollSeconds,
  };
}
